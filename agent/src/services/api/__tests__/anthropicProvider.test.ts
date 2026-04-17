import { describe, it, expect, vi } from 'vitest'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../providers/anthropicProvider.js'
import type { StreamRequest } from '../provider.js'
import type { StreamEvent, StreamIntent } from '../streamTypes.js'

// Mock analytics (transitive dep from anthropicStreamAdapter)
vi.mock('../../../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))
// Mock transitive deps to avoid deep import chain (modelCost → model configs etc.)
vi.mock('../withRetry.js', () => ({
  withRetry: vi.fn(async function* (getClient: any, operation: any, options: any) {
    const client = await getClient()
    const result = await operation(client, 1, {
      model: options.model,
      thinkingConfig: options.thinkingConfig,
    })
    return result
  }),
  CannotRetryError: class extends Error {},
}))
vi.mock('../../../utils/diagLogs.js', () => ({ logForDiagnosticsNoPII: vi.fn() }))
vi.mock('../../../utils/betas.js', () => ({ getModelBetas: vi.fn().mockReturnValue([]) }))
vi.mock('../../../utils/model/model.js', () => ({
  getFastModel: vi.fn().mockReturnValue('provider-fast-model'),
  normalizeModelStringForAPI: vi.fn((m: string) => m),
}))
vi.mock('../llm.js', () => ({
  getAPIMetadata: vi.fn().mockReturnValue({}),
  getExtraBodyParams: vi.fn().mockReturnValue({}),
  adjustParamsForNonStreaming: vi.fn((p: any) => p),
  MAX_NON_STREAMING_TOKENS: 64000,
}))
vi.mock('../../../utils/log.js', () => ({ logError: vi.fn() }))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSDKStream(
  events: Array<Record<string, unknown>>,
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
    controller: {},
  }
}

function createMockClient(events: Array<Record<string, unknown>>) {
  const mockStream = createMockSDKStream(events)
  return {
      messages: {
        create: vi.fn().mockReturnValue({
          withResponse: vi.fn().mockResolvedValue({
            data: mockStream,
            request_id: 'req_test_123',
            response: { headers: new Headers({ 'x-request-id': 'req_test_123' }) },
          }),
        }),
    },
  }
}

const dummyIntent: StreamIntent = {
  model: 'provider-main-model',
  messages: [],
  systemPrompt: [],
  tools: [],
  maxOutputTokens: 4096,
  thinking: { type: 'disabled' },
}

function createProvider(mockClient?: any) {
  return new AnthropicProvider({
    getClient: vi.fn().mockResolvedValue(mockClient ?? createMockClient([{ type: 'message_stop' }])),
  })
}

const baseExt = {
  buildParams: () => ({ model: 'provider-main-model', max_tokens: 4096 }),
  retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } },
}

function baseRequest(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: 'provider-main-model',
    signal: new AbortController().signal,
    intent: dummyIntent,
    ...overrides,
  }
}

async function collectStream(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const e of stream) events.push(e)
  return events
}

