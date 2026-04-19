import { describe, it, expect, vi } from 'vitest'
import { AnthropicProvider } from '../providers/anthropicProvider.js'
import type { StreamIntent } from '../streamTypes.js'

// --- Mocks (same pattern as other provider tests) ---
vi.mock('../../../services/analytics/index.js', () => ({ logEvent: vi.fn() }))
vi.mock('../withRetry.js', () => ({
  withRetry: vi.fn(async function* (_getClient: any, operation: any, options: any) {
    const client = await _getClient()
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
  getExtraBodyParams: vi.fn().mockReturnValue({}),
  adjustParamsForNonStreaming: vi.fn((p: any) => p),
  MAX_NON_STREAMING_TOKENS: 64000,
}))
vi.mock('../../../utils/log.js', () => ({ logError: vi.fn() }))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSDKStream(events: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
    controller: {},
  }
}

function createMockClient(events: Array<Record<string, unknown>> = [{ type: 'message_stop' }]) {
  const mockStream = createMockSDKStream(events)
  return {
      messages: {
        create: vi.fn().mockReturnValue({
          withResponse: vi.fn().mockResolvedValue({
            data: mockStream,
            request_id: 'req_bind_test',
            response: { headers: new Headers({ 'x-request-id': 'req_bind_test' }) },
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
    getClient: vi.fn().mockResolvedValue(mockClient ?? createMockClient()),
  })
}

const baseExt = {
  buildParams: () => ({ model: 'provider-main-model', max_tokens: 4096 }),
  retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } },
}

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

describe('AnthropicProvider.bind', () => {
  it('returns BoundProvider with createStream method', () => {
    const provider = createProvider()
    const bound = provider.bind(baseExt)
    expect(typeof bound.createStream).toBe('function')
  })

  it('returns BoundProvider with createNonStreamingFallback method', () => {
    const provider = createProvider()
    const bound = provider.bind(baseExt)
    expect(typeof bound.createNonStreamingFallback).toBe('function')
  })

  it('throws if ext lacks buildParams', () => {
    const provider = createProvider()
    expect(() => provider.bind({})).toThrow('buildParams')
  })

  it('throws if ext is null', () => {
    const provider = createProvider()
    expect(() => provider.bind(null)).toThrow('buildParams')
  })

  it('BoundProvider.createStream works with pure StreamRequest (no providerExt)', async () => {
    const mockClient = createMockClient()
    const provider = createProvider(mockClient)
    const bound = provider.bind(baseExt)

    const { result } = await consumeProvider(bound.createStream({
      model: 'provider-main-model',
      signal: new AbortController().signal,
      intent: dummyIntent,
    }))

    expect(result.requestId).toBe('req_bind_test')
  })

  it('different binds are independent', () => {
    const provider = createProvider()
    const ext1 = {
      buildParams: () => ({ model: 'provider-main-model', max_tokens: 4096 }),
      retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } },
    }
    const ext2 = {
      buildParams: () => ({ model: 'provider-main-model', max_tokens: 8192 }),
      retryOptions: { model: 'provider-main-model', thinkingConfig: { type: 'disabled' } },
    }
    const bound1 = provider.bind(ext1)
    const bound2 = provider.bind(ext2)
    expect(bound1).not.toBe(bound2)
  })

  it('direct createStream throws (must use bind)', async () => {
    const provider = createProvider()
    await expect(
      consumeProvider(provider.createStream({
        model: 'provider-main-model',
        signal: new AbortController().signal,
        intent: dummyIntent,
      })),
    ).rejects.toThrow('bind')
  })

  it('direct createNonStreamingFallback throws (must use bind)', async () => {
    const provider = createProvider()
    await expect(
      consumeProvider(provider.createNonStreamingFallback!({
        model: 'provider-main-model',
        signal: new AbortController().signal,
        intent: dummyIntent,
      })),
    ).rejects.toThrow('bind')
  })
})
