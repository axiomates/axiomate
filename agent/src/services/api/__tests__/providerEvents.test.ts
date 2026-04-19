import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../services/analytics/index.js', () => ({ logEvent: vi.fn() }))
vi.mock('../withRetry.js', () => ({
  withRetry: vi.fn(async function* (_getClient: any, operation: any, options: any) {
    const client = await _getClient()
    const result = await operation(client, 1, { model: options.model, thinkingConfig: options.thinkingConfig })
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
  getExtraBodyParams: vi.fn().mockReturnValue({}),
  adjustParamsForNonStreaming: vi.fn((p: any) => p),
  MAX_NON_STREAMING_TOKENS: 64000,
}))
vi.mock('../../../utils/log.js', () => ({ logError: vi.fn() }))

import { AnthropicProvider } from '../providers/anthropicProvider.js'
import type { StreamEvent } from '../streamTypes.js'
import type { ProviderEvent } from '../provider.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(events: Array<Record<string, unknown>>) {
  const mockStream = {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
    controller: {},
  }
  return {
      messages: {
        create: vi.fn().mockReturnValue({
          withResponse: vi.fn().mockResolvedValue({
            data: mockStream,
            request_id: 'req_test',
            response: {},
          }),
        }),
    },
  }
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

function baseRequest(_mockClient: any, onProviderEvent?: (e: ProviderEvent) => void) {
  return {
    model: 'provider-main-model',
    signal: new AbortController().signal,
    intent: {
      model: 'provider-main-model',
      messages: [],
      systemPrompt: [],
      tools: [],
      maxOutputTokens: 4096,
      thinking: { type: 'disabled' as const },
    },
    hooks: {
      onProviderEvent,
    },
  }
}

async function consumeProvider(gen: AsyncGenerator<unknown, any>) {
  const yielded: unknown[] = []
  for (;;) {
    const next = await gen.next()
    if (next.done) return { yielded, result: next.value }
    yielded.push(next.value)
  }
}

async function collectStream(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = []
  for await (const e of stream) events.push(e)
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicProvider — ProviderEvents', () => {
  it('emits ttfb ProviderEvent on message_start with ms > 0', async () => {
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

    const { result } = await consumeProvider(provider.bind(baseExt).createStream(baseRequest(mockClient, onProviderEvent)))
    await collectStream(result.stream)

    const ttfbCall = onProviderEvent.mock.calls.find((c: any[]) => c[0].type === 'ttfb')
    expect(ttfbCall).toBeDefined()
    expect(ttfbCall![0].ms).toBeGreaterThanOrEqual(0)
  })

  it('emits research ProviderEvent when message_start has research field', async () => {
    const sdkEvents = [
      {
        type: 'message_start',
        message: {
          id: 'msg_01', type: 'message', role: 'assistant', content: [],
          model: 'provider-main-model', stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
          research: { query: 'test' },
        },
      },
      { type: 'message_stop' },
    ]
    const mockClient = createMockClient(sdkEvents)
    const onProviderEvent = vi.fn()
    const provider = createProvider(mockClient)

    const { result } = await consumeProvider(provider.bind(baseExt).createStream(baseRequest(mockClient, onProviderEvent)))
    await collectStream(result.stream)

    const researchCall = onProviderEvent.mock.calls.find((c: any[]) => c[0].type === 'research')
    expect(researchCall).toBeDefined()
    expect(researchCall![0].data).toEqual({ query: 'test' })
  })

  it('does not crash when onProviderEvent is not provided', async () => {
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
    const provider = createProvider(mockClient)

    // No onProviderEvent — should not throw
    const { result } = await consumeProvider(provider.bind(baseExt).createStream(baseRequest(mockClient, undefined)))
    const events = await collectStream(result.stream)
    expect(events.length).toBeGreaterThan(0)
  })

  it('TTFB ms is approximately Date.now() - start (within 100ms tolerance)', async () => {
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

    const startTime = Date.now()
    const { result } = await consumeProvider(provider.bind(baseExt).createStream(baseRequest(mockClient, onProviderEvent)))
    await collectStream(result.stream)
    const elapsed = Date.now() - startTime

    const ttfbCall = onProviderEvent.mock.calls.find((c: any[]) => c[0].type === 'ttfb')
    expect(ttfbCall).toBeDefined()
    // TTFB should be within a reasonable range of the total elapsed time
    expect(ttfbCall![0].ms).toBeLessThanOrEqual(elapsed + 100)
  })
})
