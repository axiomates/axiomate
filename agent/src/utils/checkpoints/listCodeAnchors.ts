/**
 * `listCodeAnchors` — picker / chooser / rewind data source.
 *
 * Thin adapter over `listSnapshots` that projects the raw checkpoint
 * entries into the shape consumers care about: a flat `CodeAnchor` with
 * `messageId` already pulled out of the parsed subject and the timestamp
 * already a Date.
 *
 * Why this exists (Phase 1 of the disk-as-single-source-of-truth migration):
 * picker, chooser, and `/rewind` execution used to read `state.fileHistory.snapshots`
 * — an in-memory cache of disk state with no invalidation contract. Operations
 * that mutate disk (`/checkpoints clear`, prune, gc) left the cache stale, so
 * the picker showed ghost rows that failed at execution time. After this
 * adapter every "what anchors exist?" question routes to git, and the
 * cache simply doesn't exist anymore.
 *
 * Body / prompt-preview text isn't included here — Phase 2 will add
 * `withBodies` to `listSnapshots` for the picker's ↶ row label. Until then
 * synthetic-anchor rows render as `↶ Off-branch anchor (HH:MM)` instead of
 * the prompt preview.
 */
import { listSnapshots, type SnapshotEntry } from './listSnapshots.js'
import type { UUID } from 'crypto'

export interface CodeAnchor {
  /** Full SHA-1 in the shadow store. */
  gitHash: string
  /**
   * Anthropic message UUID this anchor was taken at. Undefined for raw
   * subjects (foreign commits, or pre-`axiomate:` legacy entries) — those
   * still surface in the picker as off-branch rows but cannot be matched
   * back to a conversation message.
   */
  messageId: UUID | undefined
  /** Raw commit subject (`axiomate:<msgId>:<label>` or free text). */
  subject: string
  /** Author timestamp. */
  timestamp: Date
  /** From batched `git log --shortstat`. Zero if commit had no diff. */
  filesChanged: number
  insertions: number
  deletions: number
}

export interface ListCodeAnchorsOptions {
  limit?: number
  /** Skip the per-commit shortstat fetch when caller doesn't need it. */
  withStats?: boolean
}

/**
 * Project the per-anchor view used by picker, chooser, and rewind. Newest
 * first. Never throws — propagates the empty-on-failure semantics of
 * `listSnapshots`.
 */
export async function listCodeAnchors(
  workdir: string,
  opts: ListCodeAnchorsOptions = {},
): Promise<CodeAnchor[]> {
  const entries = await listSnapshots(workdir, opts)
  return entries.map(toCodeAnchor)
}

function toCodeAnchor(entry: SnapshotEntry): CodeAnchor {
  const messageId =
    entry.reason.kind === 'axiomate'
      ? (entry.reason.messageId as UUID)
      : undefined
  return {
    gitHash: entry.hash,
    messageId,
    subject: entry.subject,
    timestamp: new Date(entry.timestamp),
    filesChanged: entry.filesChanged,
    insertions: entry.insertions,
    deletions: entry.deletions,
  }
}
