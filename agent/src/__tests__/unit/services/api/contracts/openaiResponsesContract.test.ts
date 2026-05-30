import { describe, expect, it, vi } from 'vitest'

import { shouldUseNonStreamingFallbackForStreamError } from '../../../../../services/api/llm.js'
import { OpenAIResponsesStreamState } from '../../../../../services/api/adapters/openaiResponsesStreamAdapter.js'
import { OpenAIResponsesProvider } from '../../../../../services/api/providers/openaiResponsesProvider.js'
import { classifyError } from '../../../../../services/api/errorClassifier.js'
import { LLMAPIError } from '../../../../../services/api/streamTypes.js'
import type {
  ContentBlockParam,
  MessageParam,
} from '../../../../../services/api/streamTypes.js'
import { withRetry } from '../../../../../services/api/withRetry.js'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { readFixture, stableJson } from './fixtureUtils.js'

vi.mock('../../../../../services/api/withRetry.js', () => ({
  withRetry: vi.fn(async function* (getClient: any, operation: any, options: any) {
    const client = await getClient()
    return await operation(client, 1, {
      model: options.model,
      thinkingConfig: options.thinkingConfig,
    })
  }),
}))

vi.mock('../../../../../utils/imageResizer.js', () => ({
  maybeResizeAndDownsampleImageBuffer: vi.fn(async () => ({
    buffer: Buffer.from('responses-shrunk-image'),
    mediaType: 'jpeg',
  })),
}))

type ResponsesStreamFixture = {
  name: string
  events: unknown[]
  flush: boolean
  streamEvents?: unknown[]
  throws?: {
    status: number
    messageIncludes: string
    expectedReason?: ReturnType<typeof classifyError>['reason']
    expectedRetryable?: boolean
  }
}

function makeProvider(
  model = 'gpt-4o',
  extraParams?: Record<string, unknown>,
) {
  return new OpenAIResponsesProvider({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    modelConfig: {
      model,
      protocol: 'openai-responses',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      extraParams,
    },
  })
}

function attachClient(provider: OpenAIResponsesProvider, response: unknown) {
  ;(provider as any).client = {
    responses: {
      create: vi.fn().mockResolvedValue(response),
    },
  }
}

describe('OpenAI Responses SDK retry policy', () => {
  it('passes maxRetries:0 to SDK calls so withRetry owns retries', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_123',
      model: 'gpt-4o',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 1 },
    })

    await provider.inference({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const create = (provider as any).client.responses.create
    expect(create.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ maxRetries: 0 }),
    )
  })
})

