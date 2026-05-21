/**
 * `createSnapshot` — the 13-step pipeline that stages and commits a
 * single snapshot to the shadow store. Direct port of Hermes `_take`
 * (`tools/checkpoint_manager.py:830-972`) plus `_prune` (1020-1084)
 * folded in as step 12.
 *
 * Returns a discriminated union — never throws. Fail-open contract:
 * every transient failure path maps to `{ ok: false, skipped: 'transient-error' }`
 * and is logged via `logForDebugging`. Phase 3's fileHistory swap point
 * treats any non-`ok` result as "no snapshot recorded this turn, retry
 * next turn".
 *
 * Steps (full rationale lives in docs/checkpoints-v2-progress.md):
 *   1.  soft-disable when git missing
 *   2.  broad-dir guard
 *   3.  per-turn dedup is the caller's responsibility
 *   4.  touch project metadata BEFORE file-count guard (orphan tracking)
 *   5.  file-count guard via fs walk
 *   6.  set up per-project state (hash, ref, indexFile)
 *   7.  seed the index from existing ref tip
 *   8.  git add -A
 *   9.  drop oversize files from index
 *   10. no-changes detection (skip empty commits)
 *   11. commit via write-tree + commit-tree + update-ref CAS
 *   12. per-project ring-buffer prune
 *   13. (cross-project size cap deferred to Phase 4 startup hook)
 *
 * Stricter-than-Hermes behavior — flagged so future maintainers don't
 * read it as a bug:
 *   - On rev-parse failure other than the allowed 128 ("ref not found"),
 *     step 7 returns `transient-error` instead of falling through to a
 *     fresh-root commit like Hermes does (`_take` 904-909). A glitchy
 *     rev-parse on an existing ref would, under Hermes' branch, orphan
 *     the prior history with a new root commit; we'd rather drop this
 *     turn's snapshot and retry next turn than silently break the chain.
 */

