import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import { describe, expect, test } from 'vitest'

import type { TranscriptMessage } from '../../types/logs.js'

import {
  buildAbandonedRow,
  buildHeadChainUuids,
  findAbandonedLeafChains,
  transcriptToUserMessage,
} from '../conversationBranches.js'

function makeUserTm(opts: {
  uuid?: UUID
  parentUuid?: UUID | null
  timestamp?: string
  content?: string | Array<{ type: 'text'; text: string }>
}): TranscriptMessage {
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
    // Simulate a malformed transcript entry — picker shouldn't crash.
    const tm = { type: 'user', uuid: randomUUID(), timestamp: 'x' } as unknown as TranscriptMessage
    const um = transcriptToUserMessage(tm)
    expect(um.type).toBe('user')
    // createUserMessage falls back to NO_CONTENT_MESSAGE when content is empty.
    expect(typeof um.message.content === 'string' || Array.isArray(um.message.content)).toBe(true)
  })
})

describe('buildAbandonedRow', () => {
  test('formats short string content with ↶ Before "X" [hash]', () => {
    const tm = makeUserTm({ content: 'hello there' })
    const row = buildAbandonedRow(tm)
    const content = row.message.content as string
    expect(content).toBe(`↶ Before "hello there" [${tm.uuid.slice(0, 7)}]`)
    // Row keeps the real message uuid so handlers can route back to JSONL.
    expect(row.uuid).toBe(tm.uuid)
    // Same timestamp so chronological merge with current-chain rows works.
    expect(row.timestamp).toBe(tm.timestamp)
  })

  test('truncates >60 chars with ellipsis', () => {
    const long = 'a'.repeat(80)
    const tm = makeUserTm({ content: long })
    const row = buildAbandonedRow(tm)
    const content = row.message.content as string
    // Preview part should be 60 chars + ellipsis
    expect(content).toContain('a'.repeat(60) + '…')
    expect(content).not.toContain('a'.repeat(61))
  })

  test('collapses whitespace into single spaces (one-line label)', () => {
    const tm = makeUserTm({ content: 'multi\n\nline\twith   space' })
    const row = buildAbandonedRow(tm)
    const content = row.message.content as string
    expect(content).toContain('"multi line with space"')
  })

  test('falls back to placeholder for empty content', () => {
    const tm = makeUserTm({ content: '' })
    const row = buildAbandonedRow(tm)
    const content = row.message.content as string
    expect(content).toContain('"(empty prompt)"')
  })

  test('extracts last text block from content-block-array content', () => {
    const tm = makeUserTm({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    })
    const row = buildAbandonedRow(tm)
    const content = row.message.content as string
    // Mirror UserMessageOption's "last text block" rule
    expect(content).toContain('"second"')
  })
})

