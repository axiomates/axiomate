import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  SystemAPIErrorMessage,
} from '../../../../../types/message.js'
import type {
  BoundProvider,
  LLMProvider,
  ProviderStreamResult,
  StreamRequest,
} from '../../../../../services/api/provider.js'
import type { RecoveryTraceEvent } from '../../../../../services/api/recoveryTrace.js'
import {
  LLMAPIError,
  type LLMMessage,
  type StreamEvent,
} from '../../../../../services/api/streamTypes.js'
import { asSystemPrompt } from '../../../../../utils/systemPromptType.js'
import { readFixture } from './fixtureUtils.js'
import { queryModelWithStreaming } from '../../../../../services/api/llm.js'
import { withRetry } from '../../../../../services/api/withRetry.js'

const fakeProviderState = vi.hoisted(() => ({
  mode: 'stream_fallback' as
    | 'stream_fallback'
    | 'empty_stream_retry'
    | 'stream_creation_404'
    | 'stream_creation_model_not_found'
    | 'watchdog_retry',
  streamError: new Error('Stream ended without receiving any events') as unknown,
  streamAttempts: 0,
}))

vi.mock('../../../../../services/api/providerRegistry.js', () => ({
  getProviderForModel: () => new FakeFallbackProvider(fakeProviderState),
}))

vi.mock('../../../../../services/vcr.js', () => ({
  withStreamingVCR: async function* (
    _messages: unknown[],
    f: () => AsyncGenerator<unknown, void>,
  ) {
    yield* f()
  },
  withVCR: async (_messages: unknown[], f: () => Promise<unknown>) => f(),
}))

vi.mock('../../../../../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))

vi.mock('../../../../../utils/sleep.js', () => ({
  sleep: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../../../utils/diagLogs.js', () => ({
  logForDiagnosticsNoPII: vi.fn(),
}))

vi.mock('../../../../../utils/model/model.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../../utils/model/model.js')>()
  return {
    ...actual,
    normalizeModelStringForAPI: (model: string) => model,
  }
})

vi.mock('../../../../../utils/config.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../../utils/config.js')>()
  return {
    ...actual,
    getGlobalConfig: () => ({
      ...actual.DEFAULT_GLOBAL_CONFIG,
      models: {
        'gpt-4o': {
          model: 'gpt-4o',
          protocol: 'openai-chat',
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'test-key',
          contextWindow: 128000,
          maxOutputTokens: 4096,
        },
      },
    }),
  }
})

function makeFallbackMessage(): LLMMessage {
  return {
    id: 'msg_fallback_trace',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'fallback ok' }],
    model: 'gpt-4o',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  }
}

function makeSuccessfulRetryStreamResult(
  request: StreamRequest,
  attempt: number,
): ProviderStreamResult {
  const requestId = `req_watchdog_${attempt}`
  const responseHeaders = new Headers({ 'x-request-id': requestId })
  request.hooks?.onAttemptStart?.({ attempt, start: Date.now() })
  request.hooks?.onRequestSent?.({
    maxOutputTokens: 4096,
    requestId,
    response: { headers: responseHeaders },
  })
  request.hooks?.onProviderEvent?.({ type: 'ttfb', ms: 3 })
  request.hooks?.onProviderEvent?.({ type: 'bytes', bytes: 23 })

  return {
    requestId,
    responseHeaders,
    maxOutputTokens: 4096,
    stream: {
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        yield {
          type: 'response_start',
          response: {
            id: 'resp_watchdog_success',
            model: 'gpt-4o',
            stopReason: null,
            usage: { inputTokens: 2, outputTokens: 0 },
          },
        }
        yield {
          type: 'block_start',
          index: 0,
          block: { type: 'text', text: '' },
        }
        yield {
          type: 'block_delta',
          index: 0,
          delta: { type: 'text', text: 'retry ok' },
        }
        yield { type: 'block_stop', index: 0 }
        yield {
          type: 'response_delta',
          stopReason: 'end_turn',
          usage: { inputTokens: 2, outputTokens: 2 },
        }
        yield { type: 'response_stop' }
      },
    },
  }
}

