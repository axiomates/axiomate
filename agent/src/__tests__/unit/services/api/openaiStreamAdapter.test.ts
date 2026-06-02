import { describe, expect, it } from 'vitest'
import {
  OpenAIStreamState,
  type OpenAIChatChunk,
} from '../../../../services/api/adapters/openaiStreamAdapter.js'
import { LLMAPIError } from '../../../../services/api/streamTypes.js'

describe('OpenAIStreamState malformed chunk defense', () => {
  // Some OpenAI-compatible proxies emit chunks missing `choices` or with
  // inline error envelopes. Pre-fix these crashed with a TypeError ("undefined
  // is not an object (evaluating 'response.choices[0]')") that classifyError
  // couldn't route through the harness — surface as LLMAPIError(502) so
  // withRetry classifies as server_error and retries.
  it('does not crash on chunk with missing choices', () => {
    const state = new OpenAIStreamState()
    // Cast through unknown because the type forces `choices` to be present.
    const events = state.mapChunk({
      id: 'chatcmpl_bad',
      model: 'deepseek-v4-pro',
    } as unknown as OpenAIChatChunk)
    // We still emit response_start so downstream accumulator stays consistent.
    expect(events.find(e => e.type === 'response_start')).toBeTruthy()
  })

  it('does not crash on chunk with non-array choices', () => {
    const state = new OpenAIStreamState()
    const events = state.mapChunk({
      id: 'chatcmpl_bad',
      model: 'deepseek-v4-pro',
      choices: null,
    } as unknown as OpenAIChatChunk)
    expect(events.find(e => e.type === 'response_start')).toBeTruthy()
  })

  it('throws LLMAPIError(502) on inline error envelope', () => {
    const state = new OpenAIStreamState()
    expect(() =>
      state.mapChunk({
        error: { message: 'upstream timeout', code: 'gateway_timeout' },
      } as unknown as OpenAIChatChunk),
    ).toThrow(LLMAPIError)

    try {
      state.mapChunk({
        error: { message: 'upstream timeout' },
      } as unknown as OpenAIChatChunk)
    } catch (e) {
      expect(e).toBeInstanceOf(LLMAPIError)
      expect((e as LLMAPIError).status).toBe(502)
      expect((e as LLMAPIError).message).toContain('upstream timeout')
    }
  })
})

describe('OpenAIStreamState usage mapping', () => {
  it('maps cache usage from OpenAI-compatible stream chunks', () => {
    const state = new OpenAIStreamState()
    const events = state.mapChunk({
      id: 'chatcmpl_test',
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: {
          cached_tokens: 400,
        },
      },
    } as OpenAIChatChunk)

    const responseDelta = events.find(event => event.type === 'response_delta')
    expect(responseDelta?.type === 'response_delta' ? responseDelta.usage : null)
      .toEqual({
        inputTokens: 600,
        outputTokens: 50,
        cacheReadTokens: 400,
      })
  })

  it('emits no final usage while waiting for the OpenAI usage-only chunk', () => {
    const state = new OpenAIStreamState()
    const events = state.mapChunk({
      id: 'chatcmpl_test',
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
    } as OpenAIChatChunk)

    const responseDelta = events.find(event => event.type === 'response_delta')
    expect(responseDelta?.type === 'response_delta' ? responseDelta.usage : null)
      .toEqual({
        inputTokens: 0,
        outputTokens: 0,
      })
  })

  it('emits final usage from a later OpenAI usage-only chunk', () => {
    const state = new OpenAIStreamState()
    state.mapChunk({
      id: 'chatcmpl_test',
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
    } as OpenAIChatChunk)

    const events = state.mapChunk({
      id: 'chatcmpl_test',
      model: 'deepseek-v4-pro',
      choices: [],
      usage: {
        prompt_tokens: 123,
        completion_tokens: 7,
        total_tokens: 130,
      },
    } as OpenAIChatChunk)

    const responseDelta = events.find(event => event.type === 'response_delta')
    expect(responseDelta?.type === 'response_delta' ? responseDelta.usage : null)
      .toEqual({
        inputTokens: 123,
        outputTokens: 7,
      })
  })
})

