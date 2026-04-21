/**
 * Iterative-compact helpers: extract the previous compact summary from
 * message history and filter it out of messagesToSummarize so the LLM
 * sees only new turns + an explicit PREVIOUS SUMMARY section in the
 * prompt (hermes-style iterative update).
 *
 * These live in their own file (separate from compact.ts) so unit tests
 * can import them without pulling in the heavy tool-registry chain.
 */
import type { UUID } from 'crypto'

import type { Message, UserMessage } from '../../types/message.js'
import {
  COMPACT_SUMMARY_PREAMBLE,
  COMPACT_SUMMARY_RECENT_TRAILER,
  COMPACT_SUMMARY_SUPPRESS_TRAILER,
  COMPACT_SUMMARY_TRANSCRIPT_TRAILER_PREFIX,
} from './prompt.js'

// Inlined copy of `isCompactBoundaryMessage` and `findLastCompactBoundaryIndex`
// from utils/messages.ts. Importing from messages.ts here would transitively
// load tools.ts (through the registry / hook chain), which fails under vitest
// due to a CommonJS `require` that doesn't resolve in the test runner. Keeping
// these tiny checks local keeps this file unit-testable. If the underlying
// message shape changes in messages.ts, update here too.
function isCompactBoundary(message: Message): boolean {
  return (
    message != null &&
    message.type === 'system' &&
    (message as { subtype?: string }).subtype === 'compact_boundary'
  )
}

function findLastCompactBoundaryIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && isCompactBoundary(m)) return i
  }
  return -1
}

/**
 * Strip the `getCompactUserSummaryMessage` wrapper from a stored compact
 * summary user message, returning just the `Summary:` body.
 *
 * The wrapper literals live in prompt.ts as COMPACT_SUMMARY_* constants so
 * this extractor stays in lockstep with the formatter.
 */
export function extractSummaryContentFromUserMessage(
  msg: UserMessage,
): string | null {
  const content =
    typeof msg.message.content === 'string' ? msg.message.content : null
  if (!content) return null
  const summaryIdx = content.indexOf('Summary:')
  if (summaryIdx < 0) {
    // Fallback: return whole content minus the preamble if present.
    const trimmed = content.startsWith(COMPACT_SUMMARY_PREAMBLE)
      ? content.slice(COMPACT_SUMMARY_PREAMBLE.length).trim()
      : content.trim()
    return trimmed || null
  }
  const body = content.slice(summaryIdx + 'Summary:'.length)
  // Strip optional trailers appended by getCompactUserSummaryMessage.
  const cutMarkers = [
    `\n\n${COMPACT_SUMMARY_TRANSCRIPT_TRAILER_PREFIX}`,
    `\n\n${COMPACT_SUMMARY_RECENT_TRAILER}`,
    `\n${COMPACT_SUMMARY_SUPPRESS_TRAILER}`,
  ]
  let cutAt = body.length
  for (const marker of cutMarkers) {
    const idx = body.indexOf(marker)
    if (idx >= 0 && idx < cutAt) cutAt = idx
  }
  const result = body.slice(0, cutAt).trim()
  return result || null
}

/**
 * Find the previous compact summary in message history. Returns null if no
 * prior compact has occurred.
 *
 * Pairs with filterPreviousSummaryForIterativeCompact: the returned text
 * goes into the iterative prompt while the corresponding user message is
 * filtered out of messagesToSummarize so the LLM doesn't see two copies.
 */
export function extractPreviousCompactSummary(
  messages: readonly Message[],
): { summaryText: string; summaryMessageUuid: UUID } | null {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  if (boundaryIndex < 0) return null
  // Scan forward from the boundary for the first isCompactSummary user msg.
  // buildPostCompactMessages emits boundary → summary adjacently; attachments
  // and hooks may theoretically intervene, so scan rather than peek at +1.
  for (let i = boundaryIndex + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m?.type === 'user' && m.isCompactSummary) {
      const text = extractSummaryContentFromUserMessage(m)
      if (!text) return null
      return { summaryText: text, summaryMessageUuid: m.uuid }
    }
  }
  return null
}

/**
 * Remove the previous compact summary user message (identified by uuid) from
 * `messagesToSummarize`, leaving only new turns. Used when the summary text
 * is being injected explicitly into the iterative prompt.
 */
export function filterPreviousSummaryForIterativeCompact(
  messages: readonly Message[],
  summaryMessageUuid: UUID,
): Message[] {
  return messages.filter(m => m.uuid !== summaryMessageUuid)
}
