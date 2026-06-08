/**
 * `findReachableSnapshot` — does a gitHash from a resumed session
 * still exist in the shadow store?
 *
 * Resume restores `fileHistory.snapshots[]` from the JSONL transcript
 * verbatim — but the underlying commits in `~/.axiomate/checkpoints/store`
 * may have been pruned (per-project ring-buffer at 100, retention/size-cap
 * passes) since the original session ran. A snapshot row whose gitHash
 * is no longer reachable is *attached* to the in-memory list (so the
 * `/rewind` selector can still display "turn N: edited foo.ts") but
 * the actual rollback would `git ls-tree` against a missing object and
 * fail. 6A surfaces this state to the user before they try to rewind.
 *
 * Two-tier check (cheap-first):
 *   1. `git cat-file -e <hash>` against the project ref's index — fast,
 *      O(1) object-DB lookup. Resolves "object exists in store at all".
 *   2. `git merge-base --is-ancestor <hash> <ref>` — confirms the
 *      object is reachable from the current ref tip (i.e. the prune
 *      passes haven't unlinked it). This catches the case where a
 *      commit object survives because something else kept a handle
 *      but is no longer reachable from any axiomate-managed ref.
 *
 * 6B extension — cross-worktree scan: when the in-project ancestry
 * check fails BUT the object still exists in the DB, walk every other
 * `projects/<hash16>.json` and try the same `merge-base --is-ancestor`
 * against their refs. If any matches, return `'reachable-other-worktree'`
 * with that workdir. This handles the realistic case where the user
 * resumes a session captured under a different absolute path to the
 * same repo (e.g. `~/proj/main` vs `/tmp/build/proj`) — the object
 * survives, but only the originating project's ref anchors it.
 *
 * `git cat-file -e` exits 1 when the object is absent; `merge-base
 * --is-ancestor` exits 1 when the ancestor relation does not hold. We
 * treat both as `not reachable`. Any other failure → `unknown` (typed
 * separately so callers can fall back to "not displayed" rather than
 * "definitely gone").
 *
 * This helper exists because Axiomate warns before rewind when a recorded
 * hash is no longer anchored by the checkpoint store. Without it, the user
 * would only learn at restore time.
 */

import { runCheckpointGit } from './git.js'
import { ensureStore } from './store.js'
import { loadProjectMetas } from './projectMetas.js'
import { normalizePath, refName, projectHash } from './paths.js'
import { validateCommitHash } from './validate.js'

/**
 * Cross-worktree scan caps to avoid pathological behavior on users with
 * hundreds of registered projects. Sorted by `last_touch` desc so the
 * most-likely matches probe first.
 */
const CROSS_WORKTREE_SCAN_CAP = 50

/**
 * Discriminated union — the cross-worktree branch needs to carry the
 * foreign workdir so callers can show the user *which* project anchors
 * the snapshot. Pre-6B this was a plain string union; the callsite
 * upgrade is straightforward (`probe === 'reachable'` → `probe.kind ===
 * 'reachable'`).
 *
 * `unknown` is distinct from `unreachable` so the UI can choose to
 * either hide the hint (safer; user might find a "no rewind possible"
 * line confusing on a transient error) or render with a "?" suffix.
 * Default callsite (REPL post-resume) hides on `unknown`.
 */
export type Reachability =
  | { kind: 'reachable' }
  | { kind: 'reachable-other-worktree'; workdir: string }
  | { kind: 'unreachable' }
  | { kind: 'unknown' }

export interface FindReachableOptions {
  /** Workdir of the resumed session. */
  workdir: string
  /** gitHash from the resumed snapshot row to probe. */
  gitHash: string
}

/**
 * Probe whether `gitHash` is still reachable from this project's ref tip,
 * with a fallback scan across other registered project refs.
 *
 * Never throws. Cheap on the happy path: one `git cat-file -e`. On
 * objects that exist but aren't ancestors of the current ref, one extra
 * `merge-base --is-ancestor` per project up to `CROSS_WORKTREE_SCAN_CAP`,
 * exiting on the first match.
 */
