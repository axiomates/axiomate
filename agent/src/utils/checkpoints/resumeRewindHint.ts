/**
 * `resumeRewindHint` — wraps `findReachableSnapshot` (6A) to produce the
 * one-line text the REPL surfaces just after `/resume` (or `--resume` /
 * `--continue`) finishes restoring fileHistory.
 *
 * Why it exists: the resumed transcript hands `fileHistory.snapshots[]`
 * back verbatim, but the underlying commits in
 * `~/.axiomate/checkpoints/store/` may have been orphan-pruned between
 * the original session ending and the user typing `/resume` later. We
 * surface this *before* the user picks a row in `/rewind` and gets a
 * "missing object" error — see the helper module's header for the full
 * rationale.
 *
 * Contract: pure-ish in the sense that all IO is delegated to
 * `findReachableSnapshot`; this layer just picks which row to probe and
 * formats the hint. Returns `null` when no message should be shown — both
 * the "no snapshots" case (nothing to hint about) and the "unknown" probe
 * result (better to stay silent than render a confusing "?" line).
 */

import type { FileHistorySnapshot } from '../fileHistory.js'
import { findReachableSnapshot, type Reachability } from './findReachableSnapshot.js'

export interface ResumeRewindHintInput {
  workdir: string
  /**
   * The snapshots fileHistory restored from the resumed transcript. We
   * probe the *last* row — if that's reachable, all earlier rows in the
   * shown session are too (they're ancestors of the same ref chain). If
   * the last row is detached, the hint correctly degrades to a warning
   * even when older rows happen to still be reachable.
   */
  snapshots: readonly FileHistorySnapshot[]
}

export interface ResumeRewindHint {
  /** Single-line plain-text body for `createSystemMessage`. */
  text: string
  /** Severity for `createSystemMessage`'s second arg. */
  severity: 'info' | 'warning'
}

/**
 * Compute the post-resume hint. Returns null when nothing should be
 * displayed — keeps the REPL site to a single `if (hint) push(...)`.
 *
 * Four outcomes drive the result:
 *   - reachable                 → info: "/rewind to restore worktree"
 *   - reachable-other-worktree  → warning: snapshot lives under a
 *                                 different workdir; /rewind here will
 *                                 fail. Tells the user where to cd.
 *   - unreachable               → warning: "snapshots have been pruned;
 *                                 /rewind may not be able to restore"
 *   - unknown                   → null (transient probe failure or
 *                                 invalid hash; surfacing a hint here
 *                                 would be more confusing than helpful
 *                                 — `/rewind` itself will still tell
 *                                 the user if it can't find the object)
 */
export async function computeResumeRewindHint(
  input: ResumeRewindHintInput,
): Promise<ResumeRewindHint | null> {
  if (input.snapshots.length === 0) return null
  const last = input.snapshots[input.snapshots.length - 1]
  if (
    last === undefined ||
    typeof last.gitHash !== 'string' ||
    last.gitHash === ''
  ) {
    return null
  }
  const probe: Reachability = await findReachableSnapshot({
    workdir: input.workdir,
    gitHash: last.gitHash,
  })
  if (probe.kind === 'reachable') {
    return {
      text: 'Worktree state from this session is still rewindable — use /rewind to restore.',
      severity: 'info',
    }
  }
  if (probe.kind === 'reachable-other-worktree') {
    return {
      text: `Worktree snapshots from this session are anchored to a different workdir (${probe.workdir}). /rewind here will fail; cd into that workdir to restore.`,
      severity: 'warning',
    }
  }
  if (probe.kind === 'unreachable') {
    return {
      text: 'Some checkpoint snapshots from this session have been pruned. /rewind may not be able to restore the worktree.',
      severity: 'warning',
    }
  }
  return null
}