function makeWatchdogStreamResult(
  request: StreamRequest,
  attempt: number,
): ProviderStreamResult {
  const requestId = `req_watchdog_${attempt}`
  const responseHeaders = new Headers({ 'x-request-id': requestId })
  let releaseStream!: () => void
  const streamReleased = new Promise<void>(resolve => {
    releaseStream = resolve
  })
  const response = {
    headers: responseHeaders,
    body: {
      cancel: () => {
        releaseStream()
        return Promise.resolve()
      },
    },
  }

  request.hooks?.onAttemptStart?.({ attempt, start: Date.now() })
  request.hooks?.onRequestSent?.({
    maxOutputTokens: 4096,
    requestId,
    response,
  })
  request.hooks?.onProviderEvent?.({ type: 'ttfb', ms: 7 })
  request.hooks?.onProviderEvent?.({ type: 'bytes', bytes: 13 })

  return {
    requestId,
    responseHeaders,
    maxOutputTokens: 4096,
    stream: {
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        await streamReleased
      },
    },
  }
}

function makeEmptyStreamResult(
  request: StreamRequest,
  attempt: number,
): ProviderStreamResult {
  const requestId = `req_empty_stream_${attempt}`
  const responseHeaders = new Headers({ 'x-request-id': requestId })
  request.hooks?.onAttemptStart?.({ attempt, start: Date.now() })
  request.hooks?.onRequestSent?.({
    maxOutputTokens: 4096,
    requestId,
    response: { headers: responseHeaders },
  })
  request.hooks?.onProviderEvent?.({ type: 'ttfb', ms: 5 })

  return {
    requestId,
    responseHeaders,
    maxOutputTokens: 4096,
    stream: {
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {},
    },
  }
}

type FakeProviderState = typeof fakeProviderState

class FakeFallbackProvider implements LLMProvider {
  readonly name = 'openai-chat'
  private ext: { retryOptions?: Record<string, unknown> } | undefined

  constructor(private readonly state: FakeProviderState, ext?: unknown) {
    this.ext = ext as typeof this.ext
  }

  async *createStream(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, ProviderStreamResult> {
    return yield* this.bind().createStream(request)
  }

  bind(ext?: unknown): BoundProvider {
    const boundProvider = new FakeFallbackProvider(
      this.state,
      ext ?? this.ext,
    )
    return {
      createStream: async function* (
        request: StreamRequest,
      ): AsyncGenerator<
        SystemAPIErrorMessage,
        ProviderStreamResult
      > {
        if (this.state.mode === 'watchdog_retry') {
          this.state.streamAttempts++
          const attempt = this.state.streamAttempts
          return attempt === 1
            ? makeWatchdogStreamResult(request, attempt)
            : makeSuccessfulRetryStreamResult(request, attempt)
        }
        if (
          this.state.mode === 'empty_stream_retry' ||
          this.state.mode === 'stream_fallback'
        ) {
          this.state.streamAttempts++
          const attempt = this.state.streamAttempts
          const streamError = this.state.streamError
          return attempt === 1
            ? this.state.mode === 'stream_fallback'
              ? {
                  requestId: 'req_stream_trace',
                  responseHeaders: undefined,
                  maxOutputTokens: 4096,
                  stream: {
                    async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
                      yield {
                        type: 'response_start',
                        response: {
                          id: 'resp_trace',
                          model: 'gpt-4o',
                          stopReason: null,
                          usage: { inputTokens: 1, outputTokens: 0 },
                        },
                      }
                      throw streamError
                    },
                  },
                }
              : makeEmptyStreamResult(request, attempt)
            : makeSuccessfulRetryStreamResult(request, attempt)
        }

        return yield* withRetry(
          async () => ({}),
          async (_client, attempt) => {
            this.state.streamAttempts++
            if (this.state.mode === 'stream_creation_404') {
              throw new LLMAPIError('Not Found', {
                status: 404,
                request_id: 'req_stream_404',
              })
            }
            if (this.state.mode === 'stream_creation_model_not_found') {
              throw new LLMAPIError('model gpt-4o not found', {
                status: 404,
                request_id: 'req_stream_model_missing',
              })
            }

            const streamError = this.state.streamError
            return {
              requestId: 'req_stream_trace',
              responseHeaders: undefined,
              maxOutputTokens: 4096,
              stream: {
                async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
                  yield {
                    type: 'response_start',
                    response: {
                      id: 'resp_trace',
                      model: 'gpt-4o',
                      stopReason: null,
                      usage: { inputTokens: 1, outputTokens: 0 },
                    },
                  }
                  throw streamError
                },
              }
            }
          },
          {
            protocol: 'openai-chat',
            model: 'gpt-4o',
            thinkingConfig: { type: 'disabled' },
            maxRetries: 10,
            deferModelNotFoundFallback: true,
            ...boundProvider.ext?.retryOptions,
          },
        )
      }.bind(boundProvider),
      createNonStreamingFallback: async function* (
        _request: StreamRequest,
      ): AsyncGenerator<never, { message: LLMMessage; requestId: string }> {
        return {
          message: makeFallbackMessage(),
          requestId: 'req_fallback_trace',
        }
      },
    }
  }

  classifyError() {
    return { retryable: false, type: 'other' as const }
  }

  calculateCost() {
    return null
  }

  wrapError(error: unknown): LLMAPIError {
    if (error instanceof LLMAPIError) return error
    return new LLMAPIError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    )
  }

  inference(): never {
    throw new Error('not used')
  }

  countTokens(): Promise<number | null> {
    return Promise.resolve(null)
  }
}

