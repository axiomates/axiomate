import { describe, it, expect, vi } from 'vitest'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  anthropicStreamAdapter,
  mapStopReason,
  mapContentBlock,
  mapDelta,
  mapUsage,
  mapResponse,
} from '../../../../services/api/adapters/anthropicStreamAdapter.js'
import type { StreamEvent } from '../../../../services/api/streamTypes.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* mockStream(
  events: BetaRawMessageStreamEvent[],
): AsyncGenerator<BetaRawMessageStreamEvent> {
  for (const e of events) yield e
}

async function collect(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const result: StreamEvent[] = []
  for await (const e of gen) result.push(e)
  return result
}

const BASE_MESSAGE: BetaMessage = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  content: [],
  model: 'provider-main-model',
  stop_reason: null,
  stop_sequence: null,
  usage: {
    input_tokens: 100,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  },
}

// ---------------------------------------------------------------------------
// mapStopReason
// ---------------------------------------------------------------------------

describe('mapStopReason', () => {
  it('maps end_turn', () => expect(mapStopReason('end_turn')).toBe('end_turn'))
  it('maps tool_use', () => expect(mapStopReason('tool_use')).toBe('tool_use'))
  it('maps max_tokens', () => expect(mapStopReason('max_tokens')).toBe('max_tokens'))
  it('maps null', () => expect(mapStopReason(null)).toBeNull())
  it('passes through unknown reasons', () =>
    expect(mapStopReason('stop_sequence' as any)).toBe('stop_sequence'))
  it('maps stop_sequence', () => expect(mapStopReason('stop_sequence' as any)).toBe('stop_sequence'))
  it('maps content_filter', () => expect(mapStopReason('content_filter' as any)).toBe('content_filter'))
  it('maps unknown value (e.g. refusal) to end_turn', () =>
    expect(mapStopReason('refusal' as any)).toBe('end_turn'))
})

// ---------------------------------------------------------------------------
// mapContentBlock
// ---------------------------------------------------------------------------

describe('mapContentBlock', () => {
  it('maps text block', () => {
    expect(mapContentBlock({ type: 'text', text: 'hello', citations: null }))
      .toEqual({ type: 'text', text: 'hello' })
  })

  it('maps tool_use block', () => {
    expect(mapContentBlock({
      type: 'tool_use',
      id: 'toolu_01',
      name: 'Read',
      input: { path: '/a' },
    })).toEqual({
      type: 'tool_use',
      id: 'toolu_01',
      name: 'Read',
      input: { path: '/a' },
    })
  })

  it('maps thinking block', () => {
    expect(mapContentBlock({
      type: 'thinking',
      thinking: 'hmm',
      signature: 'sig',
    })).toEqual({
      type: 'thinking',
      thinking: 'hmm',
      roundTrip: { provider: 'anthropic', signature: 'sig' },
    })
  })

  it('maps server_tool_use block', () => {
    expect(mapContentBlock({ type: 'server_tool_use', id: 'x', name: 'y', input: {} }))
      .toEqual({ type: 'server_tool_use', id: 'x', name: 'y', input: {} })
  })

  it('maps redacted_thinking block', () => {
    expect(mapContentBlock({ type: 'redacted_thinking', data: 'abc' }))
      .toEqual({ type: 'redacted_thinking', data: 'abc' })
  })

  it('maps unknown block types to server_tool_result fallback', () => {
    const result = mapContentBlock({ type: 'web_search_tool_result', id: 'ws_01', tool_use_id: 'tu_01', content: [{ type: 'web_search_result' }] })
    expect(result.type).toBe('server_tool_result')
  })
})

// ---------------------------------------------------------------------------
// mapDelta
// ---------------------------------------------------------------------------

