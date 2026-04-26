import { describe, expect, it } from 'vitest'
import {
  OpenAIStreamState,
  type OpenAIChatChunk,
} from '../adapters/openaiStreamAdapter.js'

describe('OpenAIStreamState usage mapping', () => {
  it('maps cache usage from OpenAI-compatible stream chunks', () => {
    const state = new OpenAIStreamState()
    const events = state.mapChunk({
      id: 'chatcmpl_test',
      model: 'qwen3.6-plus',
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
      model: 'qwen3.6-plus',
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
      model: 'qwen3.6-plus',
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
      model: 'qwen3.6-plus',
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