function projectTrace(event: RecoveryTraceEvent) {
  return {
    protocol: event.protocol,
    querySource: event.querySource,
    reason: event.reason,
    intent: event.intent,
    action: event.action,
    outcome: event.outcome,
    repeatPolicy: event.repeatPolicy,
    requestId: event.requestId,
    streamPhase: event.streamPhase,
    ...(event.timeoutKind ? { timeoutKind: event.timeoutKind } : {}),
    ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
    innerCause: event.innerCause,
    ...(event.ttfbMs !== undefined ? { ttfbMs: event.ttfbMs } : {}),
    ...(event.bytesReceived !== undefined
      ? { bytesReceived: event.bytesReceived }
      : {}),
    ...(event.safeHeaders !== undefined
      ? { safeHeaders: event.safeHeaders }
      : {}),
    final: event.final,
  }
}

type QueryModelWithStreamingInput = Parameters<typeof queryModelWithStreaming>[0]

function makeModelOptions(
  traces: RecoveryTraceEvent[],
): QueryModelWithStreamingInput['options'] {
  return {
    getToolPermissionContext: async () => ({
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    }),
    model: 'gpt-4o',
    isNonInteractiveSession: true,
    querySource: 'sdk',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    onRecoveryTrace: event => traces.push(event),
  }
}

async function collect(
  gen: AsyncGenerator<unknown, unknown>,
): Promise<unknown[]> {
  const messages: unknown[] = []
  for await (const message of gen) {
    messages.push(message)
  }
  return messages
}

