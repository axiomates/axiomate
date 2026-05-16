import { describe, expect, it, vi } from 'vitest'

// Mock withRetry to avoid transitive auth/model imports in test environment
vi.mock('../withRetry.js', () => ({ withRetry: vi.fn() }))

import { OpenAIProvider } from '../providers/openaiProvider.js'
import { LLMAPIError } from '../streamTypes.js'
import { classifyError } from '../errorClassifier.js'

function makeProvider(model = 'gpt-4o') {
  return new OpenAIProvider({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    modelConfig: {
      model,
      protocol: 'openai-chat',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
    },
  })
}

function attachClient(provider: OpenAIProvider, response: unknown) {
  ;(provider as any).client = {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue(response),
      },
    },
  }
}

describe('OpenAIProvider.inference', () => {
  it('preserves raw tool arguments when they are invalid JSON', async () => {
    const provider = makeProvider()
    attachClient(provider, {
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
    })

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
    const provider = makeProvider('deepseek-v4-pro')
    attachClient(provider, {
      id: 'resp_456',
      model: 'deepseek-v4-pro',
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
    })

    const result = await provider.inference({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    })
  })

  it('throws LLMAPIError(502) when response has no choices (undefined)', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_bad',
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    })

    await expect(
      provider.inference({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(LLMAPIError)

    try {
      await provider.inference({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LLMAPIError)
      expect((e as LLMAPIError).status).toBe(502)
      expect((e as LLMAPIError).message).toContain('no choices')
    }
  })

  it('throws LLMAPIError(502) when response has empty choices array', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_empty',
      model: 'gpt-4o',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    })

    try {
      await provider.inference({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LLMAPIError)
      expect((e as LLMAPIError).status).toBe(502)
    }
  })

  it('extracts error envelope in malformed response message', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      error: { message: 'upstream rate limited', code: 'rate_limit_exceeded' },
    })

    try {
      await provider.inference({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LLMAPIError)
      expect((e as LLMAPIError).status).toBe(502)
      expect((e as LLMAPIError).message).toContain('upstream rate limited')
    }
  })
})

describe('OpenAIProvider.createNonStreamingFallback', () => {
  it('throws LLMAPIError(502) when response has no choices', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_bad',
      model: 'gpt-4o',
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    })

    const intent = {
      messages: [
        { type: 'user', message: { role: 'user' as const, content: 'hi' }, uuid: '1' },
      ],
      systemPrompt: [],
      tools: [],
      maxOutputTokens: 4096,
    }
    const bound = provider.bind(undefined)
    const gen = bound.createNonStreamingFallback!({
      model: 'gpt-4o',
      signal: new AbortController().signal,
      intent: intent as any,
    })

    try {
      for (;;) {
        const next = await gen.next()
        if (next.done) break
      }
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LLMAPIError)
      expect((e as LLMAPIError).status).toBe(502)
      expect((e as LLMAPIError).message).toContain('no choices')
    }
  })
})

describe('OpenAIProvider malformed-response harness integration', () => {
  // End-to-end contract: the LLMAPIError we now throw on malformed bodies
  // must be classified as retryable server_error by the real classifyError,
  // so withRetry retries it instead of bailing or surfacing a bare TypeError.
  it('malformed-response LLMAPIError(502) classifies as retryable server_error', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_bad',
      model: 'gpt-4o',
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    })

    let caught: unknown
    try {
      await provider.inference({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMAPIError)

    const classified = classifyError(caught, {
      provider: 'openai',
      model: 'gpt-4o',
    })
    expect(classified.reason).toBe('server_error')
    expect(classified.retryable).toBe(true)
    expect(classified.statusCode).toBe(502)
  })

  it('inline-error-envelope responses also classify as retryable server_error', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      error: { message: 'upstream proxy crashed' },
    })

    let caught: unknown
    try {
      await provider.inference({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMAPIError)

    const classified = classifyError(caught, {
      provider: 'openai',
      model: 'gpt-4o',
    })
    expect(classified.reason).toBe('server_error')
    expect(classified.retryable).toBe(true)
  })
})
