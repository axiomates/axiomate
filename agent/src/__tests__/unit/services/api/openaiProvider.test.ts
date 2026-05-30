import { describe, expect, it, vi } from 'vitest'

// Mock withRetry to avoid transitive auth/model imports in test environment
vi.mock('../../../../services/api/withRetry.js', () => ({
  withRetry: vi.fn(async function* (getClient: any, operation: any, options: any) {
    const client = await getClient()
    return await operation(client, 1, {
      model: options.model,
      thinkingConfig: options.thinkingConfig,
    })
  }),
}))

import { OpenAIProvider } from '../../../../services/api/providers/openaiProvider.js'
import { LLMAPIError } from '../../../../services/api/streamTypes.js'
import { classifyError } from '../../../../services/api/errorClassifier.js'
import { withRetry } from '../../../../services/api/withRetry.js'
import { shouldUseNonStreamingFallbackForStreamError } from '../../../../services/api/llm.js'

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

describe('streaming fallback decision', () => {
  const provider = makeProvider()

  it('uses non-streaming fallback for stream unsupported errors', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError('does not support streaming', { status: 400 }),
        'gpt-4o',
      ),
    ).toBe(true)
  })

  it('does not use non-streaming fallback for unsupported stream_options', () => {
    const error = new LLMAPIError(
      'Unsupported parameter: stream_options is not supported by this model',
      {
        status: 400,
        error: {
          error: {
            code: 'unsupported_parameter',
            param: 'stream_options',
          },
        },
      },
    )

    expect(
      shouldUseNonStreamingFallbackForStreamError(provider, error, 'gpt-4o'),
    ).toBe(false)
  })

  it('does not use non-streaming fallback for generic 404 outside stream creation', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError('Not Found', { status: 404 }),
        'gpt-4o',
      ),
    ).toBe(false)
  })

  it('uses non-streaming fallback for generic 404 during stream creation', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError('Not Found', { status: 404 }),
        'gpt-4o',
        { allowStreamEndpoint404Fallback: true },
      ),
    ).toBe(true)
  })

  it('does not use non-streaming fallback for provider-policy 404 during stream creation', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError(
          'No endpoints available matching your guardrail restrictions and data policy.',
          { status: 404 },
        ),
        'gpt-4o',
        { allowStreamEndpoint404Fallback: true },
      ),
    ).toBe(false)
  })

  it('uses non-streaming fallback for endpoint-not-found 404 during stream creation', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError('The requested endpoint does not exist', { status: 404 }),
        'gpt-4o',
        { allowStreamEndpoint404Fallback: true },
      ),
    ).toBe(true)
  })

  it('does not use non-streaming fallback for model-not-found 404 errors', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError('The model gpt-4o does not exist', { status: 404 }),
        'gpt-4o',
      ),
    ).toBe(false)
  })

  it('does not use non-streaming fallback for retry-semantic errors', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError('gateway timeout', { status: 502 }),
        'gpt-4o',
      ),
    ).toBe(false)

    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError('rate limit', { status: 429 }),
        'gpt-4o',
      ),
    ).toBe(false)
  })

  it('does not use non-streaming fallback for empty provider streams', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new Error('Stream ended without receiving any events'),
        'gpt-4o',
      ),
    ).toBe(false)
  })

  it('does not use non-streaming fallback for local stream-shape failures', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new Error('missing response_start before content block'),
        'gpt-4o',
      ),
    ).toBe(false)
  })

  it('does not use non-streaming fallback after assistant output was committed', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new Error('Stream ended without receiving any events'),
        'gpt-4o',
        { committedAssistantMessages: 1 },
      ),
    ).toBe(false)
  })

  it('does not use non-streaming fallback for wrapped Responses stream-shape failures', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError(
          'Responses stream: text delta for output_index=0 without prior message item',
          { status: 502 },
        ),
        'gpt-4o',
      ),
    ).toBe(false)
  })

  it('does not use non-streaming fallback for unrelated local errors', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new Error('unexpected local failure'),
        'gpt-4o',
      ),
    ).toBe(false)
  })

  it('does not use non-streaming fallback for generic server errors', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new LLMAPIError('Bad Gateway', { status: 502 }),
        'gpt-4o',
      ),
    ).toBe(false)
  })
})

describe('OpenAIProvider.createNonStreamingFallback', () => {
  it('passes maxRetries:0 to OpenAI SDK calls so withRetry owns retries', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_123',
      model: 'gpt-4o',
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    })

    await provider.inference({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const create = (provider as any).client.chat.completions.create
    expect(create.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ maxRetries: 0 }),
    )
  })

  it('sets stream-creation 404 fallback deferral only on streaming requests', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      [Symbol.asyncIterator]: async function* () {},
    })

    const intent = {
      messages: [
        { type: 'user', message: { role: 'user' as const, content: 'hi' }, uuid: '1' },
      ],
      systemPrompt: [],
      tools: [],
      maxOutputTokens: 4096,
      thinking: { type: 'disabled' },
    }
    const bound = provider.bind({
      retryOptions: {
        model: 'gpt-4o',
        thinkingConfig: { type: 'disabled' },
        fallbackModel: 'gpt-4o-mini',
      },
    })

    const gen = bound.createStream({
      model: 'gpt-4o',
      signal: new AbortController().signal,
      intent: intent as any,
    })
    for (;;) {
      const next = await gen.next()
      if (next.done) break
    }

    expect(vi.mocked(withRetry).mock.calls.at(-1)?.[2]).toMatchObject({
      model: 'gpt-4o',
      fallbackModel: 'gpt-4o-mini',
      deferModelNotFoundFallback: true,
    })
  })

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

  it('runs through withRetry with bound retry options and attempt callback', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_ok',
      model: 'gpt-4o',
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'ok' },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    })

    const onNonStreamingAttempt = vi.fn()
    const captureRequest = vi.fn()
    const intent = {
      messages: [
        { type: 'user', message: { role: 'user' as const, content: 'hi' }, uuid: '1' },
      ],
      systemPrompt: [],
      tools: [],
      maxOutputTokens: 4096,
    }
    const bound = provider.bind({
      retryOptions: {
        model: 'gpt-4o',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 3,
      },
      onNonStreamingAttempt,
      captureRequest,
    })

    const gen = bound.createNonStreamingFallback!({
      model: 'gpt-4o',
      signal: new AbortController().signal,
      intent: intent as any,
    })
    for (;;) {
      const next = await gen.next()
      if (next.done) break
    }

    expect(withRetry).toHaveBeenCalled()
    expect(vi.mocked(withRetry).mock.calls.at(-1)?.[2]).toMatchObject({
      model: 'gpt-4o',
      maxRetries: 3,
    })
    expect(vi.mocked(withRetry).mock.calls.at(-1)?.[2]).not.toHaveProperty(
      'deferModelNotFoundFallback',
    )
    expect(onNonStreamingAttempt).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      4096,
    )
    expect(captureRequest).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4096 }),
    )
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