describe('stream fallback recovery trace golden fixture', () => {
  beforeEach(() => {
    fakeProviderState.mode = 'stream_fallback'
    fakeProviderState.streamError = new Error(
      'missing response_start before block_delta',
    )
    fakeProviderState.streamAttempts = 0
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('retries local stream-shape errors before changing request mode', async () => {
    const traces: RecoveryTraceEvent[] = []
    const messages = await collect(
      queryModelWithStreaming({
        messages: [],
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: makeModelOptions(traces),
      }),
    )

    expect(messages.some(message => (message as { type?: string }).type === 'assistant')).toBe(true)
    expect(fakeProviderState.streamAttempts).toBe(2)
    expect(new Set(traces.map(trace => trace.traceId)).size).toBe(1)
    expect(traces[0]?.traceId).toMatch(/^api-stream-consumption-\d+$/)
    expect(traces.map(projectTrace)).toEqual(
      readFixture('api-recovery/stream-fallback-trace.json'),
    )
    expect(traces.some(trace => trace.action === 'non_streaming_fallback')).toBe(false)
  })

  it('retries empty provider streams instead of switching request mode', async () => {
    fakeProviderState.mode = 'empty_stream_retry'
    const traces: RecoveryTraceEvent[] = []
    const messages = await collect(
      queryModelWithStreaming({
        messages: [],
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: makeModelOptions(traces),
      }),
    )

    expect(messages.some(message => (message as { type?: string }).type === 'assistant')).toBe(true)
    expect(fakeProviderState.streamAttempts).toBe(2)
    expect(traces.map(trace => trace.action)).toEqual([
      'retry_backoff',
    ])
    expect(traces[0]).toMatchObject({
      protocol: 'openai-chat',
      querySource: 'sdk',
      reason: 'malformed_response',
      intent: 'retry_transient_failure',
      action: 'retry_backoff',
      outcome: 'retrying',
      operation: 'stream',
      streamPhase: 'streaming',
      requestId: 'req_empty_stream_1',
      final: false,
    })
    expect(traces.some(trace => trace.action === 'non_streaming_fallback')).toBe(false)
  })

  it('emits immediate non_streaming_fallback trace for generic stream-creation 404', async () => {
    fakeProviderState.mode = 'stream_creation_404'
    const traces: RecoveryTraceEvent[] = []
    const messages = await collect(
      queryModelWithStreaming({
        messages: [],
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: makeModelOptions(traces),
      }),
    )

    expect(messages.some(message => (message as { type?: string }).type === 'assistant')).toBe(true)
    expect(fakeProviderState.streamAttempts).toBe(1)
    expect(new Set(traces.map(trace => trace.traceId)).size).toBe(1)
    expect(traces[0]?.traceId).toMatch(
      /^api-stream-creation-\d+$/,
    )
    expect(traces.map(projectTrace)).toEqual(
      readFixture('api-recovery/stream-creation-404-fallback-trace.json'),
    )
  })

  it('routes stream-creation model_not_found through boundary fallback decision', async () => {
    fakeProviderState.mode = 'stream_creation_model_not_found'
    const traces: RecoveryTraceEvent[] = []

    await expect(
      collect(
        queryModelWithStreaming({
          messages: [],
          systemPrompt: asSystemPrompt([]),
          thinkingConfig: { type: 'disabled' },
          tools: [],
          signal: new AbortController().signal,
          options: {
            ...makeModelOptions(traces),
            fallbackModel: 'gpt-4o-mini',
            recoveryPolicyGate: {
              allowActions: ['retry_same_model', 'switch_model'],
              switchModelOn: ['model_not_found'],
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'FallbackTriggeredError',
      originalModel: 'gpt-4o',
      fallbackModel: 'gpt-4o-mini',
    })

    expect(traces).toHaveLength(2)
    expect(traces.map(trace => trace.action)).toEqual([
      'fallback_model',
      'fallback_model',
    ])
    expect(traces.map(trace => trace.outcome)).toEqual([
      'delegated',
      'fallback_triggered',
    ])
    expect(traces[0]).toMatchObject({
      reason: 'model_not_found',
      final: true,
      policyGate: {
        actionAllowed: true,
        reasonAllowed: true,
      },
    })
    expect(traces[1]).toMatchObject({
      reason: 'model_not_found',
      final: true,
      toModel: 'gpt-4o-mini',
      policyGate: {
        actionAllowed: true,
        reasonAllowed: true,
      },
    })
  })

  it('does not bypass route policy for stream-creation model_not_found', async () => {
    fakeProviderState.mode = 'stream_creation_model_not_found'
    const traces: RecoveryTraceEvent[] = []
    const messages = await collect(
      queryModelWithStreaming({
        messages: [],
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: {
          ...makeModelOptions(traces),
          fallbackModel: 'gpt-4o-mini',
          recoveryPolicyGate: {
            allowActions: ['retry_same_model'],
            switchModelOn: ['model_not_found'],
          },
        },
      }),
    )

    expect(messages.some(message => (message as { type?: string }).type === 'assistant')).toBe(true)
    expect(traces.map(trace => trace.action)).toEqual(['fail_fast'])
    expect(traces[0]).toMatchObject({
      reason: 'model_not_found',
      outcome: 'failing',
      final: true,
      policyGate: {
        actionAllowed: false,
        reasonAllowed: true,
      },
    })
  })

  it('emits stream watchdog retry trace with stream observability fields', async () => {
    vi.stubEnv('AXIOMATE_ENABLE_STREAM_WATCHDOG', '1')
    vi.stubEnv('AXIOMATE_STREAM_IDLE_TIMEOUT_MS', '1')
    fakeProviderState.mode = 'watchdog_retry'

    const traces: RecoveryTraceEvent[] = []
    const messages = await collect(
      queryModelWithStreaming({
        messages: [],
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: makeModelOptions(traces),
      }),
    )

    expect(messages.some(message => (message as { type?: string }).type === 'assistant')).toBe(true)
    expect(fakeProviderState.streamAttempts).toBe(2)
    expect(new Set(traces.map(trace => trace.traceId)).size).toBe(1)
    expect(traces[0]?.traceId).toMatch(/^api-stream-consumption-\d+$/)
    expect(traces.map(projectTrace)).toEqual(
      readFixture('api-recovery/stream-watchdog-trace.json'),
    )
  })
})
