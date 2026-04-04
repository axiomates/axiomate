// Stub: snipCompact — loaded behind feature guard in query.ts.
// Callers use: count, SNIP_NUDGE_TEXT, isSnipMarkerMessage,
// isSnipRuntimeEnabled, shouldNudgeForSnips, snipCompactIfNeeded

import type { Message } from '../../types/message.js'

export const count = 0

export const SNIP_NUDGE_TEXT = ''

export function isSnipMarkerMessage(_msg: unknown): boolean {
  return false
}

export function isSnipRuntimeEnabled(): boolean {
  return false
}

export function shouldNudgeForSnips(_messages: Message[]): boolean {
  return false
}

export function snipCompactIfNeeded(
  messagesOrStore: Message[] | unknown,
  _opts?: { force?: boolean },
): { messages: Message[]; changed: boolean; executed: boolean; tokensFreed: number; boundaryMessage: Message | null } {
  const messages = Array.isArray(messagesOrStore)
    ? messagesOrStore
    : []
  return { messages, changed: false, executed: false, tokensFreed: 0, boundaryMessage: null }
}
