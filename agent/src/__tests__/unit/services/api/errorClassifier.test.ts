/**
 * Tests for the structured error classifier.
 *
 * Covers three dimensions:
 * 1. Classification correctness — each error type maps to the right reason
 * 2. Recovery hints correctness — flags match expected recovery actions
 * 3. Disambiguation — 402 billing vs transient, 400 context_overflow vs format_error
 */
import { describe, expect, it } from 'vitest'

import {
  classifyError,
  type ClassifiedError,
  type ErrorClassificationContext,
} from '../../../../services/api/errorClassifier.js'
import { LLMAbortError, LLMAPIError } from '../../../../services/api/streamTypes.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAPIError(status: number, message: string): LLMAPIError {
  return new LLMAPIError(message, { status })
}

const defaultContext: ErrorClassificationContext = {
  provider: 'anthropic',
  model: 'provider-main-model',
}

const largeSessionContext: ErrorClassificationContext = {
  provider: 'openai',
  model: 'gpt-4o',
  approxTokens: 100_000,
  contextLength: 128_000,
  numMessages: 120,
}

// ---------------------------------------------------------------------------
// 1. Classification correctness — HTTP status → reason
// ---------------------------------------------------------------------------

describe('classifyError: HTTP status → reason', () => {
  it('401 → auth', () => {
    const result = classifyError(makeAPIError(401, 'Unauthorized'), defaultContext)
    expect(result.reason).toBe('auth')
    expect(result.statusCode).toBe(401)
  })

  it('403 → auth (transient)', () => {
    const result = classifyError(makeAPIError(403, 'Forbidden'), defaultContext)
    expect(result.reason).toBe('auth')
    expect(result.statusCode).toBe(403)
  })

  it('401 + "account has been disabled" → auth_permanent', () => {
    const result = classifyError(
      makeAPIError(401, 'Your account has been disabled'),
      defaultContext,
    )
    expect(result.reason).toBe('auth_permanent')
    expect(result.retryable).toBe(false)
  })

  it('404 → model_not_found', () => {
    const result = classifyError(makeAPIError(404, 'Not Found'), defaultContext)
    expect(result.reason).toBe('model_not_found')
  })

  it('408 → timeout', () => {
    const result = classifyError(makeAPIError(408, 'Request Timeout'), defaultContext)
    expect(result.reason).toBe('timeout')
  })

  it('409 → timeout', () => {
    const result = classifyError(makeAPIError(409, 'Lock Timeout'), defaultContext)
    expect(result.reason).toBe('timeout')
  })

  it('413 → payload_too_large', () => {
    const result = classifyError(makeAPIError(413, 'Request Entity Too Large'), defaultContext)
    expect(result.reason).toBe('payload_too_large')
  })

  it('429 → rate_limit', () => {
    const result = classifyError(makeAPIError(429, 'Too Many Requests'), defaultContext)
    expect(result.reason).toBe('rate_limit')
  })

  it('500 → server_error', () => {
    const result = classifyError(makeAPIError(500, 'Internal Server Error'), defaultContext)
    expect(result.reason).toBe('server_error')
  })

  it('502 → server_error', () => {
    const result = classifyError(makeAPIError(502, 'Bad Gateway'), defaultContext)
    expect(result.reason).toBe('server_error')
  })

  it('503 → overloaded', () => {
    const result = classifyError(makeAPIError(503, 'Service Unavailable'), defaultContext)
    expect(result.reason).toBe('overloaded')
  })

  it('529 → overloaded', () => {
    const result = classifyError(makeAPIError(529, 'Overloaded'), defaultContext)
    expect(result.reason).toBe('overloaded')
  })

  it('overloaded_error in message (streaming SDK bug) → overloaded', () => {
    const error = new Error('{"type":"overloaded_error","message":"Overloaded"}')
    const result = classifyError(error, defaultContext)
    expect(result.reason).toBe('overloaded')
    expect(result.retryable).toBe(true)
  })

  it('400 + thinking signature → thinking_signature', () => {
    const result = classifyError(
      makeAPIError(400, 'Invalid signature for thinking block'),
      defaultContext,
    )
    expect(result.reason).toBe('thinking_signature')
    expect(result.retryable).toBe(true)
    expect(result.shouldCompress).toBe(false)
  })

  it('429 + extra usage + long context → long_context_tier', () => {
    const result = classifyError(
      makeAPIError(429, 'Rate limited: extra usage tier required for long context requests'),
      defaultContext,
    )
    expect(result.reason).toBe('long_context_tier')
    expect(result.retryable).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Recovery hints correctness
// ---------------------------------------------------------------------------

describe('classifyError: recovery hints', () => {
  it('auth → not retryable, shouldFallback', () => {
    const result = classifyError(makeAPIError(401, 'Unauthorized'), defaultContext)
    expect(result.retryable).toBe(false)
    expect(result.shouldFallback).toBe(true)
    expect(result.shouldCompress).toBe(false)
  })

  it('rate_limit → retryable, shouldFallback', () => {
    const result = classifyError(makeAPIError(429, 'Too Many Requests'), defaultContext)
    expect(result.retryable).toBe(true)
    expect(result.shouldFallback).toBe(true)
    expect(result.shouldCompress).toBe(false)
  })

  it('overloaded → retryable, no fallback, no compress', () => {
    const result = classifyError(makeAPIError(529, 'Overloaded'), defaultContext)
    expect(result.retryable).toBe(true)
    expect(result.shouldFallback).toBe(false)
    expect(result.shouldCompress).toBe(false)
  })

  it('context_overflow → retryable, shouldCompress, no fallback', () => {
    const result = classifyError(
      makeAPIError(400, 'Prompt is too long'),
      defaultContext,
    )
    expect(result.reason).toBe('context_overflow')
    expect(result.retryable).toBe(true)
    expect(result.shouldCompress).toBe(true)
    expect(result.shouldFallback).toBe(false)
  })

  it('payload_too_large → retryable, shouldCompress', () => {
    const result = classifyError(makeAPIError(413, 'Request Entity Too Large'), defaultContext)
    expect(result.retryable).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('model_not_found → not retryable, shouldFallback', () => {
    const result = classifyError(makeAPIError(404, 'Not Found'), defaultContext)
    expect(result.retryable).toBe(false)
    expect(result.shouldFallback).toBe(true)
  })

  it('server_error → retryable, no fallback', () => {
    const result = classifyError(makeAPIError(500, 'Internal Server Error'), defaultContext)
    expect(result.retryable).toBe(true)
    expect(result.shouldFallback).toBe(false)
  })

  it('billing → not retryable, shouldFallback', () => {
    const result = classifyError(
      makeAPIError(402, 'Your credits have been exhausted'),
      defaultContext,
    )
    expect(result.reason).toBe('billing')
    expect(result.retryable).toBe(false)
    expect(result.shouldFallback).toBe(true)
  })

  it('user abort → not retryable, no fallback, no compress', () => {
    const result = classifyError(new LLMAbortError(), defaultContext)
    expect(result.reason).toBe('abort')
    expect(result.retryable).toBe(false)
    expect(result.shouldFallback).toBe(false)
    expect(result.shouldCompress).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Disambiguation
// ---------------------------------------------------------------------------

describe('classifyError: 402 billing vs transient rate_limit', () => {
  it('402 + "insufficient credits" → billing (permanent)', () => {
    const result = classifyError(
      makeAPIError(402, 'Insufficient credits. Please top up your account.'),
      defaultContext,
    )
    expect(result.reason).toBe('billing')
    expect(result.retryable).toBe(false)
  })

  it('402 + "exceeded your current quota" → billing', () => {
    const result = classifyError(
      makeAPIError(402, 'You exceeded your current quota'),
      defaultContext,
    )
    expect(result.reason).toBe('billing')
  })

  it('402 + "try again" → rate_limit (transient)', () => {
    const result = classifyError(
      makeAPIError(402, 'Usage limit reached. Please try again in 5 minutes.'),
      defaultContext,
    )
    expect(result.reason).toBe('rate_limit')
    expect(result.retryable).toBe(true)
  })

  it('402 + "resets at" → rate_limit (transient)', () => {
    const result = classifyError(
      makeAPIError(402, 'Rate quota exceeded. Window resets at 2026-04-14T10:00:00Z.'),
      defaultContext,
    )
    expect(result.reason).toBe('rate_limit')
    expect(result.retryable).toBe(true)
  })

  it('402 + generic message without signals → billing', () => {
    const result = classifyError(
      makeAPIError(402, 'Payment Required'),
      defaultContext,
    )
    expect(result.reason).toBe('billing')
    expect(result.retryable).toBe(false)
  })
})

describe('classifyError: 400 context_overflow vs format_error', () => {
  it('400 + "prompt is too long" → context_overflow', () => {
    const result = classifyError(
      makeAPIError(400, 'Prompt is too long: 200000 tokens > 128000 limit'),
      defaultContext,
    )
    expect(result.reason).toBe('context_overflow')
    expect(result.shouldCompress).toBe(true)
  })

  it('400 + Anthropic max_tokens overflow → context_overflow', () => {
    const result = classifyError(
      makeAPIError(400, 'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000'),
      defaultContext,
    )
    expect(result.reason).toBe('context_overflow')
    expect(result.shouldCompress).toBe(true)
  })

  it('400 + "max_tokens is too large" → max_tokens_too_large (not context_overflow)', () => {
    const result = classifyError(
      makeAPIError(400, 'max_tokens is too large: model output cap is 64000'),
      defaultContext,
    )
    expect(result.reason).toBe('max_tokens_too_large')
    expect(result.retryable).toBe(true)
    expect(result.shouldCompress).toBe(false)
  })

  it('400 + "max_completion_tokens must be less than" → max_tokens_too_large', () => {
    const result = classifyError(
      makeAPIError(400, 'max_completion_tokens must be less than 16384'),
      defaultContext,
    )
    expect(result.reason).toBe('max_tokens_too_large')
  })

  it('400 + "invalid value for max_tokens" → max_tokens_too_large', () => {
    const result = classifyError(
      makeAPIError(400, 'Invalid value for max_tokens: expected <= 32000'),
      defaultContext,
    )
    expect(result.reason).toBe('max_tokens_too_large')
  })

  it('400 + "invalid model" → model_not_found', () => {
    const result = classifyError(
      makeAPIError(400, 'gpt-5-turbo is not a valid model'),
      defaultContext,
    )
    expect(result.reason).toBe('model_not_found')
    expect(result.shouldFallback).toBe(true)
  })

  it('400 + generic message + large session → context_overflow (heuristic)', () => {
    const result = classifyError(
      makeAPIError(400, 'Bad Request'),
      largeSessionContext,
    )
    expect(result.reason).toBe('context_overflow')
    expect(result.shouldCompress).toBe(true)
  })

  it('400 + generic message + small session → format_error', () => {
    const result = classifyError(
      makeAPIError(400, 'Bad Request'),
      { provider: 'openai', model: 'gpt-4o', approxTokens: 5000, contextLength: 128000 },
    )
    expect(result.reason).toBe('format_error')
    expect(result.retryable).toBe(false)
  })

  it('400 + Chinese context overflow message → context_overflow', () => {
    const result = classifyError(
      makeAPIError(400, '输入超过最大长度限制'),
      defaultContext,
    )
    expect(result.reason).toBe('context_overflow')
    expect(result.shouldCompress).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Transport errors
// ---------------------------------------------------------------------------

describe('classifyError: transport errors', () => {
  it('connection error with cause chain → connection (retryable)', () => {
    const cause = new Error('ENOTFOUND')
    ;(cause as any).code = 'ENOTFOUND'
    const error = new LLMAPIError('Connection failed', { cause })
    const result = classifyError(error, defaultContext)
    expect(result.reason).toBe('connection')
    expect(result.retryable).toBe(true)
  })

  it('generic Error with no status → unknown (retryable)', () => {
    const result = classifyError(new Error('something went wrong'), defaultContext)
    expect(result.reason).toBe('unknown')
    expect(result.retryable).toBe(true)
  })

  it('server disconnected + large session → context_overflow', () => {
    const result = classifyError(
      new Error('server disconnected without sending a response'),
      largeSessionContext,
    )
    expect(result.reason).toBe('context_overflow')
    expect(result.shouldCompress).toBe(true)
  })

  it('server disconnected + small session → unknown', () => {
    const result = classifyError(
      new Error('server disconnected without sending a response'),
      { provider: 'anthropic', model: 'provider-main-model', approxTokens: 1000 },
    )
    // small session, not context overflow
    expect(result.reason).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// Message pattern matching (no HTTP status)
// ---------------------------------------------------------------------------

describe('classifyError: message-only classification', () => {
  it('rate limit pattern in plain Error → rate_limit', () => {
    const result = classifyError(
      new Error('Rate limit exceeded: too many requests per minute'),
      defaultContext,
    )
    expect(result.reason).toBe('rate_limit')
    expect(result.retryable).toBe(true)
  })

  it('billing pattern in plain Error → billing', () => {
    const result = classifyError(
      new Error('Your credits have been exhausted. Please recharge.'),
      defaultContext,
    )
    expect(result.reason).toBe('billing')
    expect(result.retryable).toBe(false)
  })

  it('model not found pattern in plain Error → model_not_found', () => {
    const result = classifyError(
      new Error('Model "llama-99b" does not exist'),
      defaultContext,
    )
    expect(result.reason).toBe('model_not_found')
    expect(result.shouldFallback).toBe(true)
  })

  it('auth pattern in plain Error → auth', () => {
    const result = classifyError(
      new Error('Invalid API key provided'),
      defaultContext,
    )
    expect(result.reason).toBe('auth')
    expect(result.retryable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('classifyError: edge cases', () => {
  it('null error → unknown', () => {
    const result = classifyError(null, defaultContext)
    expect(result.reason).toBe('unknown')
    expect(result.retryable).toBe(true)
  })

  it('string error → unknown', () => {
    const result = classifyError('something broke', defaultContext)
    expect(result.reason).toBe('unknown')
    expect(result.retryable).toBe(true)
  })

  it('message is truncated to 500 chars', () => {
    const longMessage = 'A'.repeat(1000)
    const result = classifyError(new Error(longMessage), defaultContext)
    expect(result.message.length).toBeLessThanOrEqual(500)
  })

  it('5xx unknown status → server_error', () => {
    const result = classifyError(makeAPIError(599, 'Unknown 5xx'), defaultContext)
    expect(result.reason).toBe('server_error')
    expect(result.retryable).toBe(true)
  })

  it('4xx unknown status → format_error with shouldFallback', () => {
    const result = classifyError(makeAPIError(418, "I'm a teapot"), defaultContext)
    expect(result.reason).toBe('format_error')
    expect(result.shouldFallback).toBe(true)
  })
})
