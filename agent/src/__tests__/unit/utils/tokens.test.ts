import { randomUUID } from 'crypto'
import { describe, expect, test } from 'vitest'

import type { Message } from '../../../types/message.js'
import {
  getCurrentUsage,
  messageTokenCountFromLastAPIResponse,
  tokenCountFromLastAPIResponse,
} from '../../../utils/tokens.js'

function assistantMessage(input: {
  id: string
  model?: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number | null
  cacheReadTokens?: number | null
}): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: '2026-05-29T00:00:00.000Z',
    message: {
      id: input.id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: input.model ?? 'provider-main-model',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        cache_creation_input_tokens: input.cacheCreationTokens ?? null,
        cache_read_input_tokens: input.cacheReadTokens ?? null,
      },
    },
  }
}

describe('token usage helpers', () => {
  test('ignore protocol placeholder zero usage and keep the latest known usage', () => {
    const messages: Message[] = [
      assistantMessage({
        id: 'anthropic-or-prior',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
      }),
      assistantMessage({
        id: 'openai-pending-final-usage',
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]

    expect(tokenCountFromLastAPIResponse(messages)).toBe(150)
    expect(messageTokenCountFromLastAPIResponse(messages)).toBe(20)
    expect(getCurrentUsage(messages)).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 30,
    })
  })

  test('accept final OpenAI Chat/Responses usage once it arrives', () => {
    const messages: Message[] = [
      assistantMessage({
        id: 'openai-final',
        inputTokens: 123,
        outputTokens: 7,
        cacheReadTokens: 10,
      }),
    ]

    expect(tokenCountFromLastAPIResponse(messages)).toBe(140)
    expect(messageTokenCountFromLastAPIResponse(messages)).toBe(7)
  })

  test('accepts Anthropic-style input usage before output tokens are known', () => {
    const messages: Message[] = [
      assistantMessage({
        id: 'anthropic-message-start',
        inputTokens: 100,
        outputTokens: 0,
      }),
    ]

    expect(tokenCountFromLastAPIResponse(messages)).toBe(100)
    expect(messageTokenCountFromLastAPIResponse(messages)).toBe(0)
    expect(getCurrentUsage(messages)).toEqual({
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  test('returns zero/null when only placeholder usage exists', () => {
    const messages: Message[] = [
      assistantMessage({
        id: 'openai-pending-final-usage',
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]

    expect(tokenCountFromLastAPIResponse(messages)).toBe(0)
    expect(messageTokenCountFromLastAPIResponse(messages)).toBe(0)
    expect(getCurrentUsage(messages)).toBeNull()
  })
})
