import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderGroupedAgentToolUse } from '../../../../tools/AgentTool/UI.js'
import type { Progress } from '../../../../tools/AgentTool/AgentTool.js'
import type { ProgressMessage } from '../../../../types/message.js'
import { renderToString } from '../../../../utils/staticRender.js'

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
              {
                type: 'progress',
                uuid: '00000000-0000-4000-8000-000000000001',
                timestamp: '2026-06-08T00:00:00.000Z',
                toolUseID: 'toolu_agent',
                parentToolUseID: 'toolu_parent',
                data: {
                  type: 'agent_progress',
                  message: {
                    type: 'assistant',
                    uuid: '00000000-0000-4000-8000-000000000002',
                    timestamp: '2026-06-08T00:00:00.000Z',
                    message: {
                      id: 'msg_1',
                      type: 'message',
                      role: 'assistant',
                      content: [
                        {
                          type: 'tool_use',
                          id: 'toolu_read',
                          name: 'Read',
                          input: { file_path: 'src/a.ts' },
                        },
                      ],
                      model: 'test-model',
                      stop_reason: null,
                      stop_sequence: null,
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: null,
                        cache_read_input_tokens: null,
                      },
                    },
                  },
                },
              } satisfies ProgressMessage<Progress>,
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
})
