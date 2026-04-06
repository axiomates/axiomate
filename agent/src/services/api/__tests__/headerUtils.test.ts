import { describe, it, expect } from 'vitest'
import { getHeader } from '../headerUtils.js'

describe('getHeader', () => {
  describe('standard Headers object (has .get())', () => {
    it('returns header value via .get()', () => {
      const headers = new Headers({ 'x-request-id': 'req_123' })
      expect(getHeader(headers, 'x-request-id')).toBe('req_123')
    })

    it('handles case-insensitive lookup via .get()', () => {
      const headers = new Headers({ 'X-Request-Id': 'req_456' })
      expect(getHeader(headers, 'x-request-id')).toBe('req_456')
    })

    it('returns null for missing header', () => {
      const headers = new Headers({})
      expect(getHeader(headers, 'x-missing')).toBeNull()
    })
  })

  describe('Anthropic SDK Proxy (bracket access only, no .get())', () => {
    // Simulates the SDK's createResponseHeaders Proxy behavior:
    // supports bracket access headers['key'] but has NO .get() method
    function createSDKProxy(entries: Record<string, string>) {
      return new Proxy(entries, {
        get(target, name) {
          const key = String(name).toLowerCase()
          return target[key]
        },
      })
    }

    it('reads header via bracket access when .get() is absent', () => {
      const headers = createSDKProxy({ 'x-should-retry': 'true' })
      expect(typeof headers.get).toBe('undefined') // no .get() method
      expect(getHeader(headers, 'x-should-retry')).toBe('true')
    })

    it('handles case-insensitive access via Proxy get trap', () => {
      const headers = createSDKProxy({ 'anthropic-ratelimit-unified-reset': '1700000000' })
      expect(getHeader(headers, 'anthropic-ratelimit-unified-reset')).toBe('1700000000')
    })

    it('returns null for missing header in Proxy', () => {
      const headers = createSDKProxy({})
      expect(getHeader(headers, 'x-missing')).toBeNull()
    })
  })

  describe('plain Record<string, string>', () => {
    it('reads header via bracket access', () => {
      const headers = { 'x-request-id': 'req_789' }
      expect(getHeader(headers, 'x-request-id')).toBe('req_789')
    })

    it('falls back to lowercase key', () => {
      const headers = { 'x-request-id': 'req_abc' }
      expect(getHeader(headers, 'X-Request-Id')).toBe('req_abc')
    })

    it('returns null for missing key', () => {
      const headers = { 'other-header': 'value' }
      expect(getHeader(headers, 'x-missing')).toBeNull()
    })
  })

  describe('null / undefined / non-object', () => {
    it('returns null for null', () => {
      expect(getHeader(null, 'x-test')).toBeNull()
    })

    it('returns null for undefined', () => {
      expect(getHeader(undefined, 'x-test')).toBeNull()
    })

    it('returns null for string', () => {
      expect(getHeader('not-an-object', 'x-test')).toBeNull()
    })

    it('returns null for number', () => {
      expect(getHeader(42, 'x-test')).toBeNull()
    })
  })

  describe('v0.1.0 behavioral parity: withRetry header access patterns', () => {
    // These reproduce the exact header access patterns from withRetry.ts
    // that caused the runtime crash

    it('reads x-should-retry from SDK-style Proxy (withRetry.ts:732)', () => {
      const proxyHeaders = new Proxy(
        { 'x-should-retry': 'true' },
        { get: (t, n) => t[String(n).toLowerCase()] },
      )
      expect(getHeader(proxyHeaders, 'x-should-retry')).toBe('true')
    })

    it('reads overage-disabled-reason from SDK-style Proxy (withRetry.ts:275)', () => {
      const proxyHeaders = new Proxy(
        { 'anthropic-ratelimit-unified-overage-disabled-reason': 'spending_cap' },
        { get: (t, n) => t[String(n).toLowerCase()] },
      )
      expect(getHeader(proxyHeaders, 'anthropic-ratelimit-unified-overage-disabled-reason')).toBe('spending_cap')
    })

    it('reads reset header from SDK-style Proxy (withRetry.ts:815)', () => {
      const proxyHeaders = new Proxy(
        { 'anthropic-ratelimit-unified-reset': '1700000000' },
        { get: (t, n) => t[String(n).toLowerCase()] },
      )
      expect(getHeader(proxyHeaders, 'anthropic-ratelimit-unified-reset')).toBe('1700000000')
    })
  })
})