describe('findAbandonedLeafChains', () => {
  test('no abandoned leaves when only one chain exists', () => {
    const m1 = makeUserTm({ timestamp: '2026-05-25T10:00:00Z' })
    const m2 = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T10:01:00Z' })
    const messages = new Map<UUID, TranscriptMessage>([[m1.uuid, m1], [m2.uuid, m2]])
    const leafUuids = new Set<UUID>([m2.uuid])
    const headChainUuids = buildHeadChainUuids(messages, m2.uuid)
    const result = findAbandonedLeafChains({
      messages,
      leafUuids,
      headChainUuids,
      headLeafUuid: m2.uuid,
    })
    expect(result).toEqual([])
  })

  test('single abandoned branch — walks back to divergence point', () => {
    // m1 -> m2 (current) and m1 -> m3 (abandoned)
    const m1 = makeUserTm({ timestamp: '2026-05-25T10:00:00Z', content: 'shared' })
    const m2 = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T10:05:00Z', content: 'current' })
    const m3 = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T10:03:00Z', content: 'abandoned' })
    const messages = new Map<UUID, TranscriptMessage>([
      [m1.uuid, m1],
      [m2.uuid, m2],
      [m3.uuid, m3],
    ])
    const leafUuids = new Set<UUID>([m2.uuid, m3.uuid])
    const headChainUuids = buildHeadChainUuids(messages, m2.uuid)
    const result = findAbandonedLeafChains({
      messages,
      leafUuids,
      headChainUuids,
      headLeafUuid: m2.uuid,
    })
    expect(result.length).toBe(1)
    expect(result[0]!.leafUuid).toBe(m3.uuid)
    // Chain should contain only m3 — m1 is shared with the head chain.
    expect(result[0]!.chain.length).toBe(1)
    expect(result[0]!.chain[0]!.uuid).toBe(m3.uuid)
  })

  test('multiple abandoned leaves sort newest first', () => {
    const m1 = makeUserTm({ timestamp: '2026-05-25T10:00:00Z' })
    const cur = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T11:00:00Z' })
    const ab1 = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T10:30:00Z' })
    const ab2 = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T10:45:00Z' })
    const messages = new Map<UUID, TranscriptMessage>([
      [m1.uuid, m1], [cur.uuid, cur], [ab1.uuid, ab1], [ab2.uuid, ab2],
    ])
    const leafUuids = new Set<UUID>([cur.uuid, ab1.uuid, ab2.uuid])
    const headChainUuids = buildHeadChainUuids(messages, cur.uuid)
    const result = findAbandonedLeafChains({
      messages,
      leafUuids,
      headChainUuids,
      headLeafUuid: cur.uuid,
    })
    expect(result.length).toBe(2)
    // Newer abandoned leaf comes first.
    expect(result[0]!.leafUuid).toBe(ab2.uuid)
    expect(result[1]!.leafUuid).toBe(ab1.uuid)
  })

  test('skips assistant-typed messages in abandoned chain', () => {
    const m1 = makeUserTm({ timestamp: '2026-05-25T10:00:00Z' })
    const cur = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T11:00:00Z' })
    const abAssistant = {
      ...makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T10:30:00Z' }),
      type: 'assistant',
    } as unknown as TranscriptMessage
    const abUser = makeUserTm({
      parentUuid: abAssistant.uuid,
      timestamp: '2026-05-25T10:31:00Z',
    })
    const messages = new Map<UUID, TranscriptMessage>([
      [m1.uuid, m1], [cur.uuid, cur], [abAssistant.uuid, abAssistant], [abUser.uuid, abUser],
    ])
    const leafUuids = new Set<UUID>([cur.uuid, abUser.uuid])
    const headChainUuids = buildHeadChainUuids(messages, cur.uuid)
    const result = findAbandonedLeafChains({
      messages,
      leafUuids,
      headChainUuids,
      headLeafUuid: cur.uuid,
    })
    expect(result.length).toBe(1)
    // Only the user message survives the user-only filter.
    expect(result[0]!.chain.length).toBe(1)
    expect(result[0]!.chain[0]!.uuid).toBe(abUser.uuid)
  })

  test('previewUserMessage is the user prompt, not the AI reply, when leaf is assistant', () => {
    // The natural shape of an abandoned chain after a rewind: the user
    // sent a prompt, AI replied, and the user rewound — leaf is the AI
    // reply (assistant), but the row should preview the user's prompt.
    const m1 = makeUserTm({ timestamp: '2026-05-25T10:00:00Z', content: 'shared' })
    const cur = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T11:00:00Z', content: 'current' })
    const abPrompt = makeUserTm({
      parentUuid: m1.uuid,
      timestamp: '2026-05-25T10:30:00Z',
      content: 'tell me a joke',
    })
    const abReply = {
      ...makeUserTm({
        parentUuid: abPrompt.uuid,
        timestamp: '2026-05-25T10:31:00Z',
      }),
      type: 'assistant',
    } as unknown as TranscriptMessage
    const messages = new Map<UUID, TranscriptMessage>([
      [m1.uuid, m1],
      [cur.uuid, cur],
      [abPrompt.uuid, abPrompt],
      [abReply.uuid, abReply],
    ])
    const leafUuids = new Set<UUID>([cur.uuid, abReply.uuid])
    const headChainUuids = buildHeadChainUuids(messages, cur.uuid)
    const result = findAbandonedLeafChains({
      messages,
      leafUuids,
      headChainUuids,
      headLeafUuid: cur.uuid,
    })
    expect(result.length).toBe(1)
    // Leaf was the AI reply, preview should be the user's prompt.
    expect(result[0]!.leafUuid).toBe(abReply.uuid)
    expect(result[0]!.previewUserMessage.uuid).toBe(abPrompt.uuid)
    expect(result[0]!.previewUserMessage.type).toBe('user')
  })

  test('handles missing parent gracefully (orphan leaf)', () => {
    // Abandoned leaf whose parent is unknown — walk should stop, not crash.
    const m1 = makeUserTm({ timestamp: '2026-05-25T10:00:00Z' })
    const cur = makeUserTm({ parentUuid: m1.uuid, timestamp: '2026-05-25T11:00:00Z' })
    const orphan = makeUserTm({
      parentUuid: randomUUID(), // points at nothing in the Map
      timestamp: '2026-05-25T10:30:00Z',
    })
    const messages = new Map<UUID, TranscriptMessage>([
      [m1.uuid, m1], [cur.uuid, cur], [orphan.uuid, orphan],
    ])
    const leafUuids = new Set<UUID>([cur.uuid, orphan.uuid])
    const headChainUuids = buildHeadChainUuids(messages, cur.uuid)
    const result = findAbandonedLeafChains({
      messages,
      leafUuids,
      headChainUuids,
      headLeafUuid: cur.uuid,
    })
    expect(result.length).toBe(1)
    expect(result[0]!.chain.length).toBe(1)
  })

  test('infinite-loop guard — refuses to walk a parentUuid cycle', () => {
    const a = makeUserTm({ timestamp: '2026-05-25T10:00:00Z' })
    const b = makeUserTm({ parentUuid: a.uuid, timestamp: '2026-05-25T10:01:00Z' })
    // Pathological: a's parentUuid points back at b. Real transcripts never
    // produce this, but the seen-set guard is what makes the walk safe.
    const aMutable = a as { parentUuid: UUID }
    aMutable.parentUuid = b.uuid
    const cur = makeUserTm({ parentUuid: a.uuid, timestamp: '2026-05-25T11:00:00Z' })
    const messages = new Map<UUID, TranscriptMessage>([
      [a.uuid, a], [b.uuid, b], [cur.uuid, cur],
    ])
    const leafUuids = new Set<UUID>([cur.uuid, b.uuid])
    const headChainUuids = buildHeadChainUuids(messages, cur.uuid)
    expect(() =>
      findAbandonedLeafChains({
        messages,
        leafUuids,
        headChainUuids,
        headLeafUuid: cur.uuid,
      }),
    ).not.toThrow()
  })
})
