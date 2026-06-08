import type { UUID } from 'crypto'
import React from 'react'
import { describe, expect, test } from 'vitest'

import {
  renderGroupedAgentToolUse,
  renderToolUseProgressMessage,
} from '../../../../tools/AgentTool/UI.js'
import type { Progress } from '../../../../tools/AgentTool/AgentTool.js'
import type { ProgressMessage } from '../../../../types/message.js'
import { renderToString } from '../../../../utils/staticRender.js'

const TIMESTAMP = '2026-06-08T00:00:00.000Z'

function assistantProgress({
  uuid,
  messageUuid,
  messageId,
  content,
  inputTokens,
  outputTokens,
}: {
  uuid: UUID
  messageUuid: UUID
  messageId: string
  content: Array<Record<string, unknown>>
  inputTokens: number
  outputTokens: number
}): ProgressMessage<Progress> {
  return {
    type: 'progress',
    uuid,
    timestamp: TIMESTAMP,
    toolUseID: 'toolu_agent',
    parentToolUseID: 'toolu_parent',
    data: {
      type: 'agent_progress',
      message: {
        type: 'assistant',
        uuid: messageUuid,
        timestamp: TIMESTAMP,
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content,
          model: 'test-model',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
    },
  } satisfies ProgressMessage<Progress>
}

function toolResultProgress({
  uuid,
  messageUuid,
  toolUseID,
}: {
  uuid: UUID
  messageUuid: UUID
  toolUseID: string
}): ProgressMessage<Progress> {
  return {
    type: 'progress',
    uuid,
    timestamp: TIMESTAMP,
    toolUseID: 'toolu_agent',
    parentToolUseID: 'toolu_parent',
    data: {
      type: 'agent_progress',
      message: {
        type: 'user',
        uuid: messageUuid,
        timestamp: TIMESTAMP,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseID,
              content: 'ok',
            },
          ],
        },
      },
    },
  } satisfies ProgressMessage<Progress>
}

describe('AgentTool UI', () => {
  test('uses completed result tokens when progress usage was a zero placeholder', async () => {
    const output = await renderToString(
      renderGroupedAgentToolUse(
        [
          {
            param: {
              type: 'tool_use',
              id: 'toolu_agent',
              name: 'Agent',
              input: {
                description: 'inspect token reporting',
                prompt: 'Find the issue',
              },
            },
            isResolved: true,
            isError: false,
            isInProgress: false,
            progressMessages: [
              assistantProgress({
                uuid: '00000000-0000-4000-8000-000000000001',
                messageUuid: '00000000-0000-4000-8000-000000000002',
                messageId: 'msg_1',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_read',
                    name: 'Read',
                    input: { file_path: 'src/a.ts' },
                  },
                ],
                inputTokens: 0,
                outputTokens: 0,
              }),
            ],
            result: {
              param: {
                type: 'tool_result',
                tool_use_id: 'toolu_agent',
                content: [],
              },
              output: {
                status: 'completed',
                agentId: 'agent-1',
                agentType: 'general-purpose',
                prompt: 'Find the issue',
                content: [{ type: 'text', text: 'done' }],
                totalDurationMs: 1,
                totalTokens: 123,
                totalToolUseCount: 1,
                usage: {
                  input_tokens: 100,
                  output_tokens: 23,
                  cache_creation_input_tokens: null,
                  cache_read_input_tokens: null,
                  server_tool_use: null,
                  service_tier: null,
                  cache_creation: null,
                },
              },
            },
          },
        ],
        { shouldAnimate: false, tools: [] },
      ),
    )

    expect(output).toContain('1 tool use')
    expect(output).toContain('123 tokens')
    expect(output).not.toContain('0 tokens')
  })

  test('omits running grouped agent tokens while latest usage is a zero placeholder', async () => {
    const output = await renderToString(
      renderGroupedAgentToolUse(
        [
          {
            param: {
              type: 'tool_use',
              id: 'toolu_agent',
              name: 'Agent',
              input: {
                description: 'inspect token reporting',
                prompt: 'Find the issue',
              },
            },
            isResolved: false,
            isError: false,
            isInProgress: true,
            progressMessages: [
              assistantProgress({
                uuid: '00000000-0000-4000-8000-000000000003',
                messageUuid: '00000000-0000-4000-8000-000000000004',
                messageId: 'msg_2',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_read',
                    name: 'Read',
                    input: { file_path: 'src/a.ts' },
                  },
                ],
                inputTokens: 0,
                outputTokens: 0,
              }),
              toolResultProgress({
                uuid: '00000000-0000-4000-8000-000000000005',
                messageUuid: '00000000-0000-4000-8000-000000000006',
                toolUseID: 'toolu_read',
              }),
              assistantProgress({
                uuid: '00000000-0000-4000-8000-000000000007',
                messageUuid: '00000000-0000-4000-8000-000000000008',
                messageId: 'msg_3',
                content: [{ type: 'text', text: 'Continuing' }],
                inputTokens: 0,
                outputTokens: 0,
              }),
            ],
          },
        ],
        { shouldAnimate: false, tools: [] },
      ),
    )

    expect(output).toContain('1 tool use')
    expect(output).not.toContain('0 tokens')
  })

  test('keeps running grouped agent tokens once usage is known', async () => {
    const output = await renderToString(
      renderGroupedAgentToolUse(
        [
          {
            param: {
              type: 'tool_use',
              id: 'toolu_agent',
              name: 'Agent',
              input: {
                description: 'inspect token reporting',
                prompt: 'Find the issue',
              },
            },
            isResolved: false,
            isError: false,
            isInProgress: true,
            progressMessages: [
              assistantProgress({
                uuid: '00000000-0000-4000-8000-000000000009',
                messageUuid: '00000000-0000-4000-8000-00000000000a',
                messageId: 'msg_4',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_read',
                    name: 'Read',
                    input: { file_path: 'src/a.ts' },
                  },
                ],
                inputTokens: 100,
                outputTokens: 23,
              }),
              toolResultProgress({
                uuid: '00000000-0000-4000-8000-00000000000b',
                messageUuid: '00000000-0000-4000-8000-00000000000c',
                toolUseID: 'toolu_read',
              }),
            ],
          },
        ],
        { shouldAnimate: false, tools: [] },
      ),
    )

    expect(output).toContain('1 tool use')
    expect(output).toContain('123 tokens')
  })

  test('omits condensed progress tokens while latest usage is a zero placeholder', async () => {
    const output = await renderToString(
      renderToolUseProgressMessage(
        [
          assistantProgress({
            uuid: '00000000-0000-4000-8000-00000000000d',
            messageUuid: '00000000-0000-4000-8000-00000000000e',
            messageId: 'msg_5',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_read',
                name: 'Read',
                input: { file_path: 'src/a.ts' },
              },
            ],
            inputTokens: 0,
            outputTokens: 0,
          }),
        ],
        {
          tools: [],
          verbose: false,
          terminalSize: { columns: 80, rows: 1 },
        },
      ),
    )

    expect(output).toContain('1 tool use')
    expect(output).not.toContain('0 tokens')
    expect(output).not.toContain('use0')
  })
})