describe('OpenAIStreamState tool_use lifecycle', () => {
  // Regression for the duplicate-tool_use-id bug observed on Qwen 3.6 Plus
  // (and earlier MiniMax M2.7 via NVIDIA): every tool-calling assistant turn
  // produced tool_uses=[X,X] with identical ids, doubling dispatch.
  //
  // Root cause: finish_reason emitted block_stop for each tool block but did
  // NOT clear toolBlockIndices, so flush() (called when the SDK iterator
  // returns done=true after [DONE]) iterated the same map again and emitted
  // a second block_stop. streamAccumulator turned both into separate
  // AssistantMessages, then normalizeMessagesForAPI merged them by message.id
  // into one message with the tool_use repeated — symptom: dispatch executes
  // the same screenshot twice per turn.
  it('emits exactly one block_stop per tool_use across finish_reason + flush', () => {
    const state = new OpenAIStreamState()

    // Chunk 1: opening with id+name
    state.mapChunk({
      id: 'chatcmpl_tc',
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_abc',
                type: 'function',
                function: { name: 'screenshot', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    } as OpenAIChatChunk)

    // Chunk 2: argument fragment
    state.mapChunk({
      id: 'chatcmpl_tc',
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    } as OpenAIChatChunk)

    // Chunk 3: finish_reason='tool_calls' — emits first round of block_stops
    const finishEvents = state.mapChunk({
      id: 'chatcmpl_tc',
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        },
      ],
    } as OpenAIChatChunk)

    // After [DONE] the provider calls flush(). Pre-fix this re-iterated
    // toolBlockIndices and emitted a duplicate block_stop.
    const flushEvents = state.flush()

    const allBlockStops = [...finishEvents, ...flushEvents].filter(
      e => e.type === 'block_stop',
    )
    expect(allBlockStops.length).toBe(1)
    if (allBlockStops[0]?.type === 'block_stop') {
      // The only block_stop is for the tool_use block (block index 0; this
      // session has no preceding text/thinking, so the tool gets index 0).
      expect(allBlockStops[0].index).toBe(0)
    }
  })
})

describe('OpenAIStreamState thinking lifecycle', () => {
  // Mirror of the tool_use regression. Pre-fix (text-content branch missing
  // hasThinkingBlock=false), the lifecycle thinking → text → finish_reason
  // emitted block_stop[thinking] twice: once when text opened (closing
  // thinking explicitly), once again at finish_reason because the boolean
  // flag was never cleared. streamAccumulator pushed two AssistantMessages
  // for the same response.id, which normalizeMessagesForAPI later merged
  // into [thinking, thinking, text].
  //
  // Currently the duplicate is invisible on the OpenAI wire (the request
  // adapter strips thinking blocks entirely) but the latent bug remains
  // a problem for any future code path that propagates thinking — keep
  // this regression test in place as the contract.
  it('emits exactly one block_stop per thinking block across thinking→text→finish_reason→flush', () => {
    const state = new OpenAIStreamState()
    const allEvents: ReturnType<typeof state.mapChunk> = []

    // Chunk 1: reasoning_content opens thinking
    allEvents.push(
      ...state.mapChunk({
        id: 'chatcmpl_thinking',
        model: 'deepseek-v4-pro',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: 'Let me think...' },
            finish_reason: null,
          },
        ],
      } as OpenAIChatChunk),
    )

    // Chunk 2: text content arrives — adapter closes thinking + opens text
    // (this is where pre-fix dropped the hasThinkingBlock=false clear)
    allEvents.push(
      ...state.mapChunk({
        id: 'chatcmpl_thinking',
        model: 'deepseek-v4-pro',
        choices: [
          {
            index: 0,
            delta: { content: 'Hello' },
            finish_reason: null,
          },
        ],
      } as OpenAIChatChunk),
    )

    // Chunk 3: finish_reason='stop'
    allEvents.push(
      ...state.mapChunk({
        id: 'chatcmpl_thinking',
        model: 'deepseek-v4-pro',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      } as OpenAIChatChunk),
    )

    allEvents.push(...state.flush())

    const blockStopsByIndex = allEvents
      .filter(e => e.type === 'block_stop')
      .map(e => (e.type === 'block_stop' ? e.index : -1))

    // Exactly two block_stops: thinking (idx 0) once when text opens,
    // text (idx 1) once at finish_reason. No duplicate at finish_reason
    // for thinking, no duplicate at flush() for either.
    expect(blockStopsByIndex.length).toBe(2)
    expect(blockStopsByIndex.filter(idx => idx === 0).length).toBe(1)
    expect(blockStopsByIndex.filter(idx => idx === 1).length).toBe(1)
  })

  it('maps content thinking parts from OpenAI-compatible stream chunks', () => {
    const state = new OpenAIStreamState()
    const events = state.mapChunk({
      id: 'chatcmpl_content_thinking',
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Need to inspect state.' },
              { type: 'text', text: 'Done.' },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    } as OpenAIChatChunk)

    expect(events).toEqual([
      expect.objectContaining({ type: 'response_start' }),
      {
        type: 'block_start',
        index: 0,
        block: {
          type: 'thinking',
          thinking: '',
          roundTrip: { provider: 'none' },
        },
      },
      {
        type: 'block_delta',
        index: 0,
        delta: { type: 'thinking', thinking: 'Need to inspect state.' },
      },
      { type: 'block_stop', index: 0 },
      {
        type: 'block_start',
        index: 1,
        block: { type: 'text', text: '' },
      },
      {
        type: 'block_delta',
        index: 1,
        delta: { type: 'text', text: 'Done.' },
      },
      { type: 'block_stop', index: 1 },
      {
        type: 'response_delta',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      { type: 'response_stop' },
    ])
  })
})