describe('mapDelta', () => {
  it('maps text_delta', () => {
    expect(mapDelta({ type: 'text_delta', text: 'hi' }))
      .toEqual({ type: 'text', text: 'hi' })
  })

  it('maps input_json_delta', () => {
    expect(mapDelta({ type: 'input_json_delta', partial_json: '{"x":1}' }))
      .toEqual({ type: 'tool_input', json: '{"x":1}' })
  })

  it('maps thinking_delta', () => {
    expect(mapDelta({ type: 'thinking_delta', thinking: 'let me think' }))
      .toEqual({ type: 'thinking', thinking: 'let me think' })
  })

  it('maps signature_delta', () => {
    expect(mapDelta({ type: 'signature_delta', signature: 'abc' }))
      .toEqual({
        type: 'thinking_round_trip',
        roundTrip: { provider: 'anthropic', signature: 'abc' },
      })
  })

  it('maps citations_delta', () => {
    expect(mapDelta({ type: 'citations_delta', citation: { url: 'https://example.com' } }))
      .toEqual({ type: 'citations', citation: { url: 'https://example.com' } })
  })

  it('returns null for unknown delta', () => {
    expect(mapDelta({ type: 'future_delta' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// mapUsage
// ---------------------------------------------------------------------------

describe('mapUsage', () => {
  it('maps basic token counts', () => {
    expect(mapUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    })).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('includes cache fields when present', () => {
    expect(mapUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 80,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheWriteTokens: 20,
      cacheReadTokens: 80,
    })
  })
})

// ---------------------------------------------------------------------------
// anthropicStreamAdapter (integration)
// ---------------------------------------------------------------------------

describe('anthropicStreamAdapter', () => {
  it('converts a full Anthropic event sequence to neutral events', async () => {
    const events: BetaRawMessageStreamEvent[] = [
      { type: 'message_start', message: BASE_MESSAGE } as any,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } } as any,
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } as any,
      { type: 'content_block_stop', index: 0 } as any,
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } as any,
      { type: 'message_stop' } as any,
    ]

    const result = await collect(anthropicStreamAdapter(mockStream(events)))

    expect(result).toHaveLength(6)
    expect(result[0]).toMatchObject({ type: 'response_start' })
    expect(result[1]).toMatchObject({ type: 'block_start', index: 0, block: { type: 'text' } })
    expect(result[2]).toMatchObject({ type: 'block_delta', index: 0, delta: { type: 'text', text: 'hello' } })
    expect(result[3]).toMatchObject({ type: 'block_stop', index: 0 })
    expect(result[4]).toMatchObject({ type: 'response_delta', stopReason: 'end_turn' })
    expect(result[5]).toMatchObject({ type: 'response_stop' })
  })

  it('calls onRawEvent for each event', async () => {
    const events: BetaRawMessageStreamEvent[] = [
      { type: 'message_start', message: BASE_MESSAGE } as any,
      { type: 'message_stop' } as any,
    ]
    const onRaw = vi.fn()

    await collect(anthropicStreamAdapter(mockStream(events), onRaw))

    expect(onRaw).toHaveBeenCalledTimes(2)
    expect(onRaw).toHaveBeenCalledWith(events[0])
    expect(onRaw).toHaveBeenCalledWith(events[1])
  })

  it('yields citations_delta as block_delta', async () => {
    const events: BetaRawMessageStreamEvent[] = [
      { type: 'message_start', message: BASE_MESSAGE } as any,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } } as any,
      { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://example.com' } } } as any,
      { type: 'content_block_stop', index: 0 } as any,
      { type: 'message_stop' } as any,
    ]

    const result = await collect(anthropicStreamAdapter(mockStream(events)))
    expect(result).toHaveLength(5)
    expect(result.map(e => e.type)).toEqual([
      'response_start',
      'block_start',
      'block_delta',
      'block_stop',
      'response_stop',
    ])
    expect(result[2]).toMatchObject({
      type: 'block_delta',
      index: 0,
      delta: { type: 'citations', citation: { url: 'https://example.com' } },
    })
  })
})
