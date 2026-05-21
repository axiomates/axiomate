/**
 * `rollback` — restore a workdir (or a single relative path within it)
 * to the state at a given snapshot commit.
 *
 * Direct port of Hermes `restore` (`tools/checkpoint_manager.py::CheckpointManager.restore`).
 *
 * Pipeline:
 *   1.  validateCommitHash(hash) — reject `-`-prefixed and non-hex
 *       (defense against `git checkout --patch` injection).
 *   2.  Canonicalize workdir.
 *   3.  If `paths` provided, validateRelativePath each — block traversal.
 *   4.  Pre-flight on store HEAD; missing → 'no-checkpoints'.
 *   5.  `git cat-file -t <hash>` to confirm the commit exists in the
 *       store. cat-file exits non-zero if the object isn't present —
 *       cleaner than parsing rev-parse's stderr.
 *   6.  Take a `pre-rollback` snapshot via `createSnapshot`. The
 *       reserved messageId 'pre-rollback' is exempt from the dedup
 *       caller-side, and survives parseCommitSubject round-trip.
 *       Skip is fine — we record-the-undo as best-effort.
 *   7.  `git checkout <hash> -- <paths|.>` with the per-project index
 *       file. 60s timeout (2× default; Hermes 795). The per-project
 *       indexFile is critical: checkout writes index entries, and we
 *       want those entries to live in our shadow index (so the next
 *       createSnapshot's `add -A` sees the post-rollback baseline)
 *       not the user's `.git/index`.
 *   8.  Read the restored commit's subject for the result envelope.
 *
 * Returns a discriminated union; never throws. Failure paths align
 * with createSnapshot's reasons + a few rollback-specific ones
 * ('invalid-hash', 'invalid-path', 'no-checkpoints', 'not-found').
 *
 * Above-Hermes:
 *   - Hermes accepts a single optional `file_path`; we accept
 *     `paths: string[]` so callers can restore a directory tree without
 *     N round-trips. Each path is independently validated.
 *   - Subject is parsed via parseCommitSubject so consumers don't have
 *     to re-parse `axiomate:msgid:label` (Decision #14).
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { createSnapshot } from './createSnapshot.js'
import { runCheckpointGit } from './git.js'
import {
  getStoreDir,
  indexPath,
  normalizePath,
  projectHash,
} from './paths.js'
import { parseCommitSubject, type ParsedReason } from './reason.js'
import { ensureStore } from './store.js'
import { validateCommitHash, validateRelativePath } from './validate.js'

export type RollbackResult =
  | {
      ok: true
      /** First 8 chars of the restored commit (Hermes parity, line 810). */
      restoredTo: string
      /** Full SHA the rollback targeted (caller may want to log it). */
      hash: string
      /** Parsed subject of the restored commit. */
      reason: ParsedReason
      /** Canonical workdir we restored into. */
      directory: string
      /** Echo of the `paths` argument (when provided). */
      paths?: readonly string[]
    }
  | {
      ok: false
      reason:
        | 'invalid-hash'
        | 'invalid-path'
        | 'no-checkpoints'
        | 'not-found'
        | 'transient-error'
      message: string
    }

export interface RollbackOptions {
  /**
   * If provided, restore only these relative paths from the snapshot.
   * Each must be relative and stay within `workdir`. Empty array is
   * treated as "restore everything" — same as omitting.
   */
  paths?: readonly string[]
}

/**
 * Restore `workdir` (or a subset) to the state at `commitHash`.
 *
 * Caller passes a logical workdir + a commit hash. We canonicalize at
 * the boundary (matches Hermes line 767) before any operation that
 * depends on path identity.
 */
export async function rollback(
  workdir: string,
  commitHash: string,
  opts: RollbackOptions = {},
): Promise<RollbackResult> {
  // 1. Validate hash early — cheap, no IO.
  const hashErr = validateCommitHash(commitHash)
  if (hashErr) {
    return { ok: false, reason: 'invalid-hash', message: hashErr }
  }

  // 2. Canonicalize workdir.
  const canonical = normalizePath(workdir)

  // 3. Validate paths if any — independent reasons, log all rejections.
  const paths = opts.paths && opts.paths.length > 0 ? opts.paths : undefined
  if (paths) {
    for (const p of paths) {
      const pathErr = validateRelativePath(p, canonical)
      if (pathErr) {
        return { ok: false, reason: 'invalid-path', message: pathErr }
      }
    }
  }

  // 4. Store must exist before we try to look up the hash.
  if (!existsSync(join(getStoreDir(), 'HEAD'))) {
    return {
      ok: false,
      reason: 'no-checkpoints',
      message: 'No checkpoints exist (store not initialized)',
    }
  }
  const storeResult = await ensureStore()
  if (storeResult.ok === false) {
    return TRANSIENT(`ensureStore: ${storeResult.reason}`)
  }
  const store = storeResult.store

  // 5. Confirm the commit exists. cat-file -t exits non-zero when the
  //    object isn't in the store; that's the canonical "checkpoint not
  //    found" check (Hermes 779-784).
  const catFile = await runCheckpointGit(
    ['cat-file', '-t', commitHash],
    { store, workTree: canonical },
  )
  if (catFile.ok === false) {
    return {
      ok: false,
      reason: 'not-found',
      message: `Checkpoint '${commitHash}' not found: ${catFile.message}`,
    }
  }
  // cat-file -t prints the object type. We don't strictly require it to
  // be 'commit' (a tree or tag could in theory be checked out), but we
  // log it for debuggability; rejecting non-commits would diverge from
  // Hermes which doesn't enforce it either.
  if (catFile.stdout.trim() !== 'commit') {
    logForDebugging(
      `rollback: warning — ${commitHash} is a ${catFile.stdout.trim()}, not a commit`,
    )
  }

  // 6. Pre-rollback snapshot. Best-effort — skip is fine, we don't
  //    block the restore on the safety net failing (Hermes line 787
  //    ignores _take's return value entirely).
  await createSnapshot(canonical, {
    messageId: 'pre-rollback',
    label: `pre-rollback snapshot (restoring to ${commitHash.slice(0, 8)})`,
  })

  // 7. Per-project index file — checkout writes here, not the user's
  //    .git/index. After a successful restore the next createSnapshot's
  //    `add -A` will see the freshly-checked-out tree as the baseline.
  const hash = projectHash(canonical)
  const indexFile = indexPath(hash)

  const checkoutArgs = paths
    ? ['checkout', commitHash, '--', ...paths]
    : ['checkout', commitHash, '--', '.']
  const checkout = await runCheckpointGit(checkoutArgs, {
    store,
    workTree: canonical,
    indexFile,
    timeoutMs: 60_000,
  })
  if (checkout.ok === false) {
    return TRANSIENT(`checkout: ${checkout.message}`)
  }

  // 8. Subject for the result envelope. Best-effort — fall back to a
  //    raw 'unknown' shape on log failure (Hermes line 806).
  const logResult = await runCheckpointGit(
    ['log', '--format=%s', '-1', commitHash],
    { store, workTree: canonical },
  )
  const subject =
    logResult.ok === true && logResult.stdout.length > 0
      ? logResult.stdout.split('\n')[0]
      : 'unknown'

  return {
    ok: true,
    restoredTo: commitHash.slice(0, 8),
    hash: commitHash,
    reason: parseCommitSubject(subject),
    directory: canonical,
    paths,
  }
}

const TRANSIENT = (message: string): RollbackResult => ({
  ok: false,
  reason: 'transient-error',
  message,
})
