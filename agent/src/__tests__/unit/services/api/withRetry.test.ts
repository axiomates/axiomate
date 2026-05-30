import { describe, expect, it } from 'vitest'

import {
  CannotRetryError,
  FallbackTriggeredError,
  MAX_PROVIDER_RETRY_AFTER_MS,
  getRecoveryDelay,
  safeRecoveryTraceHeaders,
  type RetryOptions,
  withRetry,
} from '../../../../services/api/withRetry.js'
import { LLMAPIError } from '../../../../services/api/streamTypes.js'
import type { RecoveryTraceEvent } from '../../../../services/api/recoveryTrace.js'

async function consume<T>(
  gen: AsyncGenerator<unknown, T>,
): Promise<T> {
  for (;;) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

const retryOptions = {
  model: 'provider-main-model',
  thinkingConfig: { type: 'disabled' as const },
}

function withTrace(
  traces: RecoveryTraceEvent[],
  overrides: Partial<RetryOptions> = {},
): RetryOptions {
  return {
    ...retryOptions,
    ...overrides,
    onRecoveryTrace: event => traces.push(event),
  }
}

describe('withRetry semantic recovery', () => {
  it('does not blindly retry compression-class payload errors', async () => {
    let calls = 0
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        calls++
        throw new LLMAPIError('Request Entity Too Large', { status: 413 })
      },
      withTrace(traces, {
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(1)
    expect(traces).toMatchObject([
      {
        reason: 'payload_too_large',
        action: 'request_compaction',
        outcome: 'delegated',
      },
    ])
  })

  it('stops retrying max_tokens_too_large after dropping max_tokens once', async () => {
    let calls = 0
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        calls++
        throw new LLMAPIError('max_tokens is too large', { status: 400 })
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(2)
    expect(traces.map(t => t.action)).toEqual([
      'drop_max_tokens',
      'fail_fast',
    ])
    expect(traces[0]?.mutation).toEqual(['drop_max_tokens'])
    expect(traces[0]?.protocol).toBe('openai-chat')
  })

  it('switches to a distinct fallback model for model_not_found', async () => {
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('model not found', { status: 404 })
      },
      withTrace(traces, {
        fallbackModel: 'provider-fallback-model',
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(FallbackTriggeredError)
    expect(traces.at(-1)).toMatchObject({
      reason: 'model_not_found',
      action: 'fallback_model',
      outcome: 'fallback_triggered',
    })
  })

  it('emits the caller-supplied recovery operation on retry traces', async () => {
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('bad gateway', { status: 502 })
      },
      withTrace(traces, {
        maxRetries: 0,
        operation: 'non_streaming_fallback',
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces.at(-1)).toMatchObject({
      reason: 'server_error',
      operation: 'non_streaming_fallback',
    })
  })

  it('honors route policy gates before switching models', async () => {
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('model not found', { status: 404 })
      },
      withTrace(traces, {
        fallbackModel: 'provider-fallback-model',
        recoveryTraceContext: {
          routeId: 'quality',
          fromModel: 'provider-main-model',
          toModel: 'provider-fallback-model',
          chainIndex: 0,
          policyGate: {
            allowActions: ['retry_same_model', 'switch_model'],
            switchModelOn: ['rate_limit'],
          },
        },
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces.at(-1)).toMatchObject({
      reason: 'model_not_found',
      action: 'fail_fast',
      routeId: 'quality',
      fromModel: 'provider-main-model',
      toModel: 'provider-fallback-model',
      chainIndex: 0,
      policyGate: {
        actionAllowed: true,
        reasonAllowed: false,
      },
    })
  })

  it('does not bypass route policy gates for repeated overloaded fallback', async () => {
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('overloaded', { status: 529 })
      },
      withTrace(traces, {
        fallbackModel: 'provider-fallback-model',
        querySource: 'sdk',
        maxRetries: 10,
        recoveryTraceContext: {
          routeId: 'quality',
          fromModel: 'provider-main-model',
          toModel: 'provider-fallback-model',
          chainIndex: 0,
          policyGate: {
            allowActions: ['retry_same_model', 'switch_model'],
            switchModelOn: ['rate_limit'],
          },
        },
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces.map(t => t.action)).toEqual([
      'retry_backoff',
      'retry_backoff',
      'fail_fast',
    ])
    expect(traces.at(-1)).toMatchObject({
      reason: 'overloaded',
      outcome: 'failing',
      policyGate: {
        actionAllowed: true,
        reasonAllowed: false,
      },
    })
  })

  it('recomputes route policy gates for each observed failure reason', async () => {
    let calls = 0
    const traces: RecoveryTraceEvent[] = []
    const policyGate = {
      allowActions: ['retry_same_model', 'switch_model'],
      switchModelOn: ['rate_limit'],
    }
    const gen = withRetry(
      async () => ({}),
      async () => {
        calls++
        if (calls === 1) {
          throw new LLMAPIError('rate limited', { status: 429 })
        }
        throw new LLMAPIError('model not found', { status: 404 })
      },
      withTrace(traces, {
        fallbackModel: 'provider-fallback-model',
        maxRetries: 1,
        recoveryTraceContext: {
          routeId: 'quality',
          fromModel: 'provider-main-model',
          toModel: 'provider-fallback-model',
          chainIndex: 0,
          policyGate,
        },
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces.map(t => t.reason)).toEqual(['rate_limit', 'model_not_found'])
    expect(traces.map(t => t.action)).toEqual(['retry_backoff', 'fail_fast'])
    expect(traces[0]).toMatchObject({
      reason: 'rate_limit',
      policyGate: {
        actionAllowed: true,
        reasonAllowed: true,
      },
    })
    expect(traces.at(-1)).toMatchObject({
      reason: 'model_not_found',
      outcome: 'failing',
      policyGate: {
        actionAllowed: true,
        reasonAllowed: false,
      },
    })
    expect(policyGate).toEqual({
      allowActions: ['retry_same_model', 'switch_model'],
      switchModelOn: ['rate_limit'],
    })
  })

  it('can defer model_not_found fallback for stream-creation routing', async () => {
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('model not found', { status: 404 })
      },
      withTrace(traces, {
        fallbackModel: 'provider-fallback-model',
        deferModelNotFoundFallback: true,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces).toMatchObject([
      {
        reason: 'model_not_found',
        intent: 'switch_to_fallback_model',
        action: 'fallback_model',
        outcome: 'delegated',
        final: true,
      },
    ])
  })

  it('does not defer model_not_found past route policy gates', async () => {
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('model not found', { status: 404 })
      },
      withTrace(traces, {
        fallbackModel: 'provider-fallback-model',
        deferModelNotFoundFallback: true,
        recoveryTraceContext: {
          policyGate: {
            allowActions: ['retry_same_model'],
            switchModelOn: ['model_not_found'],
          },
        },
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces).toMatchObject([
      {
        reason: 'model_not_found',
        intent: 'fail_unrecoverable',
        action: 'fail_fast',
        outcome: 'failing',
        final: true,
        policyGate: {
          actionAllowed: false,
          reasonAllowed: true,
        },
      },
    ])
  })

  it('does not reinterpret provider-policy 404 as stream endpoint fallback', async () => {
    let calls = 0
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        calls++
        throw new LLMAPIError(
          'No endpoints available matching your guardrail restrictions and data policy.',
          { status: 404 },
        )
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        deferModelNotFoundFallback: true,
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(1)
    expect(traces[0]).toMatchObject({
      reason: 'provider_policy_blocked',
      statusCode: 404,
      intent: 'fail_unrecoverable',
      action: 'fail_fast',
      outcome: 'failing',
      final: true,
    })
  })

  it('delegates generic 404 stream creation to non-streaming fallback routing immediately', async () => {
    let calls = 0
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        calls++
        throw new LLMAPIError('Not Found', { status: 404 })
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        deferModelNotFoundFallback: true,
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(1)
    expect(traces[0]).toMatchObject({
      reason: 'stream_endpoint_not_found',
      statusCode: 404,
      intent: 'switch_to_non_streaming',
      action: 'non_streaming_fallback',
      outcome: 'delegated',
      final: true,
    })
  })

  it('switches to a distinct fallback model for non-retryable semantic fallback hints', async () => {
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('insufficient credits', { status: 402 })
      },
      {
        ...retryOptions,
        fallbackModel: 'provider-fallback-model',
      },
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(FallbackTriggeredError)
  })

  it('omits unsupported request fields once before failing fast', async () => {
    let calls = 0
    const omittedFields: (string[] | undefined)[] = []
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async (_client, _attempt, context) => {
        calls++
        omittedFields.push(context.omittedRequestFields)
        throw new LLMAPIError('Unsupported parameter: temperature', {
          status: 400,
          error: { error: { code: 'unsupported_parameter', param: 'temperature' } },
        })
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(2)
    expect(omittedFields).toEqual([undefined, ['temperature']])
    expect(traces.map(t => t.action)).toEqual([
      'omit_request_fields',
      'fail_fast',
    ])
  })

  it('records observation history across changing failure reasons', async () => {
    let calls = 0
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        calls++
        if (calls === 1) {
          throw new LLMAPIError('Unsupported parameter: temperature', {
            status: 400,
            error: {
              error: {
                code: 'unsupported_parameter',
                param: 'temperature',
              },
            },
          })
        }
        throw new LLMAPIError('Bad Gateway', { status: 502 })
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        maxRetries: 1,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces).toMatchObject([
      {
        traceId: expect.stringMatching(/^api-recovery-\d+$/),
        observationId: 1,
        decisionId: 1,
        reason: 'unsupported_parameter',
        previousReason: undefined,
        previousIntent: undefined,
        previousAction: undefined,
        isFirstFailure: true,
        isFirstFailureForReason: true,
        consecutiveSameReason: 1,
        action: 'omit_request_fields',
        repeatPolicy: 'repeatable',
        final: false,
      },
      {
        traceId: traces[0]!.traceId,
        observationId: 2,
        decisionId: 2,
        reason: 'server_error',
        previousReason: 'unsupported_parameter',
        previousIntent: 'omit_unsupported_request_fields',
        previousAction: 'omit_request_fields',
        isFirstFailure: false,
        isFirstFailureForReason: true,
        consecutiveSameReason: 1,
        action: 'fail_fast',
        repeatPolicy: 'outer_policy',
        final: true,
      },
    ])
    expect(new Set(traces.map(trace => trace.traceId)).size).toBe(1)
  })

  it('emits a diagnostic recovered trace without adding a recovery decision', async () => {
    let calls = 0
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        calls++
        if (calls === 1) {
          throw new LLMAPIError('Unsupported parameter: temperature', {
            status: 400,
            error: {
              error: {
                code: 'unsupported_parameter',
                param: 'temperature',
              },
            },
          })
        }
        return 'ok'
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).resolves.toBe('ok')
    expect(traces).toMatchObject([
      {
        observationId: 1,
        decisionId: 1,
        attempt: 1,
        action: 'omit_request_fields',
        outcome: 'retrying',
        final: false,
      },
      {
        observationId: 1,
        decisionId: 1,
        attempt: 2,
        action: 'omit_request_fields',
        outcome: 'recovered',
        final: true,
      },
    ])
    expect(new Set(traces.map(trace => trace.traceId)).size).toBe(1)
  })

  it('strips Responses reasoning replay once before failing fast', async () => {
    let calls = 0
    const flags: (boolean | undefined)[] = []
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async (_client, _attempt, context) => {
        calls++
        flags.push(context.stripReasoningReplay)
        throw new LLMAPIError(
          'Encrypted content for item rs_123 could not be verified',
          { status: 400 },
        )
      },
      withTrace(traces, {
        protocol: 'openai-responses',
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(2)
    expect(flags).toEqual([undefined, true])
    expect(traces.map(t => t.action)).toEqual([
      'strip_reasoning_replay',
      'fail_fast',
    ])
  })

  it('strips JSON schema pattern/format once before failing fast', async () => {
    let calls = 0
    const flags: (boolean | undefined)[] = []
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async (_client, _attempt, context) => {
        calls++
        flags.push(context.stripJsonSchemaKeywords)
        throw new LLMAPIError('error parsing grammar: json-schema-to-grammar', {
          status: 400,
        })
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(2)
    expect(flags).toEqual([undefined, true])
    expect(traces.map(t => t.action)).toEqual([
      'strip_json_schema_keywords',
      'fail_fast',
    ])
  })

  it('strips Grok slash enums once before failing fast', async () => {
    let calls = 0
    const flags: (boolean | undefined)[] = []
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async (_client, _attempt, context) => {
        calls++
        flags.push(context.stripSlashEnums)
        throw new LLMAPIError('Invalid arguments passed to the model', {
          status: 400,
        })
      },
      withTrace(traces, {
        protocol: 'openai-responses',
        model: 'grok-4.3',
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(2)
    expect(flags).toEqual([undefined, true])
    expect(traces.map(t => t.action)).toEqual([
      'strip_slash_enums',
      'fail_fast',
    ])
    expect(traces[0]).toMatchObject({
      reason: 'slash_enum_unsupported',
      intent: 'sanitize_slash_enum_schema',
      mutation: ['strip_slash_enums'],
      ruleId: 'strip-grok-slash-enums',
    })
  })

  it('retries once after choosing image payload rewrite profile', async () => {
    let calls = 0
    const profiles: unknown[] = []
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async (_client, _attempt, context) => {
        calls++
        profiles.push(context.imageRecoveryProfile)
        throw new LLMAPIError('image exceeds 5 MB maximum', { status: 400 })
      },
      withTrace(traces, {
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(2)
    expect(profiles).toEqual([undefined, 'aggressive_size_compression'])
    expect(traces.map(trace => trace.action)).toEqual([
      'rewrite_image_payload',
      'fail_fast',
    ])
    expect(traces[0]).toMatchObject({
      reason: 'image_too_large',
      intent: 'rewrite_image_payload_for_retry',
      action: 'rewrite_image_payload',
      outcome: 'retrying',
      mutation: ['image_payload_rewrite:aggressive_size_compression'],
      imageRecoveryProfile: 'aggressive_size_compression',
      final: false,
    })
  })

  it('delegates Anthropic long-context tier lowering with trace and retry context', async () => {
    let calls = 0
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        calls++
        throw new LLMAPIError(
          'Rate limited: extra usage tier required for long context requests',
          { status: 429 },
        )
      },
      withTrace(traces, {
        protocol: 'anthropic',
        maxRetries: 10,
      }),
    )

    await expect(consume(gen)).rejects.toMatchObject({
      retryContext: {
        lowerContextTier: true,
      },
    })
    expect(calls).toBe(1)
    expect(traces).toMatchObject([
      {
        protocol: 'anthropic',
        reason: 'long_context_tier',
        intent: 'lower_long_context_tier',
        action: 'lower_context_tier',
        outcome: 'delegated',
        mutation: ['lower_context_tier'],
        final: true,
      },
    ])
  })

  it('does not trigger a fallback loop when fallback model equals current model', async () => {
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('model not found', { status: 404 })
      },
      {
        ...retryOptions,
        fallbackModel: 'provider-main-model',
      },
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
  })

  it('copies stream observability context into recovery trace events', async () => {
    const traces: RecoveryTraceEvent[] = []
    const cause = new Error('socket closed')
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('Bad Gateway', {
          status: 502,
          cause,
          headers: { 'retry-after': '2' },
          request_id: 'req_error_123',
        })
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        maxRetries: 0,
        recoveryTraceContext: {
          requestId: 'req_stream_123',
          ttfbMs: 42,
          elapsedMs: 420,
          bytesReceived: 2048,
          streamPhase: 'streaming',
          safeHeaders: {
            'retry-after': '2',
            'x-ratelimit-remaining-requests': '3',
          },
        },
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces[0]).toMatchObject({
      requestId: 'req_stream_123',
      ttfbMs: 42,
      elapsedMs: 420,
      bytesReceived: 2048,
      streamPhase: 'streaming',
      innerCause: 'Error: socket closed',
      safeHeaders: {
        'retry-after': '2',
        'x-ratelimit-remaining-requests': '3',
      },
    })
  })

  it('copies request id and direct API errors into recovery traces', async () => {
    const traces: RecoveryTraceEvent[] = []
    const gen = withRetry(
      async () => ({}),
      async () => {
        throw new LLMAPIError('Not Found', {
          status: 404,
          request_id: 'req_direct_404',
        })
      },
      withTrace(traces, {
        protocol: 'openai-chat',
        maxRetries: 0,
      }),
    )

    await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(traces[0]).toMatchObject({
      requestId: 'req_direct_404',
      innerCause: 'LLMAPIError: Not Found',
      reason: 'unknown',
    })
  })

  it('keeps only diagnostic-safe headers in recovery traces', () => {
    expect(
      safeRecoveryTraceHeaders({
        authorization: 'Bearer secret',
        'x-api-key': 'secret',
        'retry-after': '2',
        'x-ratelimit-remaining-requests': '9',
      }),
    ).toEqual({
      'retry-after': '2',
      'x-ratelimit-remaining-requests': '9',
    })
  })

  it('caps provider retry-after delays at the recovery policy ceiling', () => {
    expect(
      getRecoveryDelay(1, {
        retryAfterMs: MAX_PROVIDER_RETRY_AFTER_MS + 60_000,
      }),
    ).toBe(MAX_PROVIDER_RETRY_AFTER_MS)
  })
})
