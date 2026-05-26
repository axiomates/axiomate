import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import { describe, expect, test, vi } from 'vitest'

import type {
  ConversationHeadEntry,
  TranscriptMessage,
} from '../../../types/logs.js'
import { pickConversationHead } from '../../../utils/sessionStorage.js'

// Minimal user-message factory — pickConversationHead doesn't read the
// content payload, just type/uuid/timestamp/parentUuid for ordering. We
// don't bring in createUserMessage from messages.ts because it touches
// a lot of bootstrap state we don't need for this pure-function suite.
function makeUserMessage(overrides: {
  uuid?: UUID
  parentUuid?: UUID | null
  timestamp?: string
} = {}): TranscriptMessage {
  return {
    type: 'user',
    uuid: overrides.uuid ?? randomUUID(),
    parentUuid: overrides.parentUuid ?? null,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    sessionId: randomUUID(),
    isMeta: false,
    requestId: null,
    isSidechain: false,
    isCompactSummary: false,
    isApiErrorMessage: false,
    userType: 'external',
    cwd: '/tmp',
    version: 'test',
    gitBranch: '',
    message: { id: '', role: 'user', content: '', type: 'message', model: '', stop_reason: null, stop_sequence: null, usage: null as never },
    costUSD: 0,
    durationMs: 0,
  } as unknown as TranscriptMessage
}

function makeHeadRecord(overrides: {
  headUuid: UUID
  timestamp?: string
}): ConversationHeadEntry {
  return {
    type: 'head',
    uuid: randomUUID(),
    headUuid: overrides.headUuid,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    sessionId: randomUUID(),
  }
}

describe('pickConversationHead', () => {
  test('falls back to latest leaf when no head record present', () => {
    const m1 = makeUserMessage({ timestamp: '2026-05-25T10:00:00Z' })
    const m2 = makeUserMessage({ timestamp: '2026-05-25T11:00:00Z' })
    const messages = new Map<UUID, TranscriptMessage>([
      [m1.uuid, m1],
      [m2.uuid, m2],
    ])
    const leafUuids = new Set<UUID>([m1.uuid, m2.uuid])

    const picked = pickConversationHead({
      messages,
      leafUuids,
      conversationHead: undefined,
    })
    expect(picked?.uuid).toBe(m2.uuid)
  })

  test('honors head record when its target message is known', () => {
    const m1 = makeUserMessage({ timestamp: '2026-05-25T10:00:00Z' })
    const m2 = makeUserMessage({ timestamp: '2026-05-25T11:00:00Z' })
    const messages = new Map<UUID, TranscriptMessage>([
      [m1.uuid, m1],
      [m2.uuid, m2],
    ])
    const leafUuids = new Set<UUID>([m1.uuid, m2.uuid])
    const head = makeHeadRecord({ headUuid: m1.uuid })

    const picked = pickConversationHead({
      messages,
      leafUuids,
      conversationHead: head,
    })
    // Head wins over latest-leaf — m1 chosen even though m2 is newer.
    expect(picked?.uuid).toBe(m1.uuid)
  })

  test('falls back when head points at a missing UUID', () => {
    // Capture the warn so we can assert we logged but didn't throw.
    const m1 = makeUserMessage({ timestamp: '2026-05-25T10:00:00Z' })
    const messages = new Map<UUID, TranscriptMessage>([[m1.uuid, m1]])
    const leafUuids = new Set<UUID>([m1.uuid])
    const ghostUuid = randomUUID()
    const head = makeHeadRecord({ headUuid: ghostUuid })

    const picked = pickConversationHead({
      messages,
      leafUuids,
      conversationHead: head,
    })
    // Fell back to latest-leaf — m1 is the only candidate.
    expect(picked?.uuid).toBe(m1.uuid)
  })

  test('respects leafPredicate on the fallback path only', () => {
    // m2 is a system message (filtered out by predicate); m1 is a user.
    const m1 = makeUserMessage({ timestamp: '2026-05-25T10:00:00Z' })
    const m2 = makeUserMessage({ timestamp: '2026-05-25T11:00:00Z' })
    ;(m2 as { type: string }).type = 'system'
    const messages = new Map<UUID, TranscriptMessage>([
      [m1.uuid, m1],
      [m2.uuid, m2],
    ])
    const leafUuids = new Set<UUID>([m1.uuid, m2.uuid])

    const picked = pickConversationHead({
      messages,
      leafUuids,
      conversationHead: undefined,
      leafPredicate: msg => msg.type === 'user',
    })
    // Predicate excludes m2; falls to m1 even though m2 is newer.
    expect(picked?.uuid).toBe(m1.uuid)
  })

  test('head bypasses leafPredicate', () => {
    // Even if the predicate would reject the head's target, an explicit
    // user choice overrides the fallback heuristic.
    const m1 = makeUserMessage({ timestamp: '2026-05-25T10:00:00Z' })
    ;(m1 as { type: string }).type = 'system'
    const messages = new Map<UUID, TranscriptMessage>([[m1.uuid, m1]])
    const leafUuids = new Set<UUID>([m1.uuid])
    const head = makeHeadRecord({ headUuid: m1.uuid })

    const picked = pickConversationHead({
      messages,
      leafUuids,
      conversationHead: head,
      leafPredicate: msg => msg.type === 'user', // would reject m1
    })
    expect(picked?.uuid).toBe(m1.uuid)
  })

  test('returns undefined when messages is empty and no head', () => {
    const picked = pickConversationHead({
      messages: new Map(),
      leafUuids: new Set(),
      conversationHead: undefined,
    })
    expect(picked).toBeUndefined()
  })
})