/** Consume async generator: collect yielded values and return final value */
async function consumeProvider(
  gen: AsyncGenerator<unknown, any>,
): Promise<{ yielded: unknown[]; result: any }> {
  const yielded: unknown[] = []
  for (;;) {
    const next = await gen.next()
    if (next.done) return { yielded, result: next.value }
    yielded.push(next.value)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicProvider', () => {
  describe('createStream', () => {
    it('returns neutral stream events via async generator', async () => {
      const sdkEvents = [
        {
          type: 'message_start',
          message: {
            id: 'msg_01',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'provider-main-model',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 50, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello!' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]

      const mockClient = createMockClient(sdkEvents)
      const provider = createProvider(mockClient)

      const bound = provider.bind({
        buildParams: () => ({ model: 'provider-main-model', max_tokens: 4096 }),
        retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } },
      })
      const { result } = await consumeProvider(bound.createStream({
        model: 'provider-main-model',
        signal: new AbortController().signal,
        intent: dummyIntent,
      }))

      expect(result.requestId).toBe('req_test_123')

      const events = await collectStream(result.stream)
      expect(events).toHaveLength(6)
      expect(events[0]).toMatchObject({ type: 'response_start' })
      expect(events[1]).toMatchObject({ type: 'block_start', block: { type: 'text' } })
      expect(events[2]).toMatchObject({ type: 'block_delta', delta: { type: 'text', text: 'Hello!' } })
      expect(events[3]).toMatchObject({ type: 'block_stop' })
      expect(events[4]).toMatchObject({ type: 'response_delta', stopReason: 'end_turn' })
      expect(events[5]).toMatchObject({ type: 'response_stop' })
    })

    it('passes buildParams result to SDK create call', async () => {
      const mockClient = createMockClient([{ type: 'message_stop' }])
      const buildParams = vi.fn().mockReturnValue({
        model: 'provider-main-model',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'Read' },
      })
      const provider = createProvider(mockClient)

      const bound = provider.bind({ buildParams, retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } } })
      await consumeProvider(bound.createStream({
        model: 'provider-main-model',
        signal: new AbortController().signal,
        intent: dummyIntent,
      }))

      expect(buildParams).toHaveBeenCalledTimes(1)
      const createCall = mockClient.messages.create
      expect(createCall).toHaveBeenCalledTimes(1)
      const params = createCall.mock.calls[0][0]
      expect(params.model).toBe('provider-main-model')
      expect(params.stream).toBe(true)
    })

    it('calls onAttemptStart and onRequestSent callbacks', async () => {
      const mockClient = createMockClient([{ type: 'message_stop' }])
      const onAttemptStart = vi.fn()
      const onRequestSent = vi.fn()
      const provider = createProvider(mockClient)

      const bound = provider.bind({
        buildParams: () => ({ model: 'provider-main-model', max_tokens: 8192 }),
        retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } },
      })
      await consumeProvider(bound.createStream({
        model: 'provider-main-model',
        signal: new AbortController().signal,
        intent: dummyIntent,
        hooks: { onAttemptStart, onRequestSent },
      }))

      expect(onAttemptStart).toHaveBeenCalledTimes(1)
      expect(onAttemptStart.mock.calls[0][0].attempt).toBe(1)

      expect(onRequestSent).toHaveBeenCalledTimes(1)
      expect(onRequestSent.mock.calls[0][0].maxOutputTokens).toBe(8192)
      expect(onRequestSent.mock.calls[0][0].requestId).toBe('req_test_123')
    })

    it('emits provider events for raw Anthropic events', async () => {
      const sdkEvents = [
        {
          type: 'message_start',
          message: {
            id: 'msg_01', type: 'message', role: 'assistant', content: [],
            model: 'provider-main-model', stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
          },
        },
        { type: 'message_stop' },
      ]
      const mockClient = createMockClient(sdkEvents)
      const onProviderEvent = vi.fn()
      const provider = createProvider(mockClient)

      const bound = provider.bind({
        buildParams: () => ({ model: 'provider-main-model', max_tokens: 4096 }),
        retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } },
      })
      const { result } = await consumeProvider(bound.createStream({
        model: 'provider-main-model',
        signal: new AbortController().signal,
        intent: dummyIntent,
        hooks: { onProviderEvent },
      }))

      // Consume the stream to trigger provider events
      const events = await collectStream(result.stream)
      expect(events.length).toBeGreaterThan(0)
      // TTFB event should be emitted on message_start
      expect(onProviderEvent).toHaveBeenCalled()
      const ttfbEvent = onProviderEvent.mock.calls.find(
        (call: any[]) => call[0].type === 'ttfb'
      )
      expect(ttfbEvent).toBeDefined()
    })

    it('returns maxOutputTokens from buildParams', async () => {
      const mockClient = createMockClient([{ type: 'message_stop' }])
      const provider = createProvider(mockClient)

      const bound = provider.bind({
        buildParams: () => ({ model: 'provider-main-model', max_tokens: 32000 }),
        retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } },
      })
      const { result } = await consumeProvider(bound.createStream({
        model: 'provider-main-model',
        signal: new AbortController().signal,
        intent: dummyIntent,
      }))

      expect(result.maxOutputTokens).toBe(32000)
    })
  })

  describe('classifyError', () => {
    it('classifies 529 as retryable overloaded', () => {
      const error = new APIError(529, undefined, 'overloaded', undefined)
      const result = createProvider().classifyError(error)
      expect(result).toMatchObject({ retryable: true, type: 'overloaded', statusCode: 529 })
    })

    it('classifies 429 as retryable rate_limit', () => {
      const error = new APIError(429, undefined, 'rate limited', undefined)
      const result = createProvider().classifyError(error)
      expect(result).toMatchObject({ retryable: true, type: 'rate_limit', statusCode: 429 })
    })

    it('classifies 401 as non-retryable auth', () => {
      const error = new APIError(401, undefined, 'unauthorized', undefined)
      const result = createProvider().classifyError(error)
      expect(result).toMatchObject({ retryable: false, type: 'auth', statusCode: 401 })
    })

    it('classifies connection error as retryable', () => {
      const error = new APIConnectionError({ cause: { code: 'ECONNRESET' } as any })
      const result = createProvider().classifyError(error)
      expect(result).toMatchObject({ retryable: true, type: 'connection' })
    })

    it('classifies abort as non-retryable', () => {
      const error = new APIUserAbortError()
      const result = createProvider().classifyError(error)
      expect(result).toMatchObject({ retryable: false, type: 'abort' })
    })

    it('classifies unknown errors as non-retryable other', () => {
      const result = createProvider().classifyError(new Error('unknown'))
      expect(result).toMatchObject({ retryable: false, type: 'other' })
    })
  })

  describe('calculateCost', () => {
    it('converts neutral Usage and delegates to cost function', () => {
      const mockCostFn = vi.fn().mockReturnValue(0.05)
      const provider = new AnthropicProvider({
        getClient: vi.fn().mockResolvedValue({}),
        calculateUSDCost: mockCostFn,
      })

      const cost = provider.calculateCost('provider-main-model', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
      })

      expect(cost).toBe(0.05)
      expect(mockCostFn).toHaveBeenCalledWith('provider-main-model', {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 0,
      })
    })

    it('returns null when no cost function configured', () => {
      const provider = createProvider()
      expect(provider.calculateCost('model', { inputTokens: 0, outputTokens: 0 })).toBeNull()
    })
  })
})
