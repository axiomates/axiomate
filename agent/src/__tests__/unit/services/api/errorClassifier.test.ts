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
import { LLMAbortError, LLMAPIError, LLMTimeoutError } from '../../../../services/api/streamTypes.js'

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

  it('403 + key/spending limit → billing', () => {
    const keyLimit = classifyError(
      makeAPIError(403, 'Key limit exceeded for this key'),
      defaultContext,
    )
    const spendingLimit = classifyError(
      makeAPIError(403, 'Spending limit reached'),
      defaultContext,
    )

    expect(keyLimit.reason).toBe('billing')
    expect(keyLimit.retryable).toBe(false)
    expect(spendingLimit.reason).toBe('billing')
  })

  it('401 + "account has been disabled" → auth_permanent', () => {
    const result = classifyError(
      makeAPIError(401, 'Your account has been disabled'),
      defaultContext,
    )
    expect(result.reason).toBe('auth_permanent')
    expect(result.retryable).toBe(false)
  })

  it('generic 404 → unknown retryable', () => {
    const result = classifyError(makeAPIError(404, 'Not Found'), defaultContext)
    expect(result.reason).toBe('unknown')
    expect(result.retryable).toBe(true)
  })

  it('404 with model-not-found signal → model_not_found', () => {
    const result = classifyError(
      makeAPIError(404, 'The model provider-main-model does not exist'),
      defaultContext,
    )
    expect(result.reason).toBe('model_not_found')
    expect(result.shouldFallback).toBe(true)
  })

  it('408 → timeout', () => {
    const result = classifyError(makeAPIError(408, 'Request Timeout'), defaultContext)
    expect(result.reason).toBe('timeout')
  })

  it('409 → timeout', () => {
    const result = classifyError(makeAPIError(409, 'Lock Timeout'), defaultContext)
    expect(result.reason).toBe('timeout')
  })

  it('LLMTimeoutError → timeout', () => {
    const result = classifyError(new LLMTimeoutError('Stream idle timeout'), defaultContext)
    expect(result.reason).toBe('timeout')
    expect(result.retryable).toBe(true)
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

  it('400 + long context beta unavailable → oauth_long_context_beta_forbidden', () => {
    const result = classifyError(
      makeAPIError(
        400,
        'The long context beta is not yet available for this subscription.',
      ),
      defaultContext,
    )
    expect(result.reason).toBe('oauth_long_context_beta_forbidden')
    expect(result.retryable).toBe(true)
  })

  it('400 + llama.cpp grammar failure → llama_cpp_grammar_pattern', () => {
    const result = classifyError(
      makeAPIError(400, 'error parsing grammar: json-schema-to-grammar failed'),
      defaultContext,
    )
    expect(result.reason).toBe('llama_cpp_grammar_pattern')
    expect(result.retryable).toBe(true)
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
    const result = classifyError(
      makeAPIError(404, 'The model provider-main-model does not exist'),
      defaultContext,
    )
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

  it('402 + retry wording without usage/quota signal stays billing', () => {
    const result = classifyError(
      makeAPIError(402, 'Payment required. Please retry after updating billing.'),
      defaultContext,
    )
    expect(result.reason).toBe('billing')
    expect(result.retryable).toBe(false)
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

  it('400 + unsupported request field → unsupported_parameter with omit metadata', () => {
    const error = new LLMAPIError(
      'Unsupported parameter: temperature is not supported by this model',
      {
        status: 400,
        error: {
          error: {
            code: 'unsupported_parameter',
            param: 'temperature',
            message: 'Unsupported parameter: temperature',
          },
        },
      },
    )
    const result = classifyError(error, defaultContext)
    expect(result.reason).toBe('unsupported_parameter')
    expect(result.retryable).toBe(true)
    expect(result.requestFieldsToOmit).toEqual(['temperature'])
  })

  it('400 + unsupported service_tier → unsupported_parameter with omit metadata', () => {
    const error = new LLMAPIError(
      'Argument not supported: service_tier',
      {
        status: 400,
        error: {
          error: {
            code: 'unsupported_parameter',
            param: 'service_tier',
            message: 'Argument not supported: service_tier',
          },
        },
      },
    )
    const result = classifyError(error, {
      provider: 'openai-responses',
      model: 'grok-4.3',
    })
    expect(result.reason).toBe('unsupported_parameter')
    expect(result.requestFieldsToOmit).toEqual(['service_tier'])
  })

  it('502 + request validation body → unsupported_parameter instead of server retry flood', () => {
    const error = new LLMAPIError(
      'Bad Gateway: unknown parameter stream_options',
      {
        status: 502,
        error: {
          error: {
            code: 'unknown_parameter',
            param: 'stream_options',
          },
        },
      },
    )
    const result = classifyError(error, defaultContext)
    expect(result.reason).toBe('unsupported_parameter')
    expect(result.requestFieldsToOmit).toEqual(['stream_options'])
  })

  it('400 + invalid encrypted Responses replay → invalid_encrypted_content', () => {
    const result = classifyError(
      new LLMAPIError(
        'Encrypted content for item rs_123 could not be verified',
        {
          status: 400,
          error: { error: { code: 'invalid_encrypted_content' } },
        },
      ),
      { provider: 'openai-responses', model: 'gpt-5' },
    )
    expect(result.reason).toBe('invalid_encrypted_content')
    expect(result.retryable).toBe(true)
  })

  it('OpenAI Responses terminal output=null parser error → responses_null_output', () => {
    const result = classifyError(
      new TypeError("'NoneType' object is not iterable"),
      { provider: 'openai-responses', model: 'gpt-5' },
    )
    expect(result.reason).toBe('responses_null_output')
    expect(result.retryable).toBe(true)
  })

  it('OpenAI Responses empty content validation → malformed_response', () => {
    const result = classifyError(
      new LLMAPIError('Responses API returned empty content: {"output":[]}', {
        status: 502,
      }),
      { provider: 'openai-responses', model: 'gpt-5' },
    )
    expect(result.reason).toBe('malformed_response')
    expect(result.retryable).toBe(true)
  })

  it('Grok Responses invalid arguments → slash_enum_unsupported', () => {
    const result = classifyError(
      new LLMAPIError('Invalid arguments passed to the model', {
        status: 400,
      }),
      { provider: 'openai-responses', model: 'grok-4.3' },
    )
    expect(result.reason).toBe('slash_enum_unsupported')
    expect(result.retryable).toBe(true)
  })

  it('non-Grok Responses invalid arguments stays format_error', () => {
    const result = classifyError(
      new LLMAPIError('Invalid arguments passed to the model', {
        status: 400,
      }),
      { provider: 'openai-responses', model: 'gpt-5' },
    )
    expect(result.reason).toBe('format_error')
  })

  it('400 + multimodal tool content rejection → multimodal_tool_content_unsupported', () => {
    const result = classifyError(
      makeAPIError(400, 'tool message content must be a string'),
      defaultContext,
    )
    expect(result.reason).toBe('multimodal_tool_content_unsupported')
    expect(result.retryable).toBe(true)
  })

  it('400 + invalid_request_error type does not mask multimodal tool-content recovery', () => {
    const result = classifyError(
      new LLMAPIError('Param Incorrect: text is not set', {
        status: 400,
        error: {
          error: {
            type: 'invalid_request_error',
            message: 'Param Incorrect: text is not set',
          },
        },
      }),
      defaultContext,
    )

    expect(result.reason).toBe('multimodal_tool_content_unsupported')
    expect(result.retryable).toBe(true)
  })

  it('400 + image size rejection → image_too_large', () => {
    const result = classifyError(
      makeAPIError(400, 'image exceeds 5 MB maximum'),
      defaultContext,
    )
    expect(result.reason).toBe('image_too_large')
    expect(result.retryable).toBe(true)
    expect(result.imageRecoveryProfile).toBe('aggressive_size_compression')
  })

  it.each([
    [
      'tool result image payload too large',
      'drop_or_textualize_tool_result_images',
    ],
    ['image dimensions exceed provider limit', 'fit_many_image_dimension_limit'],
    ['image_too_large', 'fit_provider_image_limit'],
  ] as const)(
    'image rejection profile: %s → %s',
    (message, expectedProfile) => {
      const result = classifyError(makeAPIError(400, message), defaultContext)

      expect(result.reason).toBe('image_too_large')
      expect(result.imageRecoveryProfile).toBe(expectedProfile)
    },
  )

  it('400 + OpenRouter data policy block → provider_policy_blocked', () => {
    const result = classifyError(
      makeAPIError(
        400,
        'No endpoints available matching your guardrail restrictions and data policy.',
      ),
      defaultContext,
    )
    expect(result.reason).toBe('provider_policy_blocked')
    expect(result.retryable).toBe(false)
    expect(result.shouldFallback).toBe(false)
  })

  it('404 + OpenRouter data policy block → provider_policy_blocked', () => {
    const result = classifyError(
      makeAPIError(
        404,
        'No endpoints available matching your guardrail restrictions and data policy.',
      ),
      defaultContext,
    )
    expect(result.reason).toBe('provider_policy_blocked')
    expect(result.retryable).toBe(false)
    expect(result.shouldFallback).toBe(false)
  })

  it('400 + provider safety/content policy block → content_policy_blocked', () => {
    const result = classifyError(
      makeAPIError(400, 'Your request was flagged by our safety system.'),
      defaultContext,
    )
    expect(result.reason).toBe('content_policy_blocked')
    expect(result.retryable).toBe(false)
    expect(result.shouldFallback).toBe(true)
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

  it('400 + specific unknown message + large session does not trigger compaction heuristic', () => {
    const result = classifyError(
      makeAPIError(400, 'The provider rejected the request shape'),
      largeSessionContext,
    )
    expect(result.reason).toBe('format_error')
    expect(result.shouldCompress).toBe(false)
  })

  it('400 + generic message + small session → format_error', () => {
    const result = classifyError(
      makeAPIError(400, 'Bad Request'),
      { provider: 'openai', model: 'gpt-4o', approxTokens: 5000, contextLength: 128000 },
    )
    expect(result.reason).toBe('format_error')
    expect(result.retryable).toBe(false)
  })

  it('400 + explicit stream unsupported → streaming_unsupported', () => {
    const result = classifyError(
      makeAPIError(400, 'This endpoint does not support streaming'),
      defaultContext,
    )
    expect(result.reason).toBe('streaming_unsupported')
    expect(result.retryable).toBe(false)
  })

  it('404 + explicit stream endpoint missing → stream_endpoint_not_found', () => {
    const result = classifyError(
      makeAPIError(404, 'The requested streaming endpoint does not exist'),
      defaultContext,
    )
    expect(result.reason).toBe('stream_endpoint_not_found')
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

  it('empty stream completion → malformed_response (retryable)', () => {
    const result = classifyError(
      new Error('Stream ended without receiving any events'),
      { provider: 'openai-chat', model: 'deepseek-v4-pro' },
    )
    expect(result.reason).toBe('malformed_response')
    expect(result.retryable).toBe(true)
  })

  it('server disconnected + very large session → context_overflow', () => {
    const result = classifyError(
      new Error('server disconnected without sending a response'),
      {
        provider: 'openai',
        model: 'gpt-4o',
        approxTokens: 180_000,
        contextLength: 256_000,
        numMessages: 240,
      },
    )
    expect(result.reason).toBe('context_overflow')
    expect(result.shouldCompress).toBe(true)
  })

  it('server disconnected + moderate large session stays timeout', () => {
    const result = classifyError(
      new Error('server disconnected without sending a response'),
      {
        provider: 'openai',
        model: 'gpt-4o',
        approxTokens: 100_000,
        contextLength: 256_000,
        numMessages: 120,
      },
    )
    expect(result.reason).toBe('timeout')
    expect(result.shouldCompress).toBe(false)
  })

  it('server disconnected + small session → unknown', () => {
    const result = classifyError(
      new Error('server disconnected without sending a response'),
      { provider: 'anthropic', model: 'provider-main-model', approxTokens: 1000 },
    )
    expect(result.reason).toBe('timeout')
  })

  it('message-only max_tokens output cap → max_tokens_too_large', () => {
    const result = classifyError(
      new Error('max_tokens is too large: model output cap is 64000'),
      defaultContext,
    )
    expect(result.reason).toBe('max_tokens_too_large')
    expect(result.shouldCompress).toBe(false)
  })

  it('SSL alert text → timeout instead of context compression', () => {
    const result = classifyError(
      new Error('SSL alert bad record mac'),
      largeSessionContext,
    )
    expect(result.reason).toBe('timeout')
    expect(result.shouldCompress).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Message pattern matching (no HTTP status)
// ---------------------------------------------------------------------------

describe('classifyError: message-only classification', () => {
  class RateLimitError extends Error {}

  it('rate limit pattern in plain Error → rate_limit', () => {
    const result = classifyError(
      new Error('Rate limit exceeded: too many requests per minute'),
      defaultContext,
    )
    expect(result.reason).toBe('rate_limit')
    expect(result.retryable).toBe(true)
  })

  it('RateLimitError without status → rate_limit', () => {
    const result = classifyError(
      new RateLimitError('Provider rejected request'),
      defaultContext,
    )
    expect(result.reason).toBe('rate_limit')
    expect(result.statusCode).toBe(429)
    expect(result.retryable).toBe(true)
  })

  it('message-only 413 shape → payload_too_large', () => {
    const result = classifyError(
      new Error('Request failed: payload too large'),
      defaultContext,
    )
    expect(result.reason).toBe('payload_too_large')
    expect(result.shouldCompress).toBe(true)
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

  it('metadata.raw wrapped provider code is extracted', () => {
    const result = classifyError(
      new LLMAPIError('Provider returned error', {
        error: {
          error: {
            message: 'Provider returned error',
            metadata: {
              raw: JSON.stringify({
                error: {
                  code: 'invalid_encrypted_content',
                  message: 'opaque upstream failure',
                },
              }),
            },
          },
        },
      }),
      { provider: 'openai-responses', model: 'gpt-5' },
    )
    expect(result.reason).toBe('invalid_encrypted_content')
    expect(result.retryable).toBe(true)
  })

  it('message-only content_filter token → content_policy_blocked', () => {
    const result = classifyError(
      new Error('Provider failed with finish_reason=content_filter'),
      { provider: 'openai-chat', model: 'gpt-5' },
    )
    expect(result.reason).toBe('content_policy_blocked')
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
