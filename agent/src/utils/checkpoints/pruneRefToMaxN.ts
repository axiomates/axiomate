/**
 * `pruneRefToMaxN` — per-project ring-buffer prune.
 *
 * Direct port of Hermes `_prune`
 * (`tools/checkpoint_manager.py::CheckpointManager._prune`).
 *
 * **What it does**: rewrites `refs/axiomate/<hash16>` to keep only the
 * most recent N commits, then runs `git gc --prune=now` so unreachable
 * objects are reclaimed and the store doesn't bloat.
 *
 * **Why it lives in `createSnapshot` not in Phase 4 prune**: this is the
 * per-project ring buffer that bounds *write* growth. If we deferred to
 * the once-a-day Phase 4 startup hook, a long active session would
 * accumulate thousands of commits per project before the next prune.
 * The cross-project size cap (Hermes `_enforce_size_cap`) is the one
 * we *do* defer to Phase 4 — that's a slow O(all projects) scan and
 * doesn't need to run mid-session.
 *
 * **Why it's a chain rebuild and not `git reset` + filter-branch**: the
 * shadow store has no working tree to reset against, and filter-branch
 * has been deprecated for years. The Hermes approach — collect the last
 * N commits, walk them forward rebuilding a linear chain via
 * `commit-tree -p <prev>`, then `update-ref` to the new tip — is the
 * canonical plumbing solution and works on a bare repo.
 */

import { runCheckpointGit, type CheckpointGitResult } from './git.js'
import { logForDebugging } from '../debug.js'

const ALLOW_128 = new Set([128]) // ref doesn't exist yet

export interface PruneRefOptions {
  /** Absolute, canonical path to the bare-ish shadow store. */
  store: string
  /** Canonical workTree (caller already normalized). */
  workTree: string
  /** Per-project ref name, e.g. `refs/axiomate/<hash16>`. */
  ref: string
  /**
   * Maximum number of commits to keep on the ref. Must be > 0; we treat
   * `<= 0` as "skip prune" rather than rebuilding to an empty ref (which
   * would be silly and also unsupported by `update-ref`).
   */
  maxN: number
}

/**
 * Rebuild `ref` to its last `maxN` commits, then run `gc --prune=now`.
 * No-op when ref doesn't exist, count is below the cap, or any plumbing
 * step fails — this op is best-effort cleanup, never a blocker.
 *
 * Returns the new commit count after the prune, or null if the prune
 * was skipped (so callers can log "kept N of M" in the snapshot path).
 */
export async function pruneRefToMaxN(
  opts: PruneRefOptions,
): Promise<number | null> {
  if (opts.maxN <= 0) return null

  // 1. How many commits are on the ref?
  const countResult = await runCheckpointGit(
    ['rev-list', '--count', opts.ref],
    {
      store: opts.store,
      workTree: opts.workTree,
      allowedExitCodes: ALLOW_128, // ref doesn't exist yet → treat as 0
    },
  )
  if (countResult.ok === false) return null
  const count = Number.parseInt(countResult.stdout.trim(), 10)
  if (!Number.isFinite(count) || count <= opts.maxN) return null

  // 2. List commits oldest → newest, take last N.
  const listResult = await runCheckpointGit(
    ['rev-list', '--reverse', opts.ref],
    { store: opts.store, workTree: opts.workTree },
  )
  if (listResult.ok === false || listResult.stdout.length === 0) return null
  const commits = listResult.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  const keep = commits.slice(-opts.maxN)

  // 3. Rebuild a linear chain off the new oldest commit's tree.
  //    For each kept SHA: get the original tree + subject, then make
  //    a fresh commit pointing at that tree with the previous new-commit
  //    as parent. This reuses the original tree blobs (free dedup) but
  //    builds a fresh chain that drops the orphaned old history.
  let newParent: string | null = null
  for (const sha of keep) {
    const treeResult = await runCheckpointGit(
      ['rev-parse', `${sha}^{tree}`],
      { store: opts.store, workTree: opts.workTree },
    )
    if (treeResult.ok === false) return null
    const treeSha = treeResult.stdout.trim()
    if (treeSha.length === 0) return null

    const subjectResult = await runCheckpointGit(
      ['log', '--format=%s', '-1', sha],
      { store: opts.store, workTree: opts.workTree },
    )
    const subject =
      subjectResult.ok === true && subjectResult.stdout.length > 0
        ? subjectResult.stdout.split('\n')[0] // log %s ends in \n
        : 'checkpoint'

    const args =
      newParent === null
        ? ['commit-tree', treeSha, '-m', subject, '--no-gpg-sign']
        : [
            'commit-tree',
            treeSha,
            '-p',
            newParent,
            '-m',
            subject,
            '--no-gpg-sign',
          ]
    const commitResult: CheckpointGitResult = await runCheckpointGit(args, {
      store: opts.store,
      workTree: opts.workTree,
    })
    if (commitResult.ok === false) return null
    const newSha = commitResult.stdout.trim()
    if (newSha.length === 0) return null
    newParent = newSha
  }

  if (newParent === null) return null

  // 4. Point the ref at the new tip.
  const updateResult = await runCheckpointGit(
    ['update-ref', opts.ref, newParent],
    { store: opts.store, workTree: opts.workTree },
  )
  if (updateResult.ok === false) return null

  // 5. Reclaim. reflog expire --all so the dropped commits aren't kept
  //    alive by reflog entries, then gc --prune=now to actually delete.
  //    gc gets 3x timeout — Hermes 1083 — because gc on a busy store
  //    can take a beat, and timing it out leaves dangling objects.
  await runCheckpointGit(['reflog', 'expire', '--expire=now', '--all'], {
    store: opts.store,
    workTree: opts.workTree,
  })
  await runCheckpointGit(['gc', '--prune=now', '--quiet'], {
    store: opts.store,
    workTree: opts.workTree,
    timeoutMs: 90_000,
  })

  logForDebugging(
    `pruneRefToMaxN: rebuilt ${opts.ref} from ${count} → ${keep.length} commits`,
  )
  return keep.length
}
