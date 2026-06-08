/**
 * `clearAll` — nuke the entire `~/.axiomate/checkpoints/` directory.
 *
 * Backs `/checkpoints clear` and `axiomate checkpoints clear`. The
 * caller is expected to have shown a confirmation prompt before calling
 * this; `clearAll` itself does not prompt. Irreversible.
 *
 * Adapted from Hermes `clear_all` (`tools/checkpoint_manager.py::clear_all`).
 * Divergence from Hermes: it returns the same `{bytes_freed,
 * deleted}` shape. axiomate also reports `errors` so the UI can show
 * the reason if `rm` partially fails on Windows (AV scanner, locked
 * file). Hermes silently swallows `OSError` and reports `deleted: false`
 * with no detail.
 *
 * Best-effort. Any error message is captured, never thrown — the
 * checkpoints subsystem must never crash the agent.
 */

import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { logForDebugging } from '../debug.js'
import { getCheckpointBase } from './paths.js'
import { dirSizeBytes } from './prune.js'
import { cleanupRewindTempDirs } from './rewindTempCleanup.js'

export interface ClearAllReport {
  /**
   * Bytes of disk reclaimed. Measured *before* the delete, so this
   * reflects what was on disk at the moment of the call. If `deleted`
   * is false the value is still the pre-delete size — useful for the
   * UI to say "tried to free 47 MB but couldn't".
   */
  bytes_freed: number
  /** True iff the base directory was successfully removed. */
  deleted: boolean
  /** Captured error messages. Empty when `deleted` is true. */
  errors: string[]
  /** Rewind transaction temp dirs removed from os.tmpdir(). */
  rewind_temp_dirs_removed: number
  rewind_temp_bytes_freed: number
}

/**
 * Remove `~/.axiomate/checkpoints/` and everything underneath it.
 *
 * Subsequent snapshot writes will re-create the store from scratch
 * via `ensureStore`. There is no module-level cache to invalidate —
 * `ensureStore` is idempotent on filesystem state, and the shared
 * git-availability cache (`git.ts:_gitAvailableCache`) tracks whether
 * `git --version` works, which is unaffected by deleting the store.
 */
export async function clearAll(): Promise<ClearAllReport> {
  const base = getCheckpointBase()
  const report: ClearAllReport = {
    bytes_freed: 0,
    deleted: false,
    errors: [],
    rewind_temp_dirs_removed: 0,
    rewind_temp_bytes_freed: 0,
  }
  if (existsSync(base)) {
    // Measure first — Hermes `clear_all`::1609. After `rm` we have nothing to count.
    report.bytes_freed = dirSizeBytes(base)

    try {
      await rm(base, { recursive: true, force: true })
      report.deleted = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      report.errors.push(msg)
      logForDebugging(`clearAll: rm failed: ${msg}`)
    }
  }

  const rewindTemp = await cleanupRewindTempDirs({ includeActive: true })
  report.rewind_temp_dirs_removed = rewindTemp.dirsRemoved
  report.rewind_temp_bytes_freed = rewindTemp.bytesFreed
  for (const error of rewindTemp.errors) {
    report.errors.push(`rewind temp cleanup: ${error}`)
  }
  return report
}
