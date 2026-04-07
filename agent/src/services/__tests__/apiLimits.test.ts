import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMAPIError } from '../api/streamTypes.js'

// ── Mocks for transitive dependencies ────────────────────────────────

vi.mock('../../bootstrap/state.js', () => ({
  getIsNonInteractiveSession: vi.fn().mockReturnValue(false),
}))

vi.mock('../../utils/auth.js', () => ({
  isClaudeAISubscriber: vi.fn().mockReturnValue(true),
}))

vi.mock('../../utils/betas.js', () => ({
  getModelBetas: vi.fn().mockReturnValue([]),
}))

vi.mock('../../utils/model/model.js', () => ({
  getSmallFastModel: vi.fn().mockReturnValue('claude-haiku-4-5-20251001'),
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: vi.fn().mockReturnValue({}),
  saveGlobalConfig: vi.fn(),
}))

vi.mock('../../utils/privacyLevel.js', () => ({
  isEssentialTrafficOnly: vi.fn().mockReturnValue(false),
}))

vi.mock('../api/claude.js', () => ({
  getAPIMetadata: vi.fn().mockReturnValue({}),
  getExtraBodyParams: vi.fn().mockReturnValue({}),
}))

vi.mock('../api/client.js', () => ({
  getAnthropicClient: vi.fn(),
}))

vi.mock('../analytics/index.js', () => ({
  logEvent: vi.fn(),
}))

vi.mock('../rateLimitMocking.js', () => ({
  processRateLimitHeaders: vi.fn((h: unknown) => h),
  shouldProcessRateLimits: vi.fn().mockReturnValue(true),
}))

vi.mock('../../utils/log.js', () => ({
  logError: vi.fn(),
}))

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Create a Proxy that behaves like SDK response headers:
 * bracket access is case-insensitive (lowercased lookup).
 */
function createProxyHeaders(entries: Record<string, string>) {
  return new Proxy(entries, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined
      return target[prop.toLowerCase()] ?? undefined
    },
  })
}

// ── Tests ────────────────────────────────────────────────────────────

import {
  extractQuotaStatusFromHeaders,
  extractQuotaStatusFromError,
  getRawUtilization,
  currentLimits,
} from '../apiLimits.js'

describe('extractQuotaStatusFromHeaders', () => {
  beforeEach(() => {
    // Reset limits to default state before each test.
    // The module exports `currentLimits` as a mutable binding,
    // and emitStatusChange replaces it — we can reset via a
    // call with no rate-limit headers (status defaults to 'allowed').
    extractQuotaStatusFromHeaders({})
  })

  it('does not crash with SDK-style Proxy headers containing rate limit info', () => {
    const headers = createProxyHeaders({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-reset': String(
        Math.floor(Date.now() / 1000) + 3600,
      ),
      'anthropic-ratelimit-unified-5h-utilization': '0.4',
      'anthropic-ratelimit-unified-5h-reset': String(
        Math.floor(Date.now() / 1000) + 3600,
      ),
    })

    expect(() => extractQuotaStatusFromHeaders(headers)).not.toThrow()
  })

  it('reads utilization from plain object headers', () => {
    const resetAt = Math.floor(Date.now() / 1000) + 7200
    const headers = {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.55',
      'anthropic-ratelimit-unified-5h-reset': String(resetAt),
      'anthropic-ratelimit-unified-7d-utilization': '0.3',
      'anthropic-ratelimit-unified-7d-reset': String(resetAt),
    }

    extractQuotaStatusFromHeaders(headers)

    const raw = getRawUtilization()
    // five_hour utilization should have been extracted
    expect(raw.five_hour).toBeDefined()
    expect(raw.five_hour!.utilization).toBeCloseTo(0.55)
  })

  it('updates currentLimits status from headers', () => {
    const headers = {
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-reset': String(
        Math.floor(Date.now() / 1000) + 1800,
      ),
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      // Provide a surpassed-threshold header so the warning path fires
      'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.8',
      'anthropic-ratelimit-unified-5h-utilization': '0.85',
      'anthropic-ratelimit-unified-5h-reset': String(
        Math.floor(Date.now() / 1000) + 1800,
      ),
    }

    extractQuotaStatusFromHeaders(headers)

    // After processing warning headers, status should be allowed_warning
    expect(currentLimits.status).toBe('allowed_warning')
  })
})

describe('extractQuotaStatusFromError', () => {
  beforeEach(() => {
    // Reset to default
    extractQuotaStatusFromHeaders({})
  })

  it('extracts quota from LLMAPIError with 429 status and headers', () => {
    const resetAt = Math.floor(Date.now() / 1000) + 3600
    const error = new LLMAPIError('Rate limited', {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(resetAt),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      },
    })

    extractQuotaStatusFromError(error)

    // Status should be set to 'rejected' (forced by extractQuotaStatusFromError)
    expect(currentLimits.status).toBe('rejected')
  })

  it('does not crash when error has no headers, sets rejected', () => {
    const error = new LLMAPIError('Rate limited', { status: 429 })

    expect(() => extractQuotaStatusFromError(error)).not.toThrow()
    // Even without headers, status is forced to 'rejected' for 429 errors
    expect(currentLimits.status).toBe('rejected')
  })

  it('early returns without processing when error.status !== 429', () => {
    // First set a known state
    const headers = {
      'anthropic-ratelimit-unified-status': 'allowed',
    }
    extractQuotaStatusFromHeaders(headers)
    const limitsBefore = { ...currentLimits }

    // Now pass a non-429 error
    const error = new LLMAPIError('Server error', { status: 500 })
    extractQuotaStatusFromError(error)

    // Limits should remain unchanged
    expect(currentLimits.status).toBe(limitsBefore.status)
  })
})
