/**
 * `countFilesUnder` — pre-stage file-count guard for `createSnapshot`.
 *
 * Walk the workdir with the same filesystem-snapshot semantics used for
 * staging. This keeps the too-many-files guard aligned with the actual
 * checkpoint tree, including nested `.git` handling and user `.gitignore`
 * rules.
 */

import { collectCheckpointFiles } from './snapshotIndex.js'

/**
 * Result of `countFilesUnder`.
 *
 * `count` is the actual count when below the cap; when `aborted: true`
 * it's the cap+1 (we stop the walk the moment we cross it). Callers
 * check `aborted` first — `count` is informational only when aborted.
 */
export interface CountFilesResult {
  count: number
  aborted: boolean
}

export interface CountFilesOptions {
  /** Hard cap. Walk aborts once `count > max`. */
  max: number
  /** Absolute shadow store path, required so git check-ignore can run. */
  store: string
  /** Per-project index file. Used only for git command isolation. */
  indexFile?: string
}

/**
 * Walk `root` and return the number of files visible to checkpoint
 * staging, stopping early once we exceed `opts.max`.
 *
 * Caller responsibility: pass an absolute, canonical `root`. We do not
 * normalize here — Phase 2's `createSnapshot` boundary already canonicalizes.
 */
export async function countFilesUnder(
  root: string,
  opts: CountFilesOptions,
): Promise<CountFilesResult> {
  const collected = await collectCheckpointFiles({
    store: opts.store,
    workTree: root,
    indexFile: opts.indexFile,
    maxFiles: opts.max,
  })
  if (collected.ok === false) {
    // File-count is a guard only. If it cannot run, let snapshot staging
    // attempt the same walk and surface a typed transient failure there.
    return { count: 0, aborted: false }
  }
  const count = collected.paths.length
  return { count, aborted: count > opts.max }
}
