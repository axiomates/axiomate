/**
 * Conversation branch helpers for the /rewind picker's Conversation tab.
 *
 * Two responsibilities:
 *
 *  1. `transcriptToUserMessage` — build a real `UserMessage` from a stored
 *     `TranscriptMessage`. The picker's row-render path expects
 *     `UserMessage`-shaped objects (it reads `.message.content` etc), but the
 *     loader gives us `TranscriptMessage`. A bare `as UserMessage` cast would
 *     pass typecheck and crash at render time on shape mismatches; we go
 *     through `createUserMessage` to construct an honest object whose shape
 *     the picker already knows how to consume (it uses the same factory for
 *     synthetic ↶ rows). See axiomate/agent/src/components/MessageSelector.tsx
 *     `messageOptions` and `syntheticAnchors`.
 *
 *  2. `findAbandonedLeafChains` — given the loaded transcript, return one
 *     chain per *abandoned* leaf, i.e. every leaf reachable in the JSONL
 *     except the one the user is currently on. Each chain is the sequence of
 *     user messages from the leaf back through `parentUuid` until the chain
 *     joins the current head's chain (or hits null / the most recent compact
 *     boundary, whichever comes first).
 *
 *     Loader (`loadTranscriptFile`) already prunes everything before the most
 *     recent compact boundary, so abandoned chains never span across compact
 *     boundaries — the message Map simply doesn't contain those entries.
 *     The walk is implemented defensively anyway (stops at null / unknown
 *     parentUuid) so a malformed transcript can't infinite-loop us.
 */
import type { UUID } from 'crypto'

import type { TranscriptMessage } from '../types/logs.js'
import type { UserMessage } from '../types/message.js'

import { createUserMessage } from './messages.js'

/**
 * Adapt a stored `TranscriptMessage` (user-typed) to a `UserMessage` the
 * picker can render. We copy only the fields the picker reads — uuid,
 * timestamp, message.content — and let `createUserMessage` fill in the
 * canonical shape (role, isMeta defaults, etc).
 *
 * Caller is responsible for passing a user-typed transcript message; the
 * adapter doesn't try to reshape assistant or tool-result frames.
 */
export function transcriptToUserMessage(tm: TranscriptMessage): UserMessage {
  const content = (tm as { message?: { content?: unknown } }).message?.content
  return {
    ...createUserMessage({
      content:
        typeof content === 'string' || Array.isArray(content)
          ? (content as string | Parameters<typeof createUserMessage>[0]['content'])
          : '',
    }),
    uuid: tm.uuid,
    timestamp: tm.timestamp,
  } as UserMessage
}

/**
 * Build a picker row for an abandoned-branch user message. The row
 * mirrors the file-tab synthetic ↶ anchor format
 * (`↶ Before "<preview>" [<short>]`) so the user reads the row the
 * same way regardless of which axis they're rewinding on. Crucially
 * the row's uuid is the **real** message uuid — that's what handlers
 * downstream (rewindConversationTo, chooser branching) key off, and
 * what loadTranscriptFile can resolve back to a TranscriptMessage on
 * abandoned-branch switch.
 *
 * `preview` is up to 60 chars of the message's user-visible text,
 * single-line, with ellipsis on overflow. Empty content falls back to
 * a placeholder so the row still reads cleanly.
 */
export function buildAbandonedRow(tm: TranscriptMessage): UserMessage {
  const rawContent = (tm as { message?: { content?: unknown } }).message?.content
  let rawText = ''
  if (typeof rawContent === 'string') {
    rawText = rawContent
  } else if (Array.isArray(rawContent)) {
    // Mirror UserMessageOption's "last text block" rule.
    const lastText = [...rawContent]
      .reverse()
      .find(b => b && (b as { type?: string }).type === 'text') as
      | { text: string }
      | undefined
    rawText = lastText?.text ?? ''
  }
  const oneLine = rawText.replace(/\s+/g, ' ').trim()
  const preview =
    oneLine.length === 0
      ? '(empty prompt)'
      : oneLine.length > 60
        ? oneLine.slice(0, 60) + '…'
        : oneLine
  const shortUuid = tm.uuid.slice(0, 7)
  const content = `↶ Before "${preview}" [${shortUuid}]`
  return {
    ...createUserMessage({ content }),
    uuid: tm.uuid,
    timestamp: tm.timestamp,
  } as UserMessage
}

