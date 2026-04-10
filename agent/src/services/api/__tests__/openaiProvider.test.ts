import { describe, expect, it, vi } from 'vitest'

import { OpenAIProvider } from '../providers/openaiProvider.js'
import { getUnparsedToolInputForRepair } from '../toolInputRepairMetadata.js'

describe('OpenAIProvider.inference', () => {
  it('preserves raw tool arguments when they are invalid JSON', async () => {
    const provider = new OpenAIProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      modelConfig: {
        model: 'gpt-4o',
        protocol: 'openai',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-key',
      },
    })

    ;(provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            id: 'resp_123',
            model: 'gpt-4o',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_123',
                      type: 'function',
                      function: {
                        name: 'Read',
                        arguments: '{"file_path":',
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
            },
          }),
        },
      },
    }

    const result = await provider.inference({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Read a file' }],
    })

    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_123',
        name: 'Read',
        input: {},
      },
    ])
    const [toolUse] = result.content
    expect(
      toolUse?.type === 'tool_use'
        ? getUnparsedToolInputForRepair(toolUse)
        : undefined,
    ).toBe('{"file_path":')
  })
})
