import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ApiProviderDoctorSection,
  _internal,
} from '../../../../components/api/ApiProviderDoctorSection.js'
import {
  appendApiRecoveryTrace,
  clearApiRecoveryTraces,
} from '../../../../services/api/apiRecoveryDiagnostics.js'
import type { RecoveryTraceEvent } from '../../../../services/api/recoveryTrace.js'
import { renderToString } from '../../../../utils/staticRender.js'

function event(): RecoveryTraceEvent {
  return {
    timestamp: '2026-05-29T00:00:00.000Z',
    traceId: 'trace-doctor',
    protocol: 'openai-chat',
    model: 'model-a',
    attempt: 1,
    maxAttempts: 1,
    reason: 'auth',
    intent: 'fail_unrecoverable',
    action: 'fail_fast',
    outcome: 'failing',
    statusCode: 401,
    retryable: false,
    shouldCompress: false,
    shouldFallback: true,
    final: true,
    operation: 'verify_connection',
  }
}

function eventWithTraceId(traceId: string): RecoveryTraceEvent {
  return {
    ...event(),
    traceId,
    timestamp: `2026-05-29T00:00:${traceId.slice(-2)}.000Z`,
  }
}

describe('ApiProviderDoctorSection', () => {
  afterEach(() => {
    clearApiRecoveryTraces()
  })

  it('renders nothing when no API recovery traces exist', () => {
    expect(ApiProviderDoctorSection()).toBeNull()
  })

  it('renders an API Providers section when traces exist', async () => {
    appendApiRecoveryTrace(event())

    const output = await renderToString(<ApiProviderDoctorSection />)

    expect(output).toContain('API Providers')
    expect(output).toContain('[Error] API authentication failed')
    expect(output).toContain('model: model-a')
    expect(output).toContain('observed: auth · HTTP 401')
    expect(output).toContain('next: Check models["model-a"].apiKey')
  })

  it('renders safe advanced API metadata without raw error content', async () => {
    appendApiRecoveryTrace({
      ...event(),
      routeId: 'quality-main',
      ruleId: 'retry-transient',
      requestId: 'req-123',
      innerCause: 'Bearer sk-secret prompt text',
      safeHeaders: {
        authorization: 'Bearer sk-secret',
        'retry-after': '2',
        'x-request-id': 'req-123',
      },
    })

    const output = await renderToString(<ApiProviderDoctorSection />)

    expect(output).toContain('request: req-123')
    expect(output).toContain('advanced: op=verify_connection protocol=openai-chat route=quality-main')
    expect(output).toContain('rules=retry-transient headers=retry-after:2,x-request-id:req-123')
    expect(output).not.toContain('sk-secret')
    expect(output).not.toContain('prompt text')
    expect(output).not.toContain('authorization')
  })

  it('renders stream endpoint fallback observations without bare unknown', async () => {
    appendApiRecoveryTrace({
      ...event(),
      reason: 'stream_endpoint_not_found',
      intent: 'switch_to_non_streaming',
      action: 'non_streaming_fallback',
      outcome: 'fallback_triggered',
      statusCode: 404,
      retryable: true,
      shouldFallback: false,
      operation: 'non_streaming_fallback',
      streamPhase: 'fallback',
      innerCause: 'LLMAPIError: Not Found',
      final: false,
    })

    const output = await renderToString(<ApiProviderDoctorSection />)

    expect(output).toContain(
      'observed: stream_endpoint_not_found · HTTP 404 · phase fallback ·',
    )
    expect(output).toContain('LLMAPIError: Not Found')
    expect(output).toContain('cause: LLMAPIError: Not Found')
    expect(output).toContain('timeline: #1/1 stream_endpoint_not_found HTTP 404 ->')
    expect(output).not.toContain('observed: unknown')
  })


  it('renders recovered API sessions as recovered cards', async () => {
    appendApiRecoveryTrace({
      ...event(),
      reason: 'unsupported_parameter',
      intent: 'omit_unsupported_request_fields',
      action: 'omit_request_fields',
      outcome: 'retrying',
      mutation: ['omit_request_field:temperature'],
      statusCode: 400,
      retryable: true,
      shouldFallback: false,
      final: false,
    })
    appendApiRecoveryTrace({
      ...event(),
      timestamp: '2026-05-29T00:00:01.000Z',
      attempt: 2,
      maxAttempts: 2,
      reason: 'unsupported_parameter',
      intent: 'omit_unsupported_request_fields',
      action: 'omit_request_fields',
      outcome: 'recovered',
      mutation: ['omit_request_field:temperature'],
      statusCode: 400,
      retryable: true,
      shouldFallback: false,
      final: true,
    })

    const output = await renderToString(<ApiProviderDoctorSection />)

    expect(output).toContain('[Warning] API request recovered')
    expect(output).toContain('recovery: 2 events; recovered after omit_request_fields.')
    expect(output).toContain('omit_request_fields/recovered')
  })


  it('formats long timelines with the newest attempts and hidden count', () => {
    const text = _internal.formatTimeline([
      {
        timestamp: '2026-05-29T00:00:01.000Z',
        attempt: 1,
        maxAttempts: 5,
        model: 'model-a',
        reason: 'timeout',
        intent: 'retry_transient_failure',
        action: 'retry_backoff',
        outcome: 'retrying',
      },
      {
        timestamp: '2026-05-29T00:00:02.000Z',
        attempt: 2,
        maxAttempts: 5,
        model: 'model-a',
        reason: 'server_error',
        intent: 'retry_transient_failure',
        action: 'retry_backoff',
        outcome: 'retrying',
      },
      {
        timestamp: '2026-05-29T00:00:03.000Z',
        attempt: 3,
        maxAttempts: 5,
        model: 'model-a',
        reason: 'overloaded',
        intent: 'retry_transient_failure',
        action: 'retry_backoff',
        outcome: 'retrying',
      },
      {
        timestamp: '2026-05-29T00:00:04.000Z',
        attempt: 4,
        maxAttempts: 5,
        model: 'model-a',
        reason: 'overloaded',
        intent: 'switch_to_fallback_model',
        action: 'fallback_model',
        outcome: 'fallback_triggered',
        toModel: 'model-b',
      },
    ])

    expect(text).toContain('... 1 earlier')
    expect(text).not.toContain('#1/5')
    expect(text).toContain('#2/5 server_error')
    expect(text).toContain('#4/5 overloaded -> fallback_model/fallback_triggered')
  })

  it('formats compact advanced summaries', () => {
    expect(_internal.advancedSummary({
      id: 'card',
      severity: 'warning',
      status: 'retrying',
      title: 'API request is retrying',
      scope: 'route:quality-main',
      impact: 'main response streaming',
      modelPath: 'model-a',
      observed: 'server_error',
      summary: '1 event; latest action retry_backoff.',
      nextAction: 'Retry later.',
      timeline: [],
      advanced: {
        traceId: 'trace',
        protocol: 'openai-chat',
        operation: 'stream',
        routeId: 'quality-main',
        auxiliaryTask: undefined,
        ruleIds: ['retry-transient'],
        requestIds: [],
        innerCause: undefined,
        safeHeaders: { 'retry-after': '2' },
      },
    })).toBe(
      'op=stream protocol=openai-chat route=quality-main rules=retry-transient headers=retry-after:2',
    )
  })

  it('shows a footer when more API failure cards are hidden', async () => {
    for (let i = 0; i < 7; i++) {
      appendApiRecoveryTrace(eventWithTraceId(`trace-${String(i).padStart(2, '0')}`))
    }

    const output = await renderToString(<ApiProviderDoctorSection />)

    expect(output).toContain('... 2 more API failure cards hidden')
  })

  it('renders long timelines with the newest attempts and hidden count', async () => {
    const base = event()
    for (let attempt = 1; attempt <= 4; attempt++) {
      appendApiRecoveryTrace({
        ...base,
        timestamp: `2026-05-29T00:00:0${attempt}.000Z`,
        attempt,
        maxAttempts: 4,
        reason: attempt === 1 ? 'timeout' : 'server_error',
        statusCode: attempt === 1 ? 408 : 502,
        action: attempt === 4 ? 'fallback_model' : 'retry_backoff',
        intent:
          attempt === 4
            ? 'switch_to_fallback_model'
            : 'retry_transient_failure',
        outcome: attempt === 4 ? 'fallback_triggered' : 'retrying',
        fromModel: attempt === 4 ? 'model-a' : undefined,
        toModel: attempt === 4 ? 'model-b' : undefined,
        final: attempt === 4,
      })
    }

    const output = await renderToString(<ApiProviderDoctorSection />)

    expect(output).toContain('timeline: ... 1 earlier')
    expect(output).not.toContain('#1/4')
    expect(output).toContain('#2/4 server_error')
    expect(output).toContain('#4/4 server_error HTTP 502 ->')
    expect(output).toContain('fallback_model/fallback_triggered')
  })

  it('renders a readable narrow-width section', async () => {
    appendApiRecoveryTrace(event())

    const output = await renderToString(<ApiProviderDoctorSection />, 48)

    expect(output).toContain('API Providers')
    expect(output).toContain('API authentication failed')
    expect(output).toContain('next: Check models["model-a"].apiKey')
  })
})
