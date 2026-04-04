// Stub: contextCollapse — loaded behind feature('CONTEXT_COLLAPSE') guard.

import type { Message } from '../../types/message.js'

export interface ContextCollapseHealth {
  totalSpawns: number
  totalErrors: number
  totalEmptySpawns: number
  lastError?: string | null
  emptySpawnWarningEmitted: boolean
}

export interface ContextCollapseStats {
  health: ContextCollapseHealth
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  totalCollapsed: number
  totalWithheld: number
}

export function applyCollapsesIfNeeded(
  _messages: Message[],
  ..._args: unknown[]
): { messages: Message[]; changed: boolean } {
  return { messages: _messages, changed: false }
}

export function getStats(): ContextCollapseStats {
  return {
    health: {
      totalSpawns: 0,
      totalErrors: 0,
      totalEmptySpawns: 0,
      lastError: null,
      emptySpawnWarningEmitted: false,
    },
    collapsedSpans: 0,
    collapsedMessages: 0,
    stagedSpans: 0,
    totalCollapsed: 0,
    totalWithheld: 0,
  }
}

export function initContextCollapse(): void {
  // no-op
}

export function isContextCollapseEnabled(): boolean {
  return false
}

export function isWithheldPromptTooLong(
  ..._args: unknown[]
): boolean {
  return false
}

export function recoverFromOverflow(
  _messages: Message[],
  ..._args: unknown[]
): { messages: Message[]; committed: number } {
  return { messages: _messages, committed: 0 }
}

export function resetContextCollapse(): void {
  // no-op
}

export function subscribe(
  _listener: (...args: unknown[]) => void,
): () => void {
  return () => {}
}