describe('OpenAI Responses xAI/Grok request sanitization', () => {
  const slashEnumTool = {
    name: 'pick_model',
    description: 'Pick a model.',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          enum: ['Qwen/Qwen3.5-0.8B', 'plain-id'],
        },
      },
    },
  }

  function buildRequest(model: string): Promise<Record<string, unknown>> {
    const provider = makeProvider(model, {
      service_tier: 'priority',
    })
    return (
      provider as unknown as {
        buildRequestBodyForRetry(
          model: string,
          intent: ReturnType<typeof makeIntent>,
          retryContext: {
            model: string
            thinkingConfig: { type: 'disabled' }
          },
          options: { stream: boolean },
        ): Promise<Record<string, unknown>>
      }
    ).buildRequestBodyForRetry(
      model,
      {
        ...makeIntent(),
        tools: [slashEnumTool],
      },
      {
        model,
        thinkingConfig: { type: 'disabled' },
      },
      { stream: false },
    )
  }

  it('strips service_tier and slash enums for Grok Responses', async () => {
    const body = await buildRequest('grok-4.3')
    const tools = body.tools as any[]

    expect(body).not.toHaveProperty('service_tier')
    expect(
      tools[0].parameters.properties.model_id,
    ).not.toHaveProperty('enum')
  })

  it('also strips slash enums for aggregator-prefixed Grok models', async () => {
    const body = await buildRequest('x-ai/grok-4.3')
    const tools = body.tools as any[]

    expect(body).not.toHaveProperty('service_tier')
    expect(
      tools[0].parameters.properties.model_id,
    ).not.toHaveProperty('enum')
  })

  it('preserves service_tier and slash enums for non-Grok Responses models', async () => {
    const body = await buildRequest('gpt-5.5')
    const tools = body.tools as any[]

    expect(body.service_tier).toBe('priority')
    expect(
      tools[0].parameters.properties.model_id.enum,
    ).toEqual(['Qwen/Qwen3.5-0.8B', 'plain-id'])
  })

  it('strips slash enums through retry context after semantic observation', async () => {
    const provider = makeProvider('gpt-5.5', {
      service_tier: 'priority',
    })
    const body = await (
      provider as unknown as {
        buildRequestBodyForRetry(
          model: string,
          intent: ReturnType<typeof makeIntent>,
          retryContext: {
            model: string
            thinkingConfig: { type: 'disabled' }
            stripSlashEnums: true
          },
          options: { stream: boolean },
        ): Promise<Record<string, unknown>>
      }
    ).buildRequestBodyForRetry(
      'gpt-5.5',
      {
        ...makeIntent(),
        tools: [slashEnumTool],
      },
      {
        model: 'gpt-5.5',
        thinkingConfig: { type: 'disabled' },
        stripSlashEnums: true,
      },
      { stream: false },
    )
    const tools = body.tools as any[]

    expect(body.service_tier).toBe('priority')
    expect(
      tools[0].parameters.properties.model_id,
    ).not.toHaveProperty('enum')
  })

  it('rewrites image payloads through retry context', async () => {
    const provider = makeProvider('gpt-5.5')
    const body = await (
      provider as unknown as {
        buildRequestBodyForRetry(
          model: string,
          intent: ReturnType<typeof makeIntent>,
          retryContext: {
            model: string
            thinkingConfig: { type: 'disabled' }
            rewriteImagePayload: true
            imageRecoveryProfile: 'fit_many_image_dimension_limit'
          },
          options: { stream: boolean },
        ): Promise<Record<string, unknown>>
      }
    ).buildRequestBodyForRetry(
      'gpt-5.5',
      {
        ...makeIntent(),
        messages: [
          {
            type: 'user',
            message: {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'inspect' },
                {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: 'image/png' as const,
                    data: Buffer.from('large-image').toString('base64'),
                  },
                },
              ] satisfies ContentBlockParam[],
            },
            uuid: 'msg_image',
          },
        ] as Array<{ type: string; message: MessageParam; uuid: string }>,
      },
      {
        model: 'gpt-5.5',
        thinkingConfig: { type: 'disabled' },
        rewriteImagePayload: true,
        imageRecoveryProfile: 'fit_many_image_dimension_limit',
      },
      { stream: false },
    )
    const input = body.input as Array<{
      content: Array<{ type: string; image_url?: string }>
    }>
    const image = input[0]!.content.find(part => part.type === 'input_image')

    expect(image?.image_url).toBe(
      `data:image/jpeg;base64,${Buffer.from('responses-shrunk-image').toString('base64')}`,
    )
  })
})

function makeIntent(): {
  model: string
  messages: Array<{ type: string; message: MessageParam; uuid: string }>
  systemPrompt: unknown[]
  tools: unknown[]
  maxOutputTokens: number
  thinking: { type: 'disabled' }
} {
  return {
    model: 'gpt-4o',
    messages: [
      {
        type: 'user',
        message: { role: 'user' as const, content: 'hi' },
        uuid: 'msg_1',
      },
    ],
    systemPrompt: [],
    tools: [],
    maxOutputTokens: 4096,
    thinking: { type: 'disabled' as const },
  }
}

async function consume<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  for (;;) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