import { homedir } from 'os'
import { unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { logForDebugging } from '../debug.js'
import { countFilesUnder } from './countFiles.js'
import { dropOversizeFromIndex } from './dropOversizeFromIndex.js'
import {
  probeGitAvailable,
  runCheckpointGit,
  type CheckpointGitResult,
} from './git.js'
import {
  indexPath,
  normalizePath,
  projectHash,
  refName,
} from './paths.js'
import { pruneRefToMaxN } from './pruneRefToMaxN.js'
import { formatCommitSubject } from './reason.js'
import { ensureStore } from './store.js'
import { touchProject } from './touchProject.js'

// Module-level constants. These are intentionally not configurable from
// callers — they're tuned for "checkpoints subsystem must never block
// the agent" and changing them requires deliberation, not arguments.
export const MAX_FILES = 50_000
export const MAX_FILE_SIZE_MB = 10
export const MAX_SNAPSHOTS = 100
const REF_NOT_EXIST = new Set([128])
const DIFF_HAS_CHANGES = new Set([1])

export type CreateSnapshotResult =
  | { ok: true; hash: string; ref: string }
  | {
      ok: false
      skipped:
        | 'git-missing'
        | 'workdir-too-broad'
        | 'too-many-files'
        | 'no-changes'
        | 'race'
        | 'transient-error'
      message?: string
    }

export interface CreateSnapshotReason {
  /** Anthropic message id (or `'pre-rollback'`). Must match `[A-Za-z0-9_-]+`. */
  messageId: string
  /** Free-text label. Newlines stripped at format time. */
  label: string
}

export interface CreateSnapshotOptions {
  /**
   * Force a commit even when there are no changes vs the ref tip (or no
   * staged content at all). The commit-tree call accepts an empty tree
   * fine, and an empty commit on top of a parent is also fine — the
   * useful invariant is that *every* turn-keyed snapshot resolves to a
   * gitHash, so fileHistoryRewind can always find something to roll back
   * to. The `/checkpoints` user-facing path keeps the default (skip
   * empty) since manual rollbacks don't need empty rungs in the ladder.
   */
  allowEmpty?: boolean
}

const TRANSIENT = (message: string): CreateSnapshotResult => ({
  ok: false,
  skipped: 'transient-error',
  message,
})

/**
 * Stage and commit a snapshot of `workdir` to the shared shadow store.
 *
 * Caller passes a logical workdir (may be tilde-prefixed or relative);
 * we canonicalize at this boundary before any operation that depends on
 * path identity (hashing, touchProject metadata, GIT_WORK_TREE).
 */
export async function createSnapshot(
  workdir: string,
  reason: CreateSnapshotReason,
  opts: CreateSnapshotOptions = {},
): Promise<CreateSnapshotResult> {
  // 1. Soft-disable when git is missing.
  if (!(await probeGitAvailable())) {
    return { ok: false, skipped: 'git-missing' }
  }

  // 2. Broad-dir guard. We refuse to snapshot drive roots and the user
  //    home directory — both as a safety net (a 100k-file home dir
  //    would obliterate the file-count guard anyway, but better to
  //    short-circuit explicitly) and because there's no agent-continuity
  //    interpretation of "snapshot the entire user home". Hermes 642-644.
  const canonical = normalizePath(workdir)
  if (isBroadDir(canonical)) {
    logForDebugging(
      `createSnapshot: skipped — directory too broad: ${canonical}`,
    )
    return { ok: false, skipped: 'workdir-too-broad' }
  }

  // 3. Per-turn dedup is the caller's responsibility. fileHistory.ts
  //    keys on messageId already; we don't reimplement Hermes'
  //    _checkpointed_dirs in-memory set.

  // Ensure store before any git op. ensureStore is idempotent + cheap
  // when HEAD already exists (single existsSync), so calling it on
  // every createSnapshot is fine.
  const storeResult = await ensureStore()
  if (storeResult.ok === false) {
    logForDebugging(`createSnapshot: ensureStore failed: ${storeResult.reason}`)
    return TRANSIENT(`ensureStore: ${storeResult.reason}`)
  }
  const store = storeResult.store

  // 4. Touch project metadata BEFORE file-count guard so even skipped
  //    snapshots register the project for orphan tracking.
  const hash = projectHash(canonical)
  const indexFile = indexPath(hash)
  const ref = refName(hash)
  await touchProject(canonical) // never throws

  // 5. File-count guard.
  const counted = await countFilesUnder(canonical, { max: MAX_FILES })
  if (counted.aborted) {
    logForDebugging(
      `createSnapshot: skipped — too many files (>${MAX_FILES}) in ${canonical}`,
    )
    return { ok: false, skipped: 'too-many-files' }
  }

  // 6. Per-project state already computed above.

  // 7. Seed the index from the existing ref tip (if any).
  const refCommitResult = await runCheckpointGit(
    ['rev-parse', '--verify', `${ref}^{commit}`],
    {
      store,
      workTree: canonical,
      allowedExitCodes: REF_NOT_EXIST,
    },
  )
  if (refCommitResult.ok === false) {
    return TRANSIENT(`rev-parse: ${refCommitResult.message}`)
  }
  const refCommit = refCommitResult.stdout.trim()
  const hasRef = refCommit.length > 0

  if (hasRef) {
    const readTree = await runCheckpointGit(['read-tree', refCommit], {
      store,
      workTree: canonical,
      indexFile,
    })
    if (readTree.ok === false) {
      return TRANSIENT(`read-tree: ${readTree.message}`)
    }
  } else if (existsSync(indexFile)) {
    // Stale index from a deleted ref — clear so `git add -A` builds fresh.
    try {
      await unlink(indexFile)
    } catch {
      // Best-effort; if this fails git will likely complain at add time.
    }
  }

  // 8. Stage everything. 2× timeout for very large trees (Hermes 891).
  const addResult = await runCheckpointGit(['add', '-A'], {
    store,
    workTree: canonical,
    indexFile,
    timeoutMs: 60_000,
  })
  if (addResult.ok === false) {
    return TRANSIENT(`add: ${addResult.message}`)
  }

  // 9. Drop oversize files from the index.
  await dropOversizeFromIndex({
    store,
    workTree: canonical,
    indexFile,
    maxFileSizeMb: MAX_FILE_SIZE_MB,
  })

  // 10. No-changes detection. With a ref: diff-index. Without: ls-files.
  //     `allowEmpty` shorts this — fileHistory needs a gitHash even on
  //     turns where nothing changed on disk so rewind always has a target.
  if (!opts.allowEmpty) {
    const noChanges = await detectNoChanges({
      store,
      workTree: canonical,
      indexFile,
      refCommit,
      hasRef,
    })
    if (noChanges === 'no-changes') {
      return { ok: false, skipped: 'no-changes' }
    }
    if (noChanges === 'transient') {
      return TRANSIENT('no-changes detection failed')
    }
  }

  // 11. Commit via plumbing.
  const commitResult = await commitSnapshot({
    store,
    workTree: canonical,
    indexFile,
    ref,
    refCommit,
    hasRef,
    subject: formatCommitSubject(reason),
  })
  if (commitResult.ok === false) return commitResult
  const newSha = commitResult.hash

  // 12. Per-project ring-buffer prune.
  await pruneRefToMaxN({
    store,
    workTree: canonical,
    ref,
    maxN: MAX_SNAPSHOTS,
  })

  // 13. Cross-project size cap deferred to Phase 4.
  return { ok: true, hash: newSha, ref }
}

/**
 * Drive-root or home-dir guard. On Windows: `C:\` `D:\` etc match the
 * `^[A-Za-z]:[\\/]?$` pattern. On POSIX: `/` is the only drive root.
 * We compare the canonical form (post-normalize) so `~` and `~/` both
 * collapse to the home dir match.
 */
function isBroadDir(canonical: string): boolean {
  if (canonical === '/') return true
  if (canonical === homedir()) return true
  // Windows drive roots: C:\, C:/, c:, etc.
  if (/^[A-Za-z]:[\\/]?$/.test(canonical)) return true
  return false
}

interface NoChangesArgs {
  store: string
  workTree: string
  indexFile: string
  refCommit: string
  hasRef: boolean
}

async function detectNoChanges(
  a: NoChangesArgs,
): Promise<'no-changes' | 'has-changes' | 'transient'> {
  if (a.hasRef) {
    // diff-index --cached --quiet exits 0 if no changes vs the ref tree,
    // 1 if changes are present. allowedExitCodes={1} catches the latter.
    const r = await runCheckpointGit(
      ['diff-index', '--cached', '--quiet', a.refCommit],
      {
        store: a.store,
        workTree: a.workTree,
        indexFile: a.indexFile,
        allowedExitCodes: DIFF_HAS_CHANGES,
      },
    )
    if (r.ok === false) return 'transient'
    return r.code === 1 ? 'has-changes' : 'no-changes'
  }
  // No ref yet: an empty staged set means "nothing to commit".
  const r = await runCheckpointGit(['ls-files', '--cached'], {
    store: a.store,
    workTree: a.workTree,
    indexFile: a.indexFile,
  })
  if (r.ok === false) return 'transient'
  return r.stdout.trim().length === 0 ? 'no-changes' : 'has-changes'
}

interface CommitArgs {
  store: string
  workTree: string
  indexFile: string
  ref: string
  refCommit: string
  hasRef: boolean
  subject: string
}

async function commitSnapshot(
  a: CommitArgs,
): Promise<{ ok: true; hash: string } | CreateSnapshotResult> {
  const writeTree: CheckpointGitResult = await runCheckpointGit(
    ['write-tree'],
    { store: a.store, workTree: a.workTree, indexFile: a.indexFile },
  )
  if (writeTree.ok === false) return TRANSIENT(`write-tree: ${writeTree.message}`)
  const treeSha = writeTree.stdout.trim()

  const args = a.hasRef
    ? ['commit-tree', treeSha, '-p', a.refCommit, '-m', a.subject, '--no-gpg-sign']
    : ['commit-tree', treeSha, '-m', a.subject, '--no-gpg-sign']
  const commitTree = await runCheckpointGit(args, {
    store: a.store,
    workTree: a.workTree,
    indexFile: a.indexFile,
  })
  if (commitTree.ok === false) {
    return TRANSIENT(`commit-tree: ${commitTree.message}`)
  }
  const newSha = commitTree.stdout.trim()
  if (newSha.length === 0) return TRANSIENT('commit-tree returned empty')

  // CAS via the third arg to update-ref. If the ref moved between our
  // rev-parse and now (concurrent snapshot from another worktree of the
  // same project), this fails and we report 'race' rather than blow
  // away the other snapshot's commit.
  const updateArgs = a.hasRef
    ? ['update-ref', a.ref, newSha, a.refCommit]
    : ['update-ref', a.ref, newSha]
  const update = await runCheckpointGit(updateArgs, {
    store: a.store,
    workTree: a.workTree,
    indexFile: a.indexFile,
  })
  if (update.ok === false) {
    // update-ref's CAS failure exits 1 with stderr including
    // "cannot lock ref" — surface as race so callers can retry next turn.
    if (a.hasRef && update.code === 1) {
      logForDebugging(
        `createSnapshot: lost CAS race on ${a.ref} (${update.message})`,
      )
      return { ok: false, skipped: 'race' }
    }
    return TRANSIENT(`update-ref: ${update.message}`)
  }

  return { ok: true, hash: newSha }
}
