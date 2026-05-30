import { afterEach, describe, expect, it } from 'vitest'

import {
  appendApiRecoveryTrace,
  clearApiRecoveryTraces,
  listApiRecoveryTraces,
  MAX_API_RECOVERY_DIAGNOSTICS,
  toSafeApiRecoveryTraceEvent,
} from '../../../../services/api/apiRecoveryDiagnostics.js'
import type { RecoveryTraceEvent } from '../../../../services/api/recoveryTrace.js'

function event(overrides: Partial<RecoveryTraceEvent> = {}): RecoveryTraceEvent {
  return {
    timestamp: '2026-05-29T00:00:00.000Z',
    traceId: 'trace-1',
    protocol: 'openai-chat',
    model: 'model-a',
    attempt: 1,
    maxAttempts: 2,
    reason: 'rate_limit',
    intent: 'retry_transient_failure',
    action: 'retry_backoff',
    outcome: 'retrying',
    retryable: true,
    shouldCompress: false,
    shouldFallback: true,
    ...overrides,
  }
}

describe('apiRecoveryDiagnostics', () => {
  afterEach(() => {
    clearApiRecoveryTraces()
  })

  it('stores newest-first copies in a bounded ring buffer', () => {
    for (let i = 0; i < MAX_API_RECOVERY_DIAGNOSTICS + 5; i++) {
      appendApiRecoveryTrace(event({
        traceId: `trace-${i}`,
        timestamp: `2026-05-29T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      }))
    }

    const traces = listApiRecoveryTraces()

    expect(traces).toHaveLength(MAX_API_RECOVERY_DIAGNOSTICS)
    expect(traces[0]?.traceId).toBe(`trace-${MAX_API_RECOVERY_DIAGNOSTICS + 4}`)
    expect(traces.at(-1)?.traceId).toBe('trace-5')
  })

  it('keeps only safe headers and redacts raw error cause fields', () => {
    const safe = toSafeApiRecoveryTraceEvent(event({
      innerCause: 'Error containing bearer sk-secret and raw prompt text',
      safeHeaders: {
        authorization: 'Bearer sk-secret',
        'x-request-id': 'req-123',
        cookie: 'session=secret',
        'retry-after': '2',
      },
    }))

    expect(safe.innerCause).toBe('Error: [redacted]')
    expect(safe.safeHeaders).toEqual({
      'x-request-id': 'req-123',
      'retry-after': '2',
    })
  })

  it('preserves non-sensitive inner causes for Doctor diagnosis', () => {
    const safe = toSafeApiRecoveryTraceEvent(event({
      innerCause: 'LLMAPIError: Stream ended without receiving any events',
    }))

    expect(safe.innerCause).toBe(
      'LLMAPIError: Stream ended without receiving any events',
    )
  })

  it('returns defensive copies', () => {
    appendApiRecoveryTrace(event({
      traceId: 'trace-copy',
      mutation: ['omit_request_field:temperature'],
      safeHeaders: { 'x-request-id': 'req-copy' },
      policyGate: {
        allowActions: ['retry_same_model', 'switch_model'],
        switchModelOn: ['rate_limit'],
        actionAllowed: true,
        reasonAllowed: true,
      },
    }))
    const traces = listApiRecoveryTraces()
    traces.length = 0

    expect(listApiRecoveryTraces()).toHaveLength(1)

    const [first] = listApiRecoveryTraces()
    first!.mutation!.push('mutated')
    first!.safeHeaders!['x-request-id'] = 'mutated'
    first!.policyGate!.allowActions!.push('mutated')
    first!.policyGate!.switchModelOn!.push('mutated')
    first!.policyGate!.actionAllowed = false

    expect(listApiRecoveryTraces()[0]).toMatchObject({
      mutation: ['omit_request_field:temperature'],
      safeHeaders: { 'x-request-id': 'req-copy' },
      policyGate: {
        allowActions: ['retry_same_model', 'switch_model'],
        switchModelOn: ['rate_limit'],
        actionAllowed: true,
        reasonAllowed: true,
      },
    })
  })

  it('preserves trace event sequence for deterministic doctor ordering', () => {
    const safe = toSafeApiRecoveryTraceEvent(event({
      sequence: 42,
    }))

    expect(safe.sequence).toBe(42)
  })
})
