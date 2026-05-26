import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeUtilizationPct,
  getRateLimitInfo,
  parseRateLimitHeaders,
  subscribeToRateLimitUpdates,
  updateRateLimitInfo,
  type RateLimitInfo,
} from '../../../../services/api/rateLimitTracker.js'

function reset(): void {
  // Wipe singleton between tests via a sentinel update; there's no public
  // reset, so push an empty-ish snapshot then null out via Object.assign tricks.
  // Simpler: just write a fresh value each test relies on.
  updateRateLimitInfo({
    provider: 'reset',
    capturedAt: 0,
  })
}

describe('parseRateLimitHeaders', () => {
  it('returns null for empty headers', () => {
    expect(parseRateLimitHeaders({}, 'p')).toBeNull()
    expect(parseRateLimitHeaders(null, 'p')).toBeNull()
  })

  it('parses OpenAI-style headers + plain seconds reset', () => {
    const h = new Headers({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '17',
      'x-ratelimit-reset-requests': '60',
      'x-ratelimit-limit-tokens': '200000',
      'x-ratelimit-remaining-tokens': '40000',
    })
    const info = parseRateLimitHeaders(h, 'openai')
    expect(info).toMatchObject({
      requestsLimit: 100,
      requestsRemaining: 17,
      tokensLimit: 200000,
      tokensRemaining: 40000,
      provider: 'openai',
    })
    // 60s reset → 60_000 ms
    expect(info!.requestsResetMs).toBe(60_000)
  })

  it('parses Anthropic-style headers + ISO timestamp reset', () => {
    const futureIso = new Date(Date.now() + 30_000).toISOString()
    const h = new Headers({
      'anthropic-ratelimit-tokens-limit': '1000000',
      'anthropic-ratelimit-tokens-remaining': '50000',
      'anthropic-ratelimit-tokens-reset': futureIso,
    })
    const info = parseRateLimitHeaders(h, 'anthropic')
    expect(info?.tokensLimit).toBe(1_000_000)
    expect(info?.tokensRemaining).toBe(50_000)
    expect(info?.tokensResetMs).toBeGreaterThan(20_000)
    expect(info?.tokensResetMs).toBeLessThanOrEqual(30_000)
  })

  it('parses retry-after seconds standalone', () => {
    const h = new Headers({ 'retry-after': '12' })
    const info = parseRateLimitHeaders(h, 'p')
    expect(info?.retryAfterMs).toBe(12_000)
  })

  it('parses duration string reset (6m0s)', () => {
    const h = new Headers({
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-remaining-requests': '5',
      'x-ratelimit-reset-requests': '6m0s',
    })
    const info = parseRateLimitHeaders(h, 'p')
    expect(info?.requestsResetMs).toBe(6 * 60 * 1000)
  })

  it('caches latest snapshot via update + get', () => {
    const info: RateLimitInfo = {
      provider: 'p',
      requestsLimit: 100,
      requestsRemaining: 1,
      capturedAt: Date.now(),
    }
    updateRateLimitInfo(info)
    expect(getRateLimitInfo()?.provider).toBe('p')
  })
})

describe('computeUtilizationPct', () => {
  it('returns undefined when neither dimension has data', () => {
    expect(
      computeUtilizationPct({ provider: 'p', capturedAt: 0 }),
    ).toBeUndefined()
  })

  it('returns the more saturated dimension', () => {
    expect(
      computeUtilizationPct({
        provider: 'p',
        capturedAt: 0,
        requestsLimit: 100,
        requestsRemaining: 90, // 10% used
        tokensLimit: 1000,
        tokensRemaining: 200, // 80% used
      }),
    ).toBe(80)
  })

  it('handles requests-only', () => {
    expect(
      computeUtilizationPct({
        provider: 'p',
        capturedAt: 0,
        requestsLimit: 100,
        requestsRemaining: 13, // 87%
      }),
    ).toBe(87)
  })

  it('handles divisor=0 gracefully', () => {
    expect(
      computeUtilizationPct({
        provider: 'p',
        capturedAt: 0,
        requestsLimit: 0,
        requestsRemaining: 0,
      }),
    ).toBeUndefined()
  })
})

describe('subscribeToRateLimitUpdates', () => {
  afterEach(() => reset())

  it('fires listeners synchronously after each update', () => {
    const fn = vi.fn()
    const unsub = subscribeToRateLimitUpdates(fn)
    updateRateLimitInfo({ provider: 'a', capturedAt: 1 })
    updateRateLimitInfo({ provider: 'b', capturedAt: 2 })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn.mock.calls[0]![0].provider).toBe('a')
    expect(fn.mock.calls[1]![0].provider).toBe('b')
    unsub()
  })

  it('unsubscribe stops further notifications', () => {
    const fn = vi.fn()
    const unsub = subscribeToRateLimitUpdates(fn)
    updateRateLimitInfo({ provider: 'a', capturedAt: 1 })
    unsub()
    updateRateLimitInfo({ provider: 'b', capturedAt: 2 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a throwing listener does not break other listeners or producer', () => {
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    const unsubBad = subscribeToRateLimitUpdates(bad)
    const unsubGood = subscribeToRateLimitUpdates(good)
    expect(() =>
      updateRateLimitInfo({ provider: 'p', capturedAt: 0 }),
    ).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    unsubBad()
    unsubGood()
  })
})
