import { describe, expect, it, vi } from 'vitest'

// Mock withRetry to avoid transitive auth/model imports in test environment
vi.mock('../withRetry.js', () => ({ withRetry: vi.fn() }))

import { OpenAIProvider } from '../providers/openaiProvider.js'

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

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 })
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_123',
        name: 'Read',
        input: {},
        unparsedInput: '{"file_path":',
      },
    ])
  })

  it('maps OpenAI-compatible cache usage details', async () => {
    const provider = new OpenAIProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      modelConfig: {
        model: 'qwen3.6-plus',
        protocol: 'openai',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-key',
      },
    })

    ;(provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            id: 'resp_456',
            model: 'qwen3.6-plus',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: 'ok',
                },
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 50,
              total_tokens: 1050,
              prompt_tokens_details: {
                cached_tokens: 400,
                cache_creation: {
                  cache_creation_input_tokens: 100,
                },
              },
            },
          }),
        },
      },
    }

    const result = await provider.inference({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    })
  })
})
