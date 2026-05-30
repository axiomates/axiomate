import { describe, expect, it } from 'vitest'

import { projectApiFailureCards } from '../../../../services/api/apiFailureCards.js'
import type { SafeApiRecoveryTraceEvent } from '../../../../services/api/apiRecoveryDiagnostics.js'

function trace(
  overrides: Partial<SafeApiRecoveryTraceEvent> = {},
): SafeApiRecoveryTraceEvent {
  return {
    timestamp: '2026-05-29T00:00:00.000Z',
    traceId: 'trace-1',
    protocol: 'openai-chat',
    model: 'model-a',
    attempt: 1,
    maxAttempts: 2,
    reason: 'unsupported_parameter',
    intent: 'omit_unsupported_request_fields',
    action: 'omit_request_fields',
    outcome: 'retrying',
    retryable: true,
    shouldCompress: false,
    shouldFallback: false,
    final: false,
    ...overrides,
  }
}

describe('projectApiFailureCards', () => {
  it('groups multi-attempt traces by trace id and preserves attempt order', () => {
    const cards = projectApiFailureCards([
      trace({
        timestamp: '2026-05-29T00:00:02.000Z',
        attempt: 2,
        reason: 'server_error',
        intent: 'switch_to_fallback_model',
        action: 'fallback_model',
        outcome: 'fallback_triggered',
        statusCode: 502,
        fromModel: 'model-a',
        toModel: 'model-b',
        final: true,
      }),
      trace({
        timestamp: '2026-05-29T00:00:01.000Z',
        attempt: 1,
        statusCode: 400,
        mutation: ['omit:temperature'],
      }),
    ])

    expect(cards).toHaveLength(1)
    expect(cards[0]?.status).toBe('switched_model')
    expect(cards[0]?.severity).toBe('warning')
    expect(cards[0]?.modelPath).toBe('model-a -> model-b')
    expect(cards[0]?.timeline.map(item => item.reason)).toEqual([
      'unsupported_parameter',
      'server_error',
    ])
  })

  it('uses trace sequence to resolve same-millisecond event order', () => {
    const cards = projectApiFailureCards([
      trace({
        sequence: 2,
        timestamp: '2026-05-29T00:00:00.000Z',
        reason: 'model_not_found',
        intent: 'switch_to_fallback_model',
        action: 'fallback_model',
        outcome: 'fallback_triggered',
        fromModel: 'model-a',
        toModel: 'model-b',
        final: true,
      }),
      trace({
        sequence: 1,
        timestamp: '2026-05-29T00:00:00.000Z',
        reason: 'model_not_found',
        intent: 'switch_to_fallback_model',
        action: 'fallback_model',
        outcome: 'delegated',
        final: true,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'switched_model',
      summary: '2 events; switched model-a -> model-b.',
    })
    expect(cards[0]?.timeline.map(item => item.outcome)).toEqual([
      'delegated',
      'fallback_triggered',
    ])
  })

  it('groups withRetry session traces by stable retry trace id', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: 'api-recovery-42',
        timestamp: '2026-05-29T00:00:02.000Z',
        observationId: 2,
        decisionId: 2,
        attempt: 2,
        reason: 'server_error',
        intent: 'fail_recovery_exhausted',
        action: 'fail_fast',
        outcome: 'failing',
        statusCode: 502,
        final: true,
      }),
      trace({
        traceId: 'api-recovery-42',
        timestamp: '2026-05-29T00:00:01.000Z',
        observationId: 1,
        decisionId: 1,
        attempt: 1,
        reason: 'unsupported_parameter',
        intent: 'omit_unsupported_request_fields',
        action: 'omit_request_fields',
        outcome: 'retrying',
        statusCode: 400,
        mutation: ['omit:temperature'],
        final: false,
      }),
    ])

    expect(cards).toHaveLength(1)
    expect(cards[0]?.timeline.map(item => item.attempt)).toEqual([1, 2])
    expect(cards[0]?.status).toBe('adaptation_failed')
  })

  it('keeps unrelated one-shot auxiliary failures separate by unique trace id', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: 'api-side_query-failure-2',
        operation: 'side_query',
        querySource: 'session_search',
        timestamp: '2026-05-29T00:00:02.000Z',
        reason: 'server_error',
        intent: 'fail_recovery_exhausted',
        action: 'fail_fast',
        outcome: 'failing',
        statusCode: 502,
        final: true,
      }),
      trace({
        traceId: 'api-side_query-failure-1',
        operation: 'side_query',
        querySource: 'session_search',
        timestamp: '2026-05-29T00:00:01.000Z',
        reason: 'server_error',
        intent: 'fail_recovery_exhausted',
        action: 'fail_fast',
        outcome: 'failing',
        statusCode: 502,
        final: true,
      }),
    ])

    expect(cards).toHaveLength(2)
    expect(cards.map(card => card.advanced.traceId)).toEqual([
      'api-side_query-failure-2',
      'api-side_query-failure-1',
    ])
  })

  it('maps final auth failures to error cards with concrete guidance', () => {
    const cards = projectApiFailureCards([
      trace({
        reason: 'auth_permanent',
        intent: 'fail_unrecoverable',
        action: 'fail_fast',
        outcome: 'failing',
        statusCode: 401,
        final: true,
      }),
    ])

    expect(cards[0]?.severity).toBe('error')
    expect(cards[0]?.title).toBe('API authentication failed')
    expect(cards[0]?.nextAction).toContain('models["model-a"].apiKey')
  })

  it('uses fallback grouping when trace id is absent', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: undefined,
        operation: 'count_tokens',
        auxiliaryTask: 'tokenCounter',
        model: 'model-a',
        timestamp: '2026-05-29T00:00:20.000Z',
        attempt: 2,
      }),
      trace({
        traceId: undefined,
        operation: 'count_tokens',
        auxiliaryTask: 'tokenCounter',
        model: 'model-a',
        timestamp: '2026-05-29T00:00:10.000Z',
        attempt: 1,
      }),
    ])

    expect(cards).toHaveLength(1)
    expect(cards[0]?.scope).toBe('auxiliary:tokenCounter')
    expect(cards[0]?.timeline.map(item => item.attempt)).toEqual([1, 2])
  })

  it('projects main streaming retry traces into main response cards', () => {
    const cards = projectApiFailureCards([
      trace({
        operation: 'stream',
        reason: 'timeout',
        intent: 'retry_transient_failure',
        action: 'retry_backoff',
        outcome: 'retrying',
        statusCode: 408,
        streamPhase: 'streaming',
        timeoutKind: 'stream_idle_timeout',
        timeoutMs: 90_000,
        ttfbMs: 12,
        bytesReceived: 128,
        requestId: 'req-stream',
      }),
    ])

    expect(cards[0]).toMatchObject({
      scope: 'stream',
      impact: 'main response streaming',
      observed: 'timeout · HTTP 408 · phase streaming · request req-stream',
      status: 'retrying',
      severity: 'warning',
    })
    expect(cards[0]?.advanced.timeout).toBe('stream_idle_timeout 90000ms')
    expect(cards[0]?.advanced.elapsed).toBe('TTFB 12ms, 128 bytes')
  })

  it('projects non-streaming fallback traces distinctly from model fallback', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: 'stream-fallback',
        operation: 'non_streaming_fallback',
        reason: 'streaming_unsupported',
        intent: 'switch_to_non_streaming',
        action: 'non_streaming_fallback',
        outcome: 'fallback_triggered',
        streamPhase: 'fallback',
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'switched_request_mode',
      severity: 'warning',
      title: 'API request switched to non-streaming',
      impact: 'non-streaming fallback',
    })
    expect(cards[0]?.nextAction).toContain('explicitly rejected streaming')
  })

  it('projects explicit stream endpoint fallback without unknown wording', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: 'generic-404',
        operation: 'non_streaming_fallback',
        reason: 'stream_endpoint_not_found',
        intent: 'switch_to_non_streaming',
        action: 'non_streaming_fallback',
        outcome: 'fallback_triggered',
        statusCode: 404,
        streamPhase: 'fallback',
        innerCause: 'LLMAPIError: Not Found',
        final: false,
      }),
    ])

    expect(cards[0]).toMatchObject({
      observed:
        'stream_endpoint_not_found · HTTP 404 · phase fallback · LLMAPIError: Not Found',
      status: 'switched_request_mode',
    })
    expect(cards[0]?.advanced.innerCause).toBe('LLMAPIError: Not Found')
    expect(cards[0]?.nextAction).toContain('models["model-a"].baseUrl')
    expect(cards[0]?.nextAction).toContain('streaming endpoint returned 404')
  })

  it('projects completed stream salvage as an informational recovered card', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: 'responses-salvage',
        protocol: 'openai-responses',
        operation: 'stream',
        reason: 'responses_null_output',
        intent: 'salvage_completed_stream_output',
        action: 'salvage_stream_output',
        outcome: 'salvaged',
        streamPhase: 'stream_complete',
        final: true,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'salvaged',
      severity: 'info',
      title: 'API stream recovered from partial output',
      impact: 'main response streaming',
    })
  })

  it('projects auxiliary task failures with task scope', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: 'aux-side-query',
        operation: 'side_query',
        querySource: 'side_question',
        auxiliaryTask: 'permissionExplainer',
        routeId: 'aux-fast',
        reason: 'rate_limit',
        intent: 'switch_to_fallback_model',
        action: 'fallback_model',
        outcome: 'fallback_triggered',
        fromModel: 'fast-a',
        toModel: 'fast-b',
      }),
    ])

    expect(cards[0]).toMatchObject({
      scope: 'auxiliary:permissionExplainer',
      impact: 'side query',
      modelPath: 'fast-a -> fast-b',
      status: 'switched_model',
    })
    expect(cards[0]?.advanced.routeId).toBe('aux-fast')
  })

  it('does not treat fallback candidates as completed model switches', () => {
    const cards = projectApiFailureCards([
      trace({
        routeId: 'quality',
        fromModel: 'model-a',
        toModel: 'model-b',
        reason: 'rate_limit',
        intent: 'respect_provider_retry_after',
        action: 'retry_after',
        outcome: 'retrying',
        delayMs: 1000,
        final: false,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'retrying',
      modelPath: 'model-a',
    })
  })

  it('does not show model fallback candidates as switched during request-mode fallback', () => {
    const cards = projectApiFailureCards([
      trace({
        operation: 'non_streaming_fallback',
        fromModel: 'model-a',
        toModel: 'model-b',
        reason: 'malformed_response',
        intent: 'switch_to_non_streaming',
        action: 'non_streaming_fallback',
        outcome: 'fallback_triggered',
        final: false,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'switched_request_mode',
      modelPath: 'model-a',
    })
  })

  it('projects token counting failures as token counting cards', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: 'count-token-failure',
        operation: 'count_tokens',
        auxiliaryTask: 'tokenCounter',
        reason: 'timeout',
        intent: 'fail_recovery_exhausted',
        action: 'fail_fast',
        outcome: 'failing',
        timeoutKind: 'auxiliary_timeout',
        timeoutMs: 15_000,
        final: true,
      }),
    ])

    expect(cards[0]).toMatchObject({
      scope: 'auxiliary:tokenCounter',
      impact: 'token counting',
      status: 'exhausted',
      severity: 'error',
    })
  })

  it('projects provider verification failures as model validation cards', () => {
    const cards = projectApiFailureCards([
      trace({
        traceId: 'verify-failure',
        operation: 'verify_connection',
        querySource: 'verify_api_key',
        reason: 'auth_permanent',
        intent: 'fail_unrecoverable',
        action: 'fail_fast',
        outcome: 'failing',
        statusCode: 401,
        final: true,
      }),
    ])

    expect(cards[0]).toMatchObject({
      scope: 'verify_api_key',
      impact: 'model validation',
      title: 'API authentication failed',
      severity: 'error',
    })
  })

  it('explains explicit streaming fallback reasons without unknown wording', () => {
    const cards = projectApiFailureCards([
      trace({
        reason: 'streaming_unsupported',
        intent: 'switch_to_non_streaming',
        action: 'non_streaming_fallback',
        outcome: 'fallback_triggered',
        operation: 'non_streaming_fallback',
        streamPhase: 'fallback',
        statusCode: 400,
        final: false,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'switched_request_mode',
      title: 'API request switched to non-streaming',
    })
    expect(cards[0]?.observed).toContain('streaming_unsupported')
    expect(cards[0]?.observed).not.toContain('unknown')
    expect(cards[0]?.nextAction).toContain('explicitly rejected streaming')
  })

  it('marks request-shape adaptation as adapted instead of generic retrying', () => {
    const cards = projectApiFailureCards([
      trace({
        timestamp: '2026-05-29T00:00:02.000Z',
        attempt: 2,
        reason: 'unknown',
        intent: 'retry_transient_failure',
        action: 'retry_backoff',
        outcome: 'retrying',
      }),
      trace({
        timestamp: '2026-05-29T00:00:01.000Z',
        attempt: 1,
        reason: 'unsupported_parameter',
        intent: 'omit_unsupported_request_fields',
        action: 'omit_request_fields',
        outcome: 'retrying',
        mutation: ['omit:temperature'],
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'adapted_request',
      severity: 'info',
      title: 'API request adapted for retry',
    })
    expect(cards[0]?.summary).toContain('omit:temperature')
  })

  it('marks successful retry sessions as recovered instead of still retrying', () => {
    const cards = projectApiFailureCards([
      trace({
        timestamp: '2026-05-29T00:00:02.000Z',
        attempt: 2,
        reason: 'unsupported_parameter',
        intent: 'omit_unsupported_request_fields',
        action: 'omit_request_fields',
        outcome: 'recovered',
        mutation: ['omit:temperature'],
        final: true,
      }),
      trace({
        timestamp: '2026-05-29T00:00:01.000Z',
        attempt: 1,
        reason: 'unsupported_parameter',
        intent: 'omit_unsupported_request_fields',
        action: 'omit_request_fields',
        outcome: 'retrying',
        mutation: ['omit:temperature'],
        final: false,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'recovered',
      severity: 'warning',
      title: 'API request recovered',
      summary: '2 events; recovered after omit_request_fields.',
    })
  })

  it('keeps recovered cards recovered even when model fallback was not allowed', () => {
    const cards = projectApiFailureCards([
      trace({
        reason: 'unsupported_parameter',
        intent: 'omit_unsupported_request_fields',
        action: 'omit_request_fields',
        outcome: 'recovered',
        mutation: ['omit_request_field:temperature'],
        policyGate: {
          allowActions: ['retry_same_model'],
          switchModelOn: ['model_not_found'],
          actionAllowed: false,
          reasonAllowed: true,
        },
        final: true,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'recovered',
      severity: 'warning',
      title: 'API request recovered',
      stoppedReason: undefined,
    })
  })

  it('marks failed request-shape adaptation distinctly', () => {
    const cards = projectApiFailureCards([
      trace({
        timestamp: '2026-05-29T00:00:02.000Z',
        attempt: 2,
        reason: 'format_error',
        intent: 'fail_recovery_exhausted',
        action: 'fail_fast',
        outcome: 'failing',
        final: true,
      }),
      trace({
        timestamp: '2026-05-29T00:00:01.000Z',
        attempt: 1,
        action: 'strip_json_schema_keywords',
        intent: 'sanitize_json_schema_for_grammar',
        mutation: ['strip_schema_keywords:pattern'],
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'adaptation_failed',
      severity: 'error',
      title: 'API request adaptation failed',
    })
    expect(cards[0]?.summary).toContain('latest failure was format_error')
  })

  it('marks compaction delegation as delegated recovery', () => {
    const cards = projectApiFailureCards([
      trace({
        reason: 'context_overflow',
        intent: 'delegate_conversation_compaction',
        action: 'request_compaction',
        outcome: 'delegated',
        shouldCompress: true,
        final: true,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'delegated_recovery',
      severity: 'warning',
      title: 'API recovery delegated to compaction',
    })
    expect(cards[0]?.nextAction).toContain('Let compaction finish')
    expect(cards[0]?.stoppedReason).toBeUndefined()
  })

  it('marks non-compaction delegated recovery distinctly', () => {
    const cards = projectApiFailureCards([
      trace({
        reason: 'long_context_tier',
        intent: 'lower_long_context_tier',
        action: 'lower_context_tier',
        outcome: 'delegated',
        mutation: ['lower_context_tier'],
        final: true,
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'delegated_recovery',
      severity: 'warning',
      title: 'API recovery delegated',
      summary: '1 event; delegated recovery to lower_context_tier.',
    })
    expect(cards[0]?.stoppedReason).toBeUndefined()
  })

  it('marks route policy gates as policy-blocked failures', () => {
    const cards = projectApiFailureCards([
      trace({
        routeId: 'quality',
        reason: 'model_not_found',
        intent: 'fail_unrecoverable',
        action: 'fail_fast',
        outcome: 'failing',
        shouldFallback: true,
        final: true,
        policyGate: {
          allowActions: ['retry_same_model'],
          switchModelOn: ['model_not_found'],
          actionAllowed: false,
          reasonAllowed: true,
        },
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'blocked_by_policy',
      severity: 'error',
      title: 'API fallback blocked by route policy',
      scope: 'route:quality',
      stoppedReason: 'route policy disallowed model fallback',
    })
    expect(cards[0]?.nextAction).toContain('allowActions')
  })

  it('marks route reason gates as policy-blocked model fallback failures', () => {
    const cards = projectApiFailureCards([
      trace({
        routeId: 'quality',
        reason: 'server_error',
        intent: 'fail_recovery_exhausted',
        action: 'fail_fast',
        outcome: 'failing',
        shouldFallback: true,
        final: true,
        policyGate: {
          allowActions: ['retry_same_model', 'switch_model'],
          switchModelOn: ['model_not_found'],
          actionAllowed: true,
          reasonAllowed: false,
        },
      }),
    ])

    expect(cards[0]).toMatchObject({
      status: 'blocked_by_policy',
      severity: 'error',
      title: 'API fallback blocked by route policy',
      stoppedReason: 'route policy disallowed model fallback for server_error',
    })
    expect(cards[0]?.nextAction).toContain('switchModelOn')
  })

  it('points model-not-found guidance to concrete model and route fields', () => {
    const cards = projectApiFailureCards([
      trace({
        reason: 'model_not_found',
        intent: 'fail_unrecoverable',
        action: 'fail_fast',
        outcome: 'failing',
        statusCode: 404,
        final: true,
      }),
    ])

    expect(cards[0]?.nextAction).toContain('models["model-a"].model')
    expect(cards[0]?.nextAction).toContain('models["model-a"].protocol')
    expect(cards[0]?.nextAction).toContain('models["model-a"].baseUrl')
    expect(cards[0]?.nextAction).toContain('/model route show')
  })

  it('points Responses null-output guidance to protocol compatibility', () => {
    const cards = projectApiFailureCards([
      trace({
        protocol: 'openai-responses',
        reason: 'responses_null_output',
        intent: 'fail_recovery_exhausted',
        action: 'fail_fast',
        outcome: 'failing',
        final: true,
      }),
    ])

    expect(cards[0]?.nextAction).toContain('OpenAI Responses null output')
    expect(cards[0]?.nextAction).toContain('models["model-a"].protocol')
    expect(cards[0]?.nextAction).toContain('models["model-a"].baseUrl')
  })
})
