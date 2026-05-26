import { describe, it, expect, vi } from 'vitest'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../../../services/api/providers/anthropicProvider.js'
import { LLMAPIError, LLMAbortError } from '../../../../services/api/streamTypes.js'
import { getHeader } from '../../../../services/api/headerUtils.js'

// Mock transitive deps to avoid deep import chains
vi.mock('../../../../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))
vi.mock('../../../../services/api/withRetry.js', () => ({
  withRetry: vi.fn(),
  CannotRetryError: class extends Error {},
}))
vi.mock('../../../../utils/diagLogs.js', () => ({
  logForDiagnosticsNoPII: vi.fn(),
}))
vi.mock('../../../../utils/betas.js', () => ({
  getModelBetas: vi.fn().mockReturnValue([]),
}))
vi.mock('../../../../utils/model/model.js', () => ({
  getFastModel: vi.fn().mockReturnValue('provider-fast-model'),
  normalizeModelStringForAPI: vi.fn((m: string) => m),
}))
vi.mock('../../../../services/api/llm.js', () => ({
  getExtraBodyParams: vi.fn().mockReturnValue({}),
  adjustParamsForNonStreaming: vi.fn((p: any) => p),
  MAX_NON_STREAMING_TOKENS: 64000,
}))
vi.mock('../../../../utils/log.js', () => ({
  logError: vi.fn(),
}))

// Minimal config for provider construction
const provider = new AnthropicProvider({
  getClient: vi.fn().mockResolvedValue({}),
})

describe('AnthropicProvider.wrapError', () => {
  describe('SDK APIError wrapping', () => {
    it('wraps APIError preserving status', () => {
      const error = new APIError(429, undefined, 'rate limited', undefined)
      const wrapped = provider.wrapError(error)

      expect(wrapped).toBeInstanceOf(LLMAPIError)
      expect(wrapped.status).toBe(429)
      expect(wrapped.message).toContain('rate limited')
    })

    it('wraps APIError preserving cause', () => {
      const error = new APIError(500, undefined, 'server error', undefined)
      const wrapped = provider.wrapError(error)

      expect(wrapped.cause).toBe(error)
    })

    it('wraps APIError preserving headers accessible via getHeader', () => {
      // Simulate SDK Proxy headers (no .get() method)
      const proxyHeaders = new Proxy(
        { 'x-request-id': 'req_test', 'retry-after': '5' },
        { get: (t, n) => t[String(n).toLowerCase()] },
      )
      const error = Object.assign(
        new APIError(429, undefined, 'rate limited', undefined),
        { headers: proxyHeaders },
      )

      const wrapped = provider.wrapError(error)

      // Headers must be accessible via getHeader (the safe accessor)
      expect(getHeader(wrapped.headers, 'x-request-id')).toBe('req_test')
      expect(getHeader(wrapped.headers, 'retry-after')).toBe('5')
    })

    it('wraps APIError preserving request_id', () => {
      const error = Object.assign(
        new APIError(500, undefined, 'error', undefined),
        { request_id: 'req_abc123' },
      )
      const wrapped = provider.wrapError(error)
      expect(wrapped.request_id).toBe('req_abc123')
    })

    it('wraps APIError preserving nested error body', () => {
      const error = Object.assign(
        new APIError(400, undefined, 'bad request', undefined),
        { error: { type: 'invalid_request_error', message: 'bad param' } },
      )
      const wrapped = provider.wrapError(error)
      expect(wrapped.error).toEqual({ type: 'invalid_request_error', message: 'bad param' })
    })
  })

  describe('abort error wrapping', () => {
    it('wraps APIUserAbortError as LLMAbortError', () => {
      const error = new APIUserAbortError()
      const wrapped = provider.wrapError(error)

      expect(wrapped).toBeInstanceOf(LLMAbortError)
      expect(wrapped).toBeInstanceOf(LLMAPIError)
      expect(wrapped.message).toBe('Request aborted')
    })
  })

  describe('connection error wrapping', () => {
    it('wraps APIConnectionError preserving cause', () => {
      const cause = { code: 'ECONNRESET' }
      const error = new APIConnectionError({ cause: cause as any })
      const wrapped = provider.wrapError(error)

      expect(wrapped).toBeInstanceOf(LLMAPIError)
      expect(wrapped.cause).toBe(error)
    })
  })

  describe('idempotency', () => {
    it('returns LLMAPIError as-is (no double wrapping)', () => {
      const original = new LLMAPIError('already wrapped', { status: 503 })
      const wrapped = provider.wrapError(original)

      expect(wrapped).toBe(original) // same reference
    })

    it('returns LLMAbortError as-is', () => {
      const original = new LLMAbortError()
      const wrapped = provider.wrapError(original)

      expect(wrapped).toBe(original)
    })
  })

  describe('generic error wrapping', () => {
    it('wraps plain Error preserving message', () => {
      const error = new Error('network failure')
      const wrapped = provider.wrapError(error)

      expect(wrapped).toBeInstanceOf(LLMAPIError)
      expect(wrapped.message).toBe('network failure')
      expect(wrapped.cause).toBe(error)
    })

    it('wraps non-Error value as string message', () => {
      const wrapped = provider.wrapError('unexpected string error')

      expect(wrapped).toBeInstanceOf(LLMAPIError)
      expect(wrapped.message).toBe('unexpected string error')
    })

    it('wraps null', () => {
      const wrapped = provider.wrapError(null)
      expect(wrapped).toBeInstanceOf(LLMAPIError)
      expect(wrapped.message).toBe('null')
    })
  })

  describe('instanceof chain', () => {
    it('LLMAbortError instanceof LLMAPIError', () => {
      expect(new LLMAbortError()).toBeInstanceOf(LLMAPIError)
    })

    it('LLMAPIError instanceof Error', () => {
      expect(new LLMAPIError('test')).toBeInstanceOf(Error)
    })

    it('LLMAbortError instanceof Error', () => {
      expect(new LLMAbortError()).toBeInstanceOf(Error)
    })
  })
})
