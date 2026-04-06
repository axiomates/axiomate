import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnthropicProvider } from '../providers/anthropicProvider.js'
import type { StreamRequest } from '../provider.js'
import type { StreamIntent } from '../streamTypes.js'

// --- Mocks (same pattern as other provider tests) ---
const mockLogEvent = vi.fn()
const mockLogDiag = vi.fn()
const mockAdjustParams = vi.fn((p: any, _maxTokens?: number) => p)
const mockNormalizeModel = vi.fn((m: string) => m)

vi.mock('../../../services/analytics/index.js', () => ({
  logEvent: (...args: any[]) => mockLogEvent(...args),
}))
vi.mock('../withRetry.js', () => ({
  withRetry: vi.fn(async function* (_getClient: any, operation: any, options: any) {
    const client = await _getClient()
    const result = await operation(client, 1, {
      model: options.model,
      thinkingConfig: options.thinkingConfig,
      fastMode: options.fastMode,
    })
    return result
  }),
  CannotRetryError: class extends Error {},
}))
vi.mock('../../../utils/diagLogs.js', () => ({
  logForDiagnosticsNoPII: (...args: any[]) => mockLogDiag(...args),
}))
vi.mock('../../../utils/betas.js', () => ({
  getModelBetas: vi.fn().mockReturnValue([]),
}))
vi.mock('../../../utils/model/model.js', () => ({
  getSmallFastModel: vi.fn().mockReturnValue('claude-haiku-4-5-20251001'),
  normalizeModelStringForAPI: (m: any) => mockNormalizeModel(m),
}))
vi.mock('../claude.js', () => ({
  getAPIMetadata: vi.fn().mockReturnValue({}),
  getExtraBodyParams: vi.fn().mockReturnValue({}),
  adjustParamsForNonStreaming: (p: any, maxTokens: any) => mockAdjustParams(p, maxTokens),
  MAX_NON_STREAMING_TOKENS: 64000,
}))
vi.mock('../../../utils/log.js', () => ({ logError: vi.fn() }))

// --- Helpers ---

const dummyIntent: StreamIntent = {
  model: 'claude-opus-4-6',
  messages: [],
  systemPrompt: [],
  tools: [],
  maxOutputTokens: 4096,
  thinking: { type: 'disabled' },
}

function createMockClient(response: Record<string, unknown>) {
  return {
    beta: {
      messages: {
        create: vi.fn().mockResolvedValue(response),
      },
    },
  }
}

