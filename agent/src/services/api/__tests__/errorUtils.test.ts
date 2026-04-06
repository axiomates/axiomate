import { describe, it, expect } from 'vitest'
import {
  extractConnectionErrorDetails,
  formatAPIError,
  sanitizeAPIError,
} from '../errorUtils.js'
import { LLMAPIError } from '../streamTypes.js'

describe('extractConnectionErrorDetails', () => {
  it('extracts ECONNRESET from cause chain', () => {
    const cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const error = new Error('Connection error.', { cause })
    const details = extractConnectionErrorDetails(error)
    expect(details).toMatchObject({ code: 'ECONNRESET', isSSLError: false })
  })

  it('detects SSL error codes', () => {
    const cause = Object.assign(new Error('ssl'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
    const error = new Error('SSL error', { cause })
    const details = extractConnectionErrorDetails(error)
    expect(details).toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', isSSLError: true })
  })

  it('walks nested cause chain', () => {
    const root = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    const mid = new Error('mid', { cause: root })
    const top = new Error('top', { cause: mid })
    const details = extractConnectionErrorDetails(top)
    expect(details).toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('returns null for non-object', () => {
    expect(extractConnectionErrorDetails(null)).toBeNull()
    expect(extractConnectionErrorDetails('string')).toBeNull()
  })

  it('returns null when no code in chain', () => {
    const error = new Error('no code')
    expect(extractConnectionErrorDetails(error)).toBeNull()
  })
})

describe('sanitizeAPIError', () => {
  it('returns plain text message as-is', () => {
    const error = new LLMAPIError('rate limited')
    expect(sanitizeAPIError(error)).toBe('rate limited')
  })

  it('strips HTML content', () => {
    const error = new LLMAPIError('<html><body><h1>503 Service Unavailable</h1></body></html>')
    const result = sanitizeAPIError(error)
    // Should either strip HTML or return a sanitized version
    expect(result).not.toContain('<html>')
  })

  it('returns empty string for missing message', () => {
    const error = new LLMAPIError('')
    ;(error as any).message = undefined
    expect(sanitizeAPIError(error)).toBe('')
  })
})

describe('formatAPIError', () => {
  it('formats connection error', () => {
    const error = new LLMAPIError('Connection error.')
    const result = formatAPIError(error)
    expect(result).toContain('Unable to connect to API')
  })

  it('formats ETIMEDOUT', () => {
    const cause = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    const error = new LLMAPIError('Connection error.', { cause })
    const result = formatAPIError(error)
    expect(result).toContain('timed out')
  })

  it('formats SSL verification error', () => {
    const cause = Object.assign(new Error('ssl'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
    const error = new LLMAPIError('Connection error.', { cause })
    const result = formatAPIError(error)
    expect(result).toContain('SSL')
  })

  it('returns message directly for normal API error', () => {
    const error = new LLMAPIError('The model returned an invalid response')
    expect(formatAPIError(error)).toBe('The model returned an invalid response')
  })

  it('provides fallback when message is missing', () => {
    const error = new LLMAPIError('')
    ;(error as any).message = undefined
    ;(error as any).status = 503
    const result = formatAPIError(error)
    expect(result).toContain('503')
  })

  it('accepts LLMAPIError (not just SDK APIError)', () => {
    // This is the key behavioral change: formatAPIError now accepts LLMAPIError
    const error = new LLMAPIError('test error', { status: 429 })
    const result = formatAPIError(error)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