describe('OpenAI Responses stream event-order golden fixtures', () => {
  it.each(
    readFixture<ResponsesStreamFixture[]>('openai-responses/stream-events.json'),
  )('$name', fixture => {
    const state = new OpenAIResponsesStreamState()
    const events: unknown[] = []

    const runFixture = () => {
      for (const event of fixture.events) {
        events.push(...state.mapEvent(event as ResponseStreamEvent))
      }
      if (fixture.flush) {
        events.push(...state.flush())
      }
    }

    if (fixture.throws) {
      expect(runFixture).toThrow(LLMAPIError)
      try {
        runFixture()
      } catch (error) {
        expect(error).toBeInstanceOf(LLMAPIError)
        expect((error as LLMAPIError).status).toBe(fixture.throws.status)
        expect((error as LLMAPIError).message).toContain(
          fixture.throws.messageIncludes,
        )
        const classified = classifyError(error, {
          provider: 'openai-responses',
          model: 'gpt-4o',
        })
        expect(classified.reason).toBe(
          fixture.throws.expectedReason ?? 'server_error',
        )
        if (fixture.throws.expectedRetryable !== undefined) {
          expect(classified.retryable).toBe(fixture.throws.expectedRetryable)
        } else {
          expect(classified.retryable).toBe(true)
        }
      }
      return
    }

    runFixture()
    expect(stableJson(events)).toEqual(fixture.streamEvents)
  })
})

describe('OpenAI Responses stream fallback parity', () => {
  it('does not use non-streaming fallback for local stream-shape failures before assistant output', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        makeProvider(),
        new LLMAPIError(
          'Responses stream: text delta for output_index=0 without prior message item',
          { status: 502 },
        ),
        'gpt-4o',
      ),
    ).toBe(false)
  })

  it('does not use non-streaming fallback after assistant output was committed', () => {
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        makeProvider(),
        new LLMAPIError(
          'Responses stream: text delta for output_index=0 without prior message item',
          { status: 502 },
        ),
        'gpt-4o',
        { committedAssistantMessages: 1 },
      ),
    ).toBe(false)
  })

  it('defers model_not_found fallback during stream creation like Chat', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      [Symbol.asyncIterator]: async function* () {},
    })

    const gen = provider.bind({
      retryOptions: {
        model: 'gpt-4o',
        thinkingConfig: { type: 'disabled' },
        fallbackModel: 'gpt-4o-mini',
      },
    }).createStream({
      model: 'gpt-4o',
      signal: new AbortController().signal,
      intent: makeIntent() as any,
    })
    await consume(gen)

    expect(vi.mocked(withRetry).mock.calls.at(-1)?.[2]).toMatchObject({
      model: 'gpt-4o',
      fallbackModel: 'gpt-4o-mini',
      deferModelNotFoundFallback: true,
    })
  })
})

describe('OpenAI Responses non-streaming fallback response validation', () => {
  it('throws retryable LLMAPIError(502) when fallback response has empty output', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_empty',
      model: 'gpt-4o',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 5,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 5,
      },
    })

    const gen = provider.bind(undefined).createNonStreamingFallback!({
      model: 'gpt-4o',
      signal: new AbortController().signal,
      intent: makeIntent() as any,
    })

    try {
      await consume(gen)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LLMAPIError)
      expect((error as LLMAPIError).status).toBe(502)
      expect((error as LLMAPIError).message).toContain('empty content')
      const classified = classifyError(error, {
        provider: 'openai-responses',
        model: 'gpt-4o',
      })
      expect(classified.reason).toBe('malformed_response')
      expect(classified.retryable).toBe(true)
    }
  })

  it('throws retryable semantic error when fallback response has null output', async () => {
    const provider = makeProvider()
    attachClient(provider, {
      id: 'resp_null',
      model: 'gpt-4o',
      status: 'completed',
      output: null,
      usage: {
        input_tokens: 5,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 5,
      },
    })

    const gen = provider.bind(undefined).createNonStreamingFallback!({
      model: 'gpt-4o',
      signal: new AbortController().signal,
      intent: makeIntent() as any,
    })

    try {
      await consume(gen)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LLMAPIError)
      expect((error as LLMAPIError).status).toBe(502)
      expect((error as LLMAPIError).message).toContain('null output')
      const classified = classifyError(error, {
        provider: 'openai-responses',
        model: 'gpt-4o',
      })
      expect(classified.reason).toBe('responses_null_output')
      expect(classified.retryable).toBe(true)
    }
  })
})
