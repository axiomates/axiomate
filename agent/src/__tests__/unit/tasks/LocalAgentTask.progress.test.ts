import { randomUUID } from 'crypto'
import { describe, expect, test } from 'vitest'

import {
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from '../../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { ContentBlock } from '../../../services/api/streamTypes.js'
import type { Message } from '../../../types/message.js'

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

describe('LocalAgentTask progress tracking', () => {
  test('counts tool uses while treating zero usage as unknown', () => {
    const tracker = createProgressTracker()

    updateProgressFromMessage(
      tracker,
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
    )

    expect(getProgressUpdate(tracker)).toMatchObject({
      toolUseCount: 1,
      tokenCount: 0,
    })
  })

  test('does not let a later zero-usage placeholder clear known token progress', () => {
    const tracker = createProgressTracker()

    updateProgressFromMessage(
      tracker,
      assistantMessage({
        content: [{ type: 'text', text: 'working' }],
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
      }),
    )
    updateProgressFromMessage(
      tracker,
      assistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'Grep',
            input: { pattern: 'tokenCount' },
          },
        ],
        inputTokens: 0,
        outputTokens: 0,
      }),
    )

    expect(getProgressUpdate(tracker)).toMatchObject({
      toolUseCount: 1,
      tokenCount: 150,
    })
  })
})
