import { randomUUID } from 'crypto'
import { describe, expect, test } from 'vitest'

import type { ContentBlock } from '../../../../services/api/streamTypes.js'
import {
  getLastKnownAgentTokenCount,
  getLastKnownAgentUsage,
} from '../../../../tools/AgentTool/agentUsage.js'
import type { Message } from '../../../../types/message.js'

function assistantMessage(input: {
  content: ContentBlock[]
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number | null
  cacheReadTokens?: number | null
}): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: '2026-06-08T00:00:00.000Z',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      content: input.content,
      model: 'test-model',
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

describe('agent usage helpers', () => {
  test('uses the latest known usage instead of a trailing zero placeholder', () => {
    const messages = [
      assistantMessage({
        content: [{ type: 'text', text: 'started' }],
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
      }),
      assistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { file_path: 'src/a.ts' },
          },
        ],
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]

    expect(getLastKnownAgentTokenCount(messages)).toBe(150)
    expect(getLastKnownAgentUsage(messages)).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
    })
  })
})