export async function findReachableSnapshot(
  opts: FindReachableOptions,
): Promise<Reachability> {
  // gitHash from a transcript line is untrusted — it could be a partial
  // hash, contain a `-p`-style flag, etc. Validate before letting it
  // anywhere near git. `validateCommitHash` returns null on success and
  // an error string on failure, so non-null === reject.
  if (validateCommitHash(opts.gitHash) !== null) return { kind: 'unknown' }

  const ensured = await ensureStore()
  if (ensured.ok === false) return { kind: 'unknown' }

  const workdir = normalizePath(opts.workdir)
  const ownHash = projectHash(workdir)
  const ownRef = refName(ownHash)

  // Step 1: object exists in store at all? `cat-file -e` is silent on
  // success and exits 1 when the object is missing.
  const exists = await runCheckpointGit(
    ['cat-file', '-e', `${opts.gitHash}^{commit}`],
    {
      store: ensured.store,
      workTree: workdir,
      allowedExitCodes: new Set([1, 128]),
    },
  )
  if (exists.ok === false) return { kind: 'unknown' }
  if (exists.code === 1 || exists.code === 128) return { kind: 'unreachable' }

  // Step 2: reachable from the project's ref tip? An object that
  // survives because something else holds a reference to it but is
  // detached from refs/axiomate/<hash> would otherwise look "reachable"
  // here. Hermes' restore path also walks ref ancestry, so this matches
  // its effective semantics even though we don't share a function.
  const ancestor = await runCheckpointGit(
    ['merge-base', '--is-ancestor', opts.gitHash, ownRef],
    {
      store: ensured.store,
      workTree: workdir,
      allowedExitCodes: new Set([1, 128]),
    },
  )
  if (ancestor.ok === false) return { kind: 'unknown' }
  if (ancestor.code === 0) return { kind: 'reachable' }
  if (ancestor.code !== 1 && ancestor.code !== 128) return { kind: 'unknown' }

  // Step 3 (6B): not reachable here, but the object exists. Walk other
  // registered projects to catch the same-repo-different-path case. We
  // already know step 1 succeeded, so the object is in the DB; the only
  // question is which (if any) other ref anchors it.
  const foreign = await scanOtherProjectRefs({
    store: ensured.store,
    workTree: workdir,
    gitHash: opts.gitHash,
    excludeHash: ownHash,
  })
  if (foreign.kind !== 'no-match') return foreign
  return { kind: 'unreachable' }
}

/**
 * Walk other registered projects' refs looking for one that anchors
 * `gitHash`. Sorted by `last_touch` descending so the most recently
 * touched projects (likeliest to be the originating worktree) probe
 * first. Capped at CROSS_WORKTREE_SCAN_CAP.
 *
 * Return shape mirrors a partial Reachability — the caller threads
 * 'no-match' into `unreachable` after also exhausting this scan.
 */
async function scanOtherProjectRefs(args: {
  store: string
  workTree: string
  gitHash: string
  excludeHash: string
}): Promise<
  | { kind: 'reachable-other-worktree'; workdir: string }
  | { kind: 'unknown' }
  | { kind: 'no-match' }
> {
  const { metas } = await loadProjectMetas()
  const candidates = metas
    .filter(m => m.hash !== args.excludeHash)
    .sort((a, b) => b.last_touch - a.last_touch)
    .slice(0, CROSS_WORKTREE_SCAN_CAP)

  for (const meta of candidates) {
    const ref = refName(meta.hash)
    const r = await runCheckpointGit(
      ['merge-base', '--is-ancestor', args.gitHash, ref],
      {
        store: args.store,
        workTree: args.workTree,
        allowedExitCodes: new Set([1, 128]),
      },
    )
    if (r.ok === false) {
      // Probe failure on one project doesn't prove reachability —
      // continue scanning rather than giving up. The original ref-tip
      // result already answered the in-project question.
      continue
    }
    if (r.code === 0) {
      return { kind: 'reachable-other-worktree', workdir: meta.workdir }
    }
    // exit 1 / 128 → not an ancestor of this ref, keep scanning.
  }
  return { kind: 'no-match' }
}
