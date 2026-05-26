import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import { describe, expect, test } from 'vitest'

import type { TranscriptMessage } from '../../../types/logs.js'

import {
  findChainUserMessages,
  transcriptToUserMessage,
} from '../../../utils/conversationBranches.js'

function makeUserTm(opts: {
  uuid?: UUID
  parentUuid?: UUID | null
  timestamp?: string
  content?: string | Array<{ type: 'text'; text: string }>
} = {}): TranscriptMessage {
  return {
    type: 'user',
    uuid: opts.uuid ?? randomUUID(),
    parentUuid: opts.parentUuid ?? null,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    sessionId: randomUUID(),
    isSidechain: false,
    isMeta: false,
    requestId: null,
    isCompactSummary: false,
    isApiErrorMessage: false,
    userType: 'external',
    cwd: '/tmp',
    version: 'test',
    gitBranch: '',
    message: {
      id: '',
      role: 'user',
      content: opts.content ?? 'hi',
      type: 'message',
      model: '',
      stop_reason: null,
      stop_sequence: null,
      usage: null as never,
    },
    costUSD: 0,
    durationMs: 0,
  } as unknown as TranscriptMessage
}

describe('transcriptToUserMessage', () => {
  test('handles string content', () => {
    const tm = makeUserTm({ content: 'hello' })
    const um = transcriptToUserMessage(tm)
    expect(um.type).toBe('user')
    expect(um.uuid).toBe(tm.uuid)
    expect(um.message.role).toBe('user')
    expect(um.message.content).toBe('hello')
  })

  test('handles content-block array', () => {
    const tm = makeUserTm({
      content: [{ type: 'text', text: 'hi there' }],
    })
    const um = transcriptToUserMessage(tm)
    expect(Array.isArray(um.message.content)).toBe(true)
  })

  test('falls back to empty string on missing message field', () => {
    const tm = { type: 'user', uuid: randomUUID(), timestamp: 'x' } as unknown as TranscriptMessage
    const um = transcriptToUserMessage(tm)
    expect(um.type).toBe('user')
    expect(typeof um.message.content === 'string' || Array.isArray(um.message.content)).toBe(true)
  })
})

describe('findChainUserMessages', () => {
  test('returns user messages on the chain, oldest → newest', () => {
    const a = makeUserTm({ timestamp: '2026-05-25T10:00:00Z', content: 'A' })
    const aReply = {
      ...makeUserTm({ parentUuid: a.uuid, timestamp: '2026-05-25T10:00:01Z' }),
      type: 'assistant',
    } as unknown as TranscriptMessage
    const b = makeUserTm({ parentUuid: aReply.uuid, timestamp: '2026-05-25T10:01:00Z', content: 'B' })
    const bReply = {
      ...makeUserTm({ parentUuid: b.uuid, timestamp: '2026-05-25T10:01:01Z' }),
      type: 'assistant',
    } as unknown as TranscriptMessage
    const c = makeUserTm({ parentUuid: bReply.uuid, timestamp: '2026-05-25T10:02:00Z', content: 'C' })
    const cReply = {
      ...makeUserTm({ parentUuid: c.uuid, timestamp: '2026-05-25T10:02:01Z' }),
      type: 'assistant',
    } as unknown as TranscriptMessage

    const messages = new Map<UUID, TranscriptMessage>([
      [a.uuid, a], [aReply.uuid, aReply],
      [b.uuid, b], [bReply.uuid, bReply],
      [c.uuid, c], [cReply.uuid, cReply],
    ])

    const result = findChainUserMessages({
      messages,
      headLeafUuid: cReply.uuid,
    })
    expect(result.map(m => m.uuid)).toEqual([a.uuid, b.uuid, c.uuid])
  })

  test('returns empty when head is undefined', () => {
    const result = findChainUserMessages({
      messages: new Map(),
      headLeafUuid: undefined,
    })
    expect(result).toEqual([])
  })

  test('skips synthetic interrupt placeholders', () => {
    const a = makeUserTm({ timestamp: '2026-05-25T10:00:00Z', content: 'A' })
    const interrupt = makeUserTm({
      parentUuid: a.uuid,
      timestamp: '2026-05-25T10:00:30Z',
      content: [{ type: 'text', text: '[Request interrupted by user]' }],
    })
    const b = makeUserTm({ parentUuid: interrupt.uuid, timestamp: '2026-05-25T10:01:00Z', content: 'B' })

    const messages = new Map<UUID, TranscriptMessage>([
      [a.uuid, a], [interrupt.uuid, interrupt], [b.uuid, b],
    ])

    const result = findChainUserMessages({
      messages,
      headLeafUuid: b.uuid,
    })
    // Interrupt sentinel filtered out; A and B remain.
    expect(result.map(m => m.uuid)).toEqual([a.uuid, b.uuid])
  })

  test('handles missing ancestors (chain cut by snip / compact)', () => {
    const orphan = makeUserTm({
      parentUuid: randomUUID(), // unknown parent
      timestamp: '2026-05-25T10:00:00Z',
      content: 'lonely',
    })
    const messages = new Map<UUID, TranscriptMessage>([[orphan.uuid, orphan]])
    const result = findChainUserMessages({
      messages,
      headLeafUuid: orphan.uuid,
    })
    expect(result.map(m => m.uuid)).toEqual([orphan.uuid])
  })

  test('cycle guard — refuses to walk a parentUuid cycle', () => {
    const a = makeUserTm({ timestamp: '2026-05-25T10:00:00Z' })
    const b = makeUserTm({ parentUuid: a.uuid, timestamp: '2026-05-25T10:01:00Z' })
    ;(a as { parentUuid: UUID }).parentUuid = b.uuid // pathological cycle
    const messages = new Map<UUID, TranscriptMessage>([[a.uuid, a], [b.uuid, b]])
    expect(() =>
      findChainUserMessages({ messages, headLeafUuid: b.uuid }),
    ).not.toThrow()
  })
})
