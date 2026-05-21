/**
 * `touchProject` — write/update `projects/<hash16>.json` for orphan
 * tracking and prune passes.
 *
 * Direct port of Hermes `_touch_project`
 * (`tools/checkpoint_manager.py::_touch_project`).
 *
 * **Why this runs BEFORE the file-count guard in `createSnapshot`**:
 * even if a snapshot is skipped (workdir too broad, too many files,
 * no changes, transient error), we still want the project registered
 * so:
 *   - Phase 4 orphan pass can detect that the workdir vanished
 *   - `last_touch` reflects "user is actively working here", which
 *     drives the stale-prune cutoff
 *   - `created_at` is preserved across touches (it's the project's
 *     first-seen timestamp, never overwritten)
 *
 * Hermes' contract (line 849 vs 852 in `_take`): `_touch_project` is
 * called BEFORE `_dir_file_count` so even oversized monorepos register.
 * We honor that ordering — the spec calls it out as step 4 of the 13.
 *
 * Type guard: if `<hash16>.json` is corrupt or contains a non-object
 * value (somebody wrote `null`, an array, a JSON number — see Hermes
 * test `test_non_dict_meta_does_not_raise`), we treat it as missing
 * and rewrite. Better than throwing on a bug class we've already seen
 * in production.
 *
 * **No fsync, no temp+rename**: we accept the corruption risk on power
 * loss. Hermes does the same (line 491 — direct `write_text`). The
 * worst case is one project's metadata becomes garbage; the type guard
 * above handles re-init on the next touch.
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from '../debug.js'
import { normalizePath, projectHash, projectMetaPath } from './paths.js'

/**
 * Stored shape — mirrors Hermes:
 *   - `workdir`: canonical absolute path (re-normalized on every touch
 *     in case the caller passed something noisy)
 *   - `created_at`: epoch seconds, preserved across touches
 *   - `last_touch`: epoch seconds, updated every call
 *
 * Epoch SECONDS (not milliseconds) for parity with Hermes. Phase 4 prune
 * compares against `Date.now() / 1000`; numeric type only — no Date
 * objects in the JSON.
 */
export interface ProjectMeta {
  workdir: string
  created_at: number
  last_touch: number
}

/**
 * Write/update the project metadata file. Returns the hash16 used for
 * the path, so callers don't have to recompute it.
 *
 * Never throws — failures are logged at debug level and swallowed
 * (matches Hermes line 492-493). The fail-open contract is the same as
 * `createSnapshot`: any non-fatal IO error in the checkpoints layer
 * must not block the agent.
 */
export async function touchProject(workdir: string): Promise<string> {
  const canonical = normalizePath(workdir)
  const hash = projectHash(canonical)
  const metaPath = projectMetaPath(hash)
  const nowSec = Date.now() / 1000

  let meta: ProjectMeta = {
    workdir: canonical,
    created_at: nowSec,
    last_touch: nowSec,
  }

  // Read existing — type-guard non-object payloads, swallow read errors.
  try {
    const raw = await readFile(metaPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const existing = parsed as Partial<ProjectMeta>
      if (typeof existing.created_at === 'number') {
        meta.created_at = existing.created_at
      }
      // last_touch and workdir always get rewritten — those are the
      // whole point of `touch`.
    }
    // Else (null, array, number, malformed JSON) → treat as missing,
    // keep the freshly-built default.
  } catch {
    // ENOENT or unreadable — fine, we'll create it below.
  }

  try {
    await mkdir(dirname(metaPath), { recursive: true })
    await writeFile(metaPath, JSON.stringify(meta), 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logForDebugging(`touchProject: write failed for ${metaPath}: ${msg}`)
    // Swallow — checkpoints subsystem never blocks the agent.
  }

  return hash
}