/**
 * Result type — one entry per abandoned leaf. `chain` is ordered oldest → newest
 * (root-side first, leaf last) and only contains user-typed messages, since
 * those are the picker's selectable units.
 */
export type AbandonedChain = {
  /** UUID of the abandoned leaf message (newest in the chain — could be
   *  assistant or user). */
  leafUuid: UUID
  /** Timestamp of the abandoned leaf — used for chronological merge. */
  leafTimestamp: string
  /** The newest USER TranscriptMessage in the abandoned branch. This is
   *  what the picker row should preview AND what should be the rewind
   *  target — "redo this prompt". The leaf itself may be an assistant
   *  reply that came after this user message, but conversation rewind
   *  is anchored on user prompts (the user wants to redo what they
   *  typed, not what the AI said). */
  previewUserMessage: TranscriptMessage
  /** User messages in the abandoned branch, oldest → newest. */
  chain: UserMessage[]
}

/**
 * Walk every abandoned leaf back to where it joins the current head's chain
 * (or to a chain root if it never joins, e.g. pre-compact orphan).
 *
 * `headChainUuids` is the set of uuids on the active conversation chain —
 * caller computes it by walking the head leaf back through parentUuid.
 * Anything in that set is "current chain"; we stop the walk there so the
 * abandoned chain only contains the divergent suffix.
 */
export function findAbandonedLeafChains(args: {
  messages: Map<UUID, TranscriptMessage>
  leafUuids: Set<UUID>
  headChainUuids: Set<UUID>
  /** UUID the current head record / heuristic resolved to; excluded from results. */
  headLeafUuid: UUID | undefined
}): AbandonedChain[] {
  const { messages, leafUuids, headChainUuids, headLeafUuid } = args
  const out: AbandonedChain[] = []

  for (const leafUuid of leafUuids) {
    if (leafUuid === headLeafUuid) continue
    if (headChainUuids.has(leafUuid)) continue
    const leaf = messages.get(leafUuid)
    if (!leaf) continue

    const chain: UserMessage[] = []
    const seen = new Set<UUID>()
    let cur: TranscriptMessage | undefined = leaf
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid)
      // Stop when we re-enter the current chain — the divergence point and
      // everything before it is shared, so don't double-render those rows.
      if (headChainUuids.has(cur.uuid)) break
      if (cur.type === 'user') {
        chain.unshift(transcriptToUserMessage(cur))
      }
      const parentUuid = cur.parentUuid
      if (!parentUuid) break
      cur = messages.get(parentUuid)
    }

    if (chain.length === 0) continue
    // The newest user message in the abandoned chain — that's what
    // the picker should preview ("redo this prompt") AND what the
    // rewind handler should target. Leaf can be an assistant reply
    // that came after the user's last prompt; using it for preview
    // would show the AI's text instead of the user's.
    const previewUserMessage = (() => {
      // Walk the chain back from the leaf to find the most recent
      // user TranscriptMessage. chain[] is oldest→newest UserMessages
      // but we want the original TranscriptMessage (raw content,
      // unique uuid for handler routing). Walk parentUuid from leaf
      // until we find a user-typed message.
      let walker: TranscriptMessage | undefined = leaf
      while (walker) {
        if (walker.type === 'user') return walker
        walker = walker.parentUuid ? messages.get(walker.parentUuid) : undefined
        if (walker && headChainUuids.has(walker.uuid)) break
      }
      return undefined
    })()
    if (!previewUserMessage) continue
    out.push({
      leafUuid,
      leafTimestamp: leaf.timestamp,
      previewUserMessage,
      chain,
    })
  }

  out.sort((a, b) => (a.leafTimestamp < b.leafTimestamp ? 1 : -1))
  return out
}

/**
 * Walk the head leaf back through parentUuid and collect every uuid on the
 * way. Helper for `findAbandonedLeafChains` callers — returned set is the
 * "current chain" boundary.
 */
export function buildHeadChainUuids(
  messages: Map<UUID, TranscriptMessage>,
  headLeafUuid: UUID | undefined,
): Set<UUID> {
  const out = new Set<UUID>()
  if (!headLeafUuid) return out
  let cur = messages.get(headLeafUuid)
  while (cur && !out.has(cur.uuid)) {
    out.add(cur.uuid)
    if (!cur.parentUuid) break
    cur = messages.get(cur.parentUuid)
  }
  return out
}
