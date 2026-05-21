/**
 * `dropOversizeFromIndex` — remove staged files larger than the cap from
 * the per-project index, after `git add -A` but before `git write-tree`.
 *
 * Direct port of Hermes `_drop_oversize_from_index` (`tools/checkpoint_manager.py::CheckpointManager._drop_oversize_from_index`).
 * The point: let the agent keep snapshotting source code while refusing
 * to swallow generated assets — datasets, model weights, logs, video
 * captures, profile dumps. These would balloon the shadow store and
 * provide zero rewind value.
 *
 * Why post-stage rather than pre-stage:
 *   - We already pay the `git add -A` cost; the index now has authoritative
 *     entries for everything. Walking those is cheaper and more accurate
 *     than re-walking the workdir with separate ignore matching.
 *   - `git ls-files --cached -z` gives us the exact set git would commit,
 *     which already accounts for `info/exclude`, `.gitignore`, attributes.
 *   - Stat is racy in either approach; doing it after stage means we
 *     don't double-stat any file we already accepted.
 *
 * Batching: chunk into groups of 200 paths for the `git rm --cached`
 * calls so we never blow the OS argv length on extreme cases (Windows
 * has a ~32k cmdline limit, and someone WILL eventually create a
 * generated-asset directory with thousands of >10MB files).
 */

import { stat } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { runCheckpointGit } from './git.js'

const RM_CACHED_BATCH = 200

export interface DropOversizeOptions {
  /** Absolute, canonical path to the bare-ish shadow store. */
  store: string
  /** Canonical workTree (caller already normalized). */
  workTree: string
  /** Per-project index file. Required — this op operates on the index. */
  indexFile: string
  /**
   * Per-file size cap in megabytes. `<= 0` short-circuits the whole op
   * (parity with Hermes 982-984 — the "disable cap" escape hatch is
   * just setting it to zero).
   */
  maxFileSizeMb: number
}

/**
 * Walk the index, drop entries whose blob source exceeds the cap.
 * Never throws — checkpoints subsystem must not block tool execution.
 *
 * Returns the number of files dropped. The Phase 2 createSnapshot
 * pipeline doesn't act on this number, but Phase 5 `/checkpoints status`
 * may want to surface "N oversize files skipped this turn".
 */
export async function dropOversizeFromIndex(
  opts: DropOversizeOptions,
): Promise<number> {
  const cap = opts.maxFileSizeMb * 1024 * 1024
  if (cap <= 0) return 0

  // -z gives NUL-separated paths so filenames containing newlines
  // (rare but legal on POSIX) round-trip cleanly. Hermes 986.
  const lsResult = await runCheckpointGit(['ls-files', '--cached', '-z'], {
    store: opts.store,
    workTree: opts.workTree,
    indexFile: opts.indexFile,
  })
  if (lsResult.ok === false || lsResult.stdout.length === 0) {
    return 0
  }

  // Hermes 991-993 note: _run_git strips trailing whitespace, leaving
  // NULs alone. execFileNoThrow does the same — we split on NUL and
  // drop the trailing empty.
  const paths = lsResult.stdout.split('\0').filter(p => p.length > 0)

  const oversize: string[] = []
  for (const rel of paths) {
    try {
      const st = await stat(join(opts.workTree, rel))
      if (st.size > cap) oversize.push(rel)
    } catch {
      // File vanished between ls-files and stat (AV scan, live edit) —
      // git itself will deal with it at write-tree time. Match Hermes 999.
      continue
    }
  }

  if (oversize.length === 0) return 0

  logForDebugging(
    `Checkpoint: dropping ${oversize.length} oversize file(s) (>${opts.maxFileSizeMb}MB) from index`,
  )

  // Hermes 1011-1018: chunk to avoid argv blowup. allowedExitCodes={128}
  // because `git rm --cached` returns 128 if any path was removed
  // concurrently or never existed in the index — we don't care.
  const allowed = new Set([128])
  for (let i = 0; i < oversize.length; i += RM_CACHED_BATCH) {
    const chunk = oversize.slice(i, i + RM_CACHED_BATCH)
    await runCheckpointGit(['rm', '--cached', '--quiet', '--', ...chunk], {
      store: opts.store,
      workTree: opts.workTree,
      indexFile: opts.indexFile,
      allowedExitCodes: allowed,
    })
  }

  return oversize.length
}