function createMockSDKResponse() {
  return {
    id: 'msg_fallback_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text: 'Fallback response' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  }
}

async function consumeGenerator(
  gen: AsyncGenerator<unknown, any>,
): Promise<{ yielded: unknown[]; result: any }> {
  const yielded: unknown[] = []
  for (;;) {
    const next = await gen.next()
    if (next.done) return { yielded, result: next.value }
    yielded.push(next.value)
  }
}

// --- Tests ---

describe('AnthropicProvider.createNonStreamingFallback', () => {
  let mockClient: ReturnType<typeof createMockClient>
  let provider: AnthropicProvider

  beforeEach(() => {
    vi.clearAllMocks()
    mockClient = createMockClient(createMockSDKResponse())
    provider = new AnthropicProvider({
      getClient: vi.fn().mockResolvedValue(mockClient),
    })
  })

  it('returns NonStreamingResult with neutral LLMMessage', async () => {
    const request: StreamRequest = {
      model: 'claude-opus-4-6',
      signal: new AbortController().signal,
      intent: dummyIntent,
    }

    const bound = provider.bind({
      buildParams: () => ({ model: 'claude-opus-4-6', max_tokens: 4096 }),
      retryOptions: { model: 'claude-opus-4-6', thinkingConfig: { type: 'disabled' } },
    })
    const { result } = await consumeGenerator(
      bound.createNonStreamingFallback!(request),
    )

    expect(result.message).toMatchObject({
      id: 'msg_fallback_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'Fallback response' }])
    expect(result.message.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
    })
  })

  it('calls buildParams with retry context', async () => {
    const buildParams = vi.fn().mockReturnValue({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
    })

    const request: StreamRequest = {
      model: 'claude-opus-4-6',
      signal: new AbortController().signal,
      intent: dummyIntent,
    }

    const bound = provider.bind({
      buildParams,
      retryOptions: { model: 'claude-opus-4-6', thinkingConfig: { type: 'disabled' } },
    })
    await consumeGenerator(bound.createNonStreamingFallback!(request))

    expect(buildParams).toHaveBeenCalledTimes(1)
    // Called with RetryContext from withRetry mock
    expect(buildParams.mock.calls[0][0]).toMatchObject({
      model: 'claude-opus-4-6',
    })
  })

  it('calls adjustParamsForNonStreaming', async () => {
    const request: StreamRequest = {
      model: 'claude-opus-4-6',
      signal: new AbortController().signal,
      intent: dummyIntent,
    }

    const bound = provider.bind({
      buildParams: () => ({ model: 'claude-opus-4-6', max_tokens: 128000 }),
      retryOptions: { model: 'claude-opus-4-6', thinkingConfig: { type: 'disabled' } },
    })
    await consumeGenerator(bound.createNonStreamingFallback!(request))

    expect(mockAdjustParams).toHaveBeenCalledTimes(1)
    expect(mockAdjustParams.mock.calls[0][1]).toBe(64000) // MAX_NON_STREAMING_TOKENS
  })

  it('calls normalizeModelStringForAPI on model', async () => {
    const request: StreamRequest = {
      model: 'claude-opus-4-6',
      signal: new AbortController().signal,
      intent: dummyIntent,
    }

    const bound = provider.bind({
      buildParams: () => ({ model: 'claude-opus-4-6', max_tokens: 4096 }),
      retryOptions: { model: 'claude-opus-4-6', thinkingConfig: { type: 'disabled' } },
    })
    await consumeGenerator(bound.createNonStreamingFallback!(request))

    expect(mockNormalizeModel).toHaveBeenCalled()
  })

  it('calls onNonStreamingAttempt callback', async () => {
    const onNonStreamingAttempt = vi.fn()

    const request: StreamRequest = {
      model: 'claude-opus-4-6',
      signal: new AbortController().signal,
      intent: dummyIntent,
    }

    const bound = provider.bind({
      buildParams: () => ({ model: 'claude-opus-4-6', max_tokens: 4096 }),
      retryOptions: { model: 'claude-opus-4-6', thinkingConfig: { type: 'disabled' } },
      onNonStreamingAttempt,
    })
    await consumeGenerator(bound.createNonStreamingFallback!(request))

    expect(onNonStreamingAttempt).toHaveBeenCalledTimes(1)
    expect(onNonStreamingAttempt.mock.calls[0][0]).toBe(1) // attempt number
    expect(typeof onNonStreamingAttempt.mock.calls[0][1]).toBe('number') // start timestamp
    expect(onNonStreamingAttempt.mock.calls[0][2]).toBe(4096) // maxOutputTokens
  })

  it('calls captureRequest with params', async () => {
    const captureRequest = vi.fn()
    const params = { model: 'claude-opus-4-6', max_tokens: 4096, messages: [] }

    const request: StreamRequest = {
      model: 'claude-opus-4-6',
      signal: new AbortController().signal,
      intent: dummyIntent,
    }

    const bound = provider.bind({
      buildParams: () => params,
      retryOptions: { model: 'claude-opus-4-6', thinkingConfig: { type: 'disabled' } },
      captureRequest,
    })
    await consumeGenerator(bound.createNonStreamingFallback!(request))

    expect(captureRequest).toHaveBeenCalledWith(params)
  })

  it('logs error instrumentation on SDK failure', async () => {
    const failClient = createMockClient({})
    failClient.beta.messages.create = vi.fn().mockRejectedValue(new Error('timeout'))

    const failProvider = new AnthropicProvider({
      getClient: vi.fn().mockResolvedValue(failClient),
    })

    const request: StreamRequest = {
      model: 'claude-opus-4-6',
      signal: new AbortController().signal,
      intent: dummyIntent,
    }

    const bound = failProvider.bind({
      buildParams: () => ({ model: 'claude-opus-4-6', max_tokens: 4096 }),
      retryOptions: { model: 'claude-opus-4-6', thinkingConfig: { type: 'disabled' } },
      originatingRequestId: 'req_original_123',
    })
    await expect(
      consumeGenerator(bound.createNonStreamingFallback!(request)),
    ).rejects.toThrow('timeout')

    expect(mockLogDiag).toHaveBeenCalledWith('error', 'cli_nonstreaming_fallback_error')
    expect(mockLogEvent).toHaveBeenCalledWith(
      'tengu_nonstreaming_fallback_error',
      expect.objectContaining({
        model: 'claude-opus-4-6',
        request_id: 'req_original_123',
      }),
    )
  })

  it('throws without buildParams in ext', async () => {
    expect(() => provider.bind({})).toThrow('AnthropicProvider.bind requires buildParams in ext')
  })
})
