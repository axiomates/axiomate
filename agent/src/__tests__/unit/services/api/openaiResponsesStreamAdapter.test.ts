import { describe, it, expect } from 'vitest'
import { OpenAIResponsesStreamState } from '../../../../services/api/adapters/openaiResponsesStreamAdapter.js'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { LLMAPIError, type StreamEvent } from '../../../../services/api/streamTypes.js'

function consume(state: OpenAIResponsesStreamState, events: ResponseStreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = []
  for (const e of events) {
    out.push(...state.mapEvent(e))
  }
  out.push(...state.flush())
  return out
}

describe('OpenAIResponsesStreamState — text-only response', () => {
  it('response.created → response_start with id/model', () => {
    const state = new OpenAIResponsesStreamState()
    const out = state.mapEvent({
      type: 'response.created',
      response: { id: 'resp_1', model: 'o4-mini' },
      sequence_number: 0,
    } as any)
    expect(out[0]).toMatchObject({
      type: 'response_start',
      response: { id: 'resp_1', model: 'o4-mini' },
    })
  })

  it('full text-only flow: created → message added → text deltas → done → completed', () => {
    const state = new OpenAIResponsesStreamState()
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_1', model: 'o4-mini' },
        sequence_number: 0,
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { type: 'message', id: 'msg_1', role: 'assistant', content: [], status: 'in_progress' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
        delta: 'Hello',
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        sequence_number: 3,
        delta: ' world',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 4,
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello world' }],
        },
      },
      {
        type: 'response.completed',
        sequence_number: 5,
        response: {
          id: 'resp_1',
          model: 'o4-mini',
          status: 'completed',
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 12,
          },
        },
      },
    ] as any[]

    const out = consume(state, events)

    // response_start, block_start(text), 2x block_delta(text), block_stop, response_delta, response_stop
    expect(out).toHaveLength(7)
    expect(out[0].type).toBe('response_start')
    expect(out[1]).toMatchObject({
      type: 'block_start',
      block: { type: 'text', text: '' },
    })
    expect(out[2]).toMatchObject({
      type: 'block_delta',
      delta: { type: 'text', text: 'Hello' },
    })
    expect(out[3]).toMatchObject({
      type: 'block_delta',
      delta: { type: 'text', text: ' world' },
    })
    expect(out[4]).toMatchObject({ type: 'block_stop' })
    expect(out[5]).toMatchObject({
      type: 'response_delta',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    expect(out[6]).toMatchObject({ type: 'response_stop' })
  })
})

describe('OpenAIResponsesStreamState — function call', () => {
  it('function_call output_item with arguments deltas → tool_use block_start + tool_input deltas + block_stop', () => {
    const state = new OpenAIResponsesStreamState()
    const events = [
      {
        type: 'response.created',
        response: { id: 'r1', model: 'o4-mini' },
        sequence_number: 0,
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_xyz',
          name: 'do_thing',
          arguments: '',
          status: 'in_progress',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        sequence_number: 2,
        delta: '{"a":',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        sequence_number: 3,
        delta: '1}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 4,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_xyz',
          name: 'do_thing',
          arguments: '{"a":1}',
          status: 'completed',
        },
      },
    ] as any[]
    const out = consume(state, events)

    // response_start, block_start(tool_use), 2x tool_input deltas, block_stop
    expect(out).toHaveLength(5)
    expect(out[1]).toMatchObject({
      type: 'block_start',
      block: { type: 'tool_use', id: 'call_xyz', name: 'do_thing' },
    })
    expect(out[2]).toMatchObject({
      type: 'block_delta',
      delta: { type: 'tool_input', json: '{"a":' },
    })
    expect(out[3]).toMatchObject({
      type: 'block_delta',
      delta: { type: 'tool_input', json: '1}' },
    })
    expect(out[4]).toMatchObject({ type: 'block_stop' })
  })
})

describe('OpenAIResponsesStreamState — reasoning items', () => {
  it('reasoning item: summary part deltas + done → emits thinking deltas + thinking_round_trip metadata + block_stop', () => {
    const state = new OpenAIResponsesStreamState()
    const events = [
      {
        type: 'response.created',
        response: { id: 'r1', model: 'o4-mini' },
        sequence_number: 0,
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [],
        },
      },
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 2,
        part: { type: 'summary_text', text: '' },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 3,
        delta: 'Thinking',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 4,
        delta: ' about it.',
      },
      {
        type: 'response.reasoning_summary_part.done',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 5,
        part: { type: 'summary_text', text: 'Thinking about it.' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 6,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Thinking about it.' }],
          encrypted_content: 'ENC_XYZ',
        },
      },
    ] as any[]
    const out = consume(state, events)

    // response_start, block_start(thinking), 2x thinking deltas, thinking_round_trip delta, block_stop
    expect(out).toHaveLength(6)
    expect(out[1]).toMatchObject({
      type: 'block_start',
      block: {
        type: 'thinking',
        thinking: '',
        roundTrip: { provider: 'none' },
      },
    })
    expect(out[2]).toMatchObject({
      type: 'block_delta',
      delta: { type: 'thinking', thinking: 'Thinking' },
    })
    expect(out[3]).toMatchObject({
      type: 'block_delta',
      delta: { type: 'thinking', thinking: ' about it.' },
    })
    expect(out[4]).toMatchObject({
      type: 'block_delta',
      delta: {
        type: 'thinking_round_trip',
        roundTrip: {
          provider: 'openai-responses',
          id: 'rs_1',
          encryptedContent: 'ENC_XYZ',
          summaryParts: ['Thinking about it.'],
        },
      },
    })
    expect(out[5]).toMatchObject({ type: 'block_stop' })
  })
})

describe('OpenAIResponsesStreamState — error events', () => {
  it('response.failed → throws LLMAPIError', () => {
    const state = new OpenAIResponsesStreamState()
    expect(() =>
      state.mapEvent({
        type: 'response.failed',
        sequence_number: 0,
        response: {
          id: 'r1',
          status: 'failed',
          error: { code: 'server_error', message: 'overloaded' },
        },
      } as any),
    ).toThrow(LLMAPIError)
  })

  it('response.incomplete → throws LLMAPIError', () => {
    const state = new OpenAIResponsesStreamState()
    expect(() =>
      state.mapEvent({
        type: 'response.incomplete',
        sequence_number: 0,
        response: {
          id: 'r1',
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
        },
      } as any),
    ).toThrow(LLMAPIError)
  })
})

describe('OpenAIResponsesStreamState — usage mapping', () => {
  it('extracts input/output/cache tokens from response.completed', () => {
    const state = new OpenAIResponsesStreamState()
    state.mapEvent({
      type: 'response.created',
      response: { id: 'r1', model: 'o4-mini' },
      sequence_number: 0,
    } as any)
    const out = state.mapEvent({
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: 'r1',
        model: 'o4-mini',
        status: 'completed',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens_details: { reasoning_tokens: 20 },
          total_tokens: 150,
        },
      },
    } as any)

    expect(out[0]).toMatchObject({
      type: 'response_delta',
      stopReason: 'end_turn',
      // inputTokens = input_tokens (100) - cached_tokens (30) = 70
      usage: {
        inputTokens: 70,
        outputTokens: 50,
        cacheReadTokens: 30,
      },
    })
  })
})
