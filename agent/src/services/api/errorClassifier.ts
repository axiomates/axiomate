/**
 * Structured error classifier for API errors.
 *
 * This module is a pure classifier — it accepts an error and outputs a
 * structured ClassifiedError with recovery hints. It has NO side effects
 * (no retries, no client refresh, no credential rotation).
 *
 * The retry loop (withRetry.ts) consumes the ClassifiedError hints to
 * decide what to do. It never re-parses the error itself.
 */

import { extractConnectionErrorDetails } from './errorUtils.js'
import { getHeader } from './headerUtils.js'
import type { ImageRecoveryProfile } from './imageRecovery.js'
import { LLMAbortError, LLMAPIError, LLMTimeoutError } from './streamTypes.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ErrorFailoverReason =
  | 'abort'              // User cancelled
  | 'connection'         // Network / DNS / TLS error
  | 'timeout'            // Connection or read timeout
  | 'overloaded'         // 503/529 — provider capacity
  | 'rate_limit'         // 429 — throttling
  | 'billing'            // 402 / confirmed credit exhaustion (permanent)
  | 'auth'               // 401/403 — transient auth (refresh may fix)
  | 'auth_permanent'     // Auth failed after refresh — abort
  | 'context_overflow'   // Prompt too long / context window exceeded
  | 'max_tokens_too_large' // Caller-supplied max_tokens alone exceeds model output cap
  | 'payload_too_large'  // 413
  | 'image_too_large'    // Image part exceeds provider per-image limits
  | 'model_not_found'    // explicit 404/400 invalid model signals
  | 'provider_policy_blocked' // Aggregator/account policy excludes available endpoints
  | 'content_policy_blocked' // Provider safety/content filter rejected this prompt
  | 'streaming_unsupported' // Endpoint/model explicitly rejects stream mode
  | 'stream_endpoint_not_found' // Stream endpoint 404, non-streaming may still work
  | 'format_error'       // 400 bad request (not context overflow)
  | 'unsupported_parameter' // Provider rejects a recoverable top-level request field
  | 'invalid_encrypted_content' // OpenAI Responses encrypted reasoning replay rejected
  | 'responses_null_output' // OpenAI Responses SDK/parser hit response.output=null
  | 'malformed_response'  // Provider returned a 200/5xx response with no usable assistant output
  | 'multimodal_tool_content_unsupported' // Tool result list/image content rejected
  | 'server_error'       // 500/502
  | 'thinking_signature' // Anthropic thinking block signature invalid
  | 'long_context_tier'  // Anthropic "extra usage" tier gate (429 + long context)
  | 'oauth_long_context_beta_forbidden' // Anthropic OAuth subscription rejects long-context beta
  | 'llama_cpp_grammar_pattern' // llama.cpp grammar rejects JSON schema pattern/format
  | 'slash_enum_unsupported' // xAI/Grok Responses rejects slash-containing enum values
  | 'unknown'            // Unclassifiable

export interface ClassifiedError {
  /** Semantic reason for the failure */
  reason: ErrorFailoverReason
  /** HTTP status code, if available */
  statusCode: number | undefined
  /** Human-readable error message (truncated) */
  message: string
  /** Whether the retry loop should retry this error */
  retryable: boolean
  /** Whether context should be compressed before retrying */
  shouldCompress: boolean
  /** Whether the retry loop should switch to a fallback model */
  shouldFallback: boolean
  /** Server-suggested retry delay in milliseconds */
  retryAfterMs: number | undefined
  /** Top-level request fields that can be omitted before retrying. */
  requestFieldsToOmit?: string[]
  /** Image rewrite profile for retry-local payload recovery. */
  imageRecoveryProfile?: ImageRecoveryProfile
}

export interface ErrorClassificationContext {
  /** Provider identifier ('anthropic', 'openai', custom name) */
  provider: string
  /** Model identifier */
  model: string
  /** Approximate token count of the current session */
  approxTokens?: number
  /** Model's context window length */
  contextLength?: number
  /** Number of messages in the conversation */
  numMessages?: number
}

// ---------------------------------------------------------------------------
// Pattern constants (ported from hermes error_classifier.py, adapted for
// multi-provider use including Chinese error messages)
// ---------------------------------------------------------------------------

/** Permanent billing exhaustion — rotate credential or fail */
const BILLING_PATTERNS = [
  'insufficient credits',
  'insufficient_quota',
  'insufficient balance',
  'credit balance',
  'credits have been exhausted',
  'top up your credits',
  'payment required',
  'billing hard limit',
  'exceeded your current quota',
  'spending limit',
  'account is deactivated',
  'plan does not include',
]

/**
 * Transient signals that indicate a 402/usage-limit is temporary (resets soon).
 * If present alongside a billing-like message, classify as rate_limit, not billing.
 */
const RATE_LIMIT_TRANSIENT_SIGNALS = [
  'try again',
  'retry',
  'resets at',
  'reset in',
  'wait',
  'requests remaining',
  'periodic',
  'window',
]

/** Rate limiting patterns */
const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'throttled',
  'requests per minute',
  'tokens per minute',
  'requests per day',
  'try again in',
  'please retry after',
  'resource_exhausted',
  'rate increased too quickly',
  'throttlingexception',
  'too many concurrent requests',
  'servicequotaexceededexception',
]

const PAYLOAD_TOO_LARGE_PATTERNS = [
  'request entity too large',
  'payload too large',
  'error code: 413',
]

const USAGE_LIMIT_PATTERNS = [
  'usage limit',
  'quota',
  'limit exceeded',
  'key limit exceeded',
]

/**
 * max_tokens alone exceeds model output cap — retry without max_tokens
 * (OpenAI only; Anthropic requires the field). Must be checked BEFORE
 * CONTEXT_OVERFLOW_PATTERNS so we don't fire context compaction for a
 * problem that's just the caller's max_tokens being too ambitious.
 *
 * These patterns are intentionally NOT matched by Anthropic's combined
 * "input length and `max_tokens` exceed context limit: X + Y > Z" message,
 * which is an input-side problem and belongs in context_overflow.
 */
const MAX_TOKENS_TOO_LARGE_PATTERNS = [
  'max_tokens is too large',
  'max_tokens must be',
  'max_tokens cannot exceed',
  'max_tokens out of range',
  'max_completion_tokens is too',
  'max_completion_tokens must be',
  'max_completion_tokens cannot',
  'invalid value for max_tokens',
  'invalid value for max_completion_tokens',
]

/** Context window exceeded — compress, don't failover */
const CONTEXT_OVERFLOW_PATTERNS = [
  'context length',
  'context size',
  'maximum context',
  'token limit',
  'too many tokens',
  'reduce the length',
  'exceeds the limit',
  'context window',
  'prompt is too long',
  'prompt exceeds max length',
  'max_tokens',
  'maximum number of tokens',
  'exceeds the max_model_len',
  'max_model_len',
  'prompt length',
  'input is too long',
  'maximum model length',
  'context length exceeded',
  'truncating input',
  'slot context',
  'n_ctx_slot',
  'max input token',
  'input token',
  'exceeds the maximum number of input tokens',
  // Anthropic-specific
  'input length and `max_tokens` exceed context limit',
  // Chinese providers (e.g., Qwen, DeepSeek, Kimi)
  '超过最大长度',
  '上下文长度',
]

/** Model not available — fallback to different model */
const MODEL_NOT_FOUND_PATTERNS = [
  'is not a valid model',
  'invalid model',
  'model not found',
  'model_not_found',
  'does not exist',
  'no such model',
  'unknown model',
  'unsupported model',
]

const MODEL_NOT_FOUND_ERROR_CODES = [
  'model_not_found',
  'model_not_available',
  'invalid_model',
]

const REQUEST_VALIDATION_PATTERNS = [
  'unknown parameter',
  'unsupported parameter',
  'unrecognized request argument',
  'invalid_request_error',
  'unknown_parameter',
  'unsupported_parameter',
]

const REQUEST_FIELD_VALIDATION_PATTERNS = [
  'unknown parameter',
  'unsupported parameter',
  'unrecognized request argument',
  'unknown_parameter',
  'unsupported_parameter',
]

const OMITTABLE_REQUEST_FIELDS = new Set([
  'frequency_penalty',
  'include',
  'logprobs',
  'max_completion_tokens',
  'max_output_tokens',
  'max_tokens',
  'metadata',
  'parallel_tool_calls',
  'presence_penalty',
  'reasoning',
  'response_format',
  'seed',
  'service_tier',
  'stop',
  'store',
  'stream_options',
  'temperature',
  'thinking',
  'tool_choice',
  'top_logprobs',
  'top_p',
])

const PROVIDER_POLICY_BLOCKED_PATTERNS = [
  'no endpoints available matching your guardrail',
  'no endpoints available matching your data policy',
  'no endpoints found matching your data policy',
]

const CONTENT_POLICY_BLOCKED_PATTERNS = [
  'flagged for possible cybersecurity risk',
  'trusted access for cyber',
  'violates our usage policies',
  "violates openai's usage policies",
  'your request was flagged by',
  'prompt was flagged by our safety',
  'responses cannot be generated due to safety',
  'content_filter',
  'responsibleaipolicyviolation',
]

const STREAMING_UNSUPPORTED_PATTERNS = [
  /\bstreaming\s+(?:is\s+)?not\s+supported\b/,
  /\bstream\s+mode\s+(?:is\s+)?not\s+supported\b/,
  /\bdoes\s+not\s+support\s+streaming\b/,
  /\bdoes\s+not\s+support\s+stream(?:ing)?\s+(?:mode|responses?|requests?)\b/,
  /\bstream(?:ing)?\s+(?:mode\s+)?(?:is\s+)?unsupported\b/,
]

const IMAGE_TOO_LARGE_PATTERNS = [
  'image exceeds',
  'image too large',
  'image_too_large',
  'image size exceeds',
  'image dimensions exceed',
]

const MULTIMODAL_TOOL_CONTENT_PATTERNS = [
  'text is not set',
  'tool message content must be a string',
  'tool content must be a string',
  'tool message must be a string',
  'expected string, got list',
  'expected string, got array',
  'tool_call.content must be string',
]

/** Transient authentication failures (refresh/rotate may fix) */
const AUTH_PATTERNS = [
  'invalid api key',
  'invalid_api_key',
  'authentication',
  'unauthorized',
  'invalid token',
  'token expired',
  'token revoked',
  'access denied',
]

/**
 * Permanent auth failures — refresh won't help, must abort.
 * If any of these appear in the error message alongside a 401/403,
 * classify as auth_permanent instead of auth.
 */
const AUTH_PERMANENT_PATTERNS = [
  'account is deactivated',
  'account has been disabled',
  'api key has been revoked',
  'permanently banned',
  'access has been terminated',
]

/** Server disconnect patterns (connection dropped mid-stream) */
const SERVER_DISCONNECT_PATTERNS = [
  'server disconnected',
  'peer closed connection',
  'connection reset by peer',
  'connection was closed',
  'network connection lost',
  'unexpected eof',
  'incomplete chunked read',
]

const TIMEOUT_MESSAGE_PATTERNS = [
  'timed out',
  'turn timed out',
  'request timed out',
  'deadline exceeded',
  'operation timed out',
  'upstream timed out',
]

const SSL_TRANSIENT_PATTERNS = [
  'bad record mac',
  'ssl alert',
  'tls alert',
  'ssl handshake failure',
  'tlsv1 alert',
  'sslv3 alert',
  'bad_record_mac',
  'ssl_alert',
  'tls_alert',
  'tls_alert_internal_error',
  '[ssl:',
]

const MALFORMED_RESPONSE_PATTERNS = [
  'stream ended without receiving any events',
  'stream ended before producing assistant output',
  'missing response_start',
]

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function classifyError(
  error: unknown,
  context: ErrorClassificationContext,
): ClassifiedError {
  // 1. User abort
  if (error instanceof LLMAbortError) {
    return result('abort', {
      retryable: false,
      message: 'User aborted the request',
    })
  }
  if (error instanceof LLMTimeoutError) {
    return result('timeout', {
      retryable: true,
      message: error.message,
    })
  }

  // 2. Extract HTTP status code and message from the error chain
  const statusCode = extractStatusCode(error)
  const message = extractMessage(error)
  const lowerMessage = buildPatternMessage(error, message)
  const errorCode = extractErrorCode(error)

  if (hasAnyPattern(lowerMessage, CONTENT_POLICY_BLOCKED_PATTERNS)) {
    return result('content_policy_blocked', {
      statusCode,
      retryable: false,
      shouldFallback: true,
      message,
    })
  }

  if (statusCode === 400 && isStreamingUnsupportedMessage(lowerMessage)) {
    return result('streaming_unsupported', {
      statusCode,
      retryable: false,
      message,
    })
  }

  if (isMalformedResponseMessage(lowerMessage)) {
    return result('malformed_response', {
      statusCode,
      retryable: true,
      message,
    })
  }

  if (statusCode === undefined && isRateLimitLikeError(error)) {
    return result('rate_limit', {
      statusCode: 429,
      retryable: true,
      shouldFallback: true,
      message,
    })
  }

  // 3. Provider-specific patterns (highest priority — before generic HTTP dispatch)
  if (
    context.provider === 'openai-responses' &&
    isResponsesNullOutputMessage(lowerMessage)
  ) {
    return result('responses_null_output', {
      statusCode,
      retryable: true,
      message,
    })
  }
  if (
    context.provider === 'openai-responses' &&
    isResponsesMalformedOutputMessage(lowerMessage)
  ) {
    return result('malformed_response', {
      statusCode,
      retryable: true,
      message,
    })
  }
  if (statusCode === 400 && lowerMessage.includes('signature') && lowerMessage.includes('thinking')) {
    return result('thinking_signature', {
      statusCode,
      retryable: true,
      message,
    })
  }
  if (statusCode === 429 && lowerMessage.includes('extra usage') && lowerMessage.includes('long context')) {
    return result('long_context_tier', {
      statusCode,
      retryable: true,
      shouldCompress: true,
      message,
    })
  }
  if (statusCode === 400 && lowerMessage.includes('long context beta') && lowerMessage.includes('not yet available')) {
    return result('oauth_long_context_beta_forbidden', {
      statusCode,
      retryable: true,
      message,
    })
  }
  if (
    statusCode === 400 &&
    (lowerMessage.includes('error parsing grammar') ||
      lowerMessage.includes('json-schema-to-grammar') ||
      (lowerMessage.includes('unable to generate parser') &&
        lowerMessage.includes('template')))
  ) {
    return result('llama_cpp_grammar_pattern', {
      statusCode,
      retryable: true,
      message,
    })
  }
  if (
    statusCode === 400 &&
    context.provider === 'openai-responses' &&
    isGrokResponsesModelName(context.model) &&
    isSlashEnumUnsupportedMessage(lowerMessage)
  ) {
    return result('slash_enum_unsupported', {
      statusCode,
      retryable: true,
      message,
    })
  }
  if (
    lowerMessage.includes('do not have an active grok subscription') ||
    (lowerMessage.includes('out of available resources') &&
      lowerMessage.includes('grok'))
  ) {
    return result('auth', {
      statusCode,
      retryable: false,
      shouldFallback: true,
      message,
    })
  }
  if (isImagePayloadTooLarge(lowerMessage, errorCode)) {
    return result('image_too_large', {
      statusCode,
      retryable: true,
      imageRecoveryProfile: inferImageRecoveryProfile(lowerMessage),
      message,
    })
  }
  if (hasAnyPattern(lowerMessage, PAYLOAD_TOO_LARGE_PATTERNS)) {
    return result('payload_too_large', {
      statusCode,
      retryable: true,
      shouldCompress: true,
      message,
    })
  }

  // 4. HTTP status dispatch
  if (statusCode !== undefined) {
    const retryAfterMs = parseRetryAfterMs(error)

    switch (statusCode) {
      case 401:
      case 403:
        if (
          statusCode === 403 &&
          (lowerMessage.includes('key limit exceeded') ||
            lowerMessage.includes('spending limit'))
        ) {
          return result('billing', {
            statusCode,
            retryable: false,
            shouldFallback: true,
            message,
          })
        }
        // Distinguish transient auth (can refresh) from permanent
        if (hasAnyPattern(lowerMessage, AUTH_PERMANENT_PATTERNS)) {
          return result('auth_permanent', {
            statusCode,
            retryable: false,
            shouldFallback: true,
            message,
          })
        }
        return result('auth', {
          statusCode,
          retryable: false,
          shouldFallback: true,
          message,
        })

      case 402:
        return classify402(lowerMessage, statusCode, message, retryAfterMs)

      case 404:
        if (hasAnyPattern(lowerMessage, PROVIDER_POLICY_BLOCKED_PATTERNS)) {
          return result('provider_policy_blocked', {
            statusCode,
            retryable: false,
            message,
          })
        }
        if (isStreamEndpointNotFoundMessage(lowerMessage)) {
          return result('stream_endpoint_not_found', {
            statusCode,
            retryable: false,
            message,
          })
        }
        if (isModelNotFound404(lowerMessage, errorCode, context.model)) {
          return result('model_not_found', {
            statusCode,
            retryable: false,
            shouldFallback: true,
            message,
          })
        }
        return result('unknown', {
          statusCode,
          retryable: true,
          message,
        })

      case 408:
      case 409:
        return result('timeout', {
          statusCode,
          retryable: true,
          message,
        })

      case 413:
        if (isImagePayloadTooLarge(lowerMessage, errorCode)) {
          return result('image_too_large', {
            statusCode,
            retryable: true,
            imageRecoveryProfile: inferImageRecoveryProfile(lowerMessage),
            message,
          })
        }
        return result('payload_too_large', {
          statusCode,
          retryable: true,
          shouldCompress: true,
          message,
        })

      case 429:
        return result('rate_limit', {
          statusCode,
          retryable: true,
          shouldFallback: true,
          retryAfterMs,
          message,
        })

      case 400:
        return classify400(
          error,
          lowerMessage,
          errorCode,
          statusCode,
          message,
          context,
        )

      case 500:
      case 502:
        if (hasDeterministicRequestValidationSignal(lowerMessage, errorCode)) {
          const requestFieldsToOmit = extractOmittableRequestFields(
            error,
            lowerMessage,
          )
          if (requestFieldsToOmit.length > 0) {
            return result('unsupported_parameter', {
              statusCode,
              retryable: true,
              requestFieldsToOmit,
              message,
            })
          }
          return result('format_error', {
            statusCode,
            retryable: false,
            shouldFallback: true,
            message,
          })
        }
        return result('server_error', {
          statusCode,
          retryable: true,
          message,
        })

      case 503:
      case 529:
        return result('overloaded', {
          statusCode,
          retryable: true,
          message,
        })

      default:
        if (statusCode >= 500) {
          return result('server_error', {
            statusCode,
            retryable: true,
            message,
          })
        }
        if (statusCode >= 400) {
          return result('format_error', {
            statusCode,
            retryable: false,
            shouldFallback: true,
            message,
          })
        }
    }
  }

  // 4. SDK overloaded_error in message (streaming SDK bug — 529 not always
  //    propagated as status code)
  if (lowerMessage.includes('"type":"overloaded_error"')) {
    return result('overloaded', {
      statusCode: 529,
      retryable: true,
      message,
    })
  }

  // 5. Transport / connection errors (provider-neutral: walks cause chain)
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    if (
      connectionDetails.code === 'ETIMEDOUT' ||
      connectionDetails.code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return result('timeout', { retryable: true, message })
    }
    // ECONNRESET/EPIPE + large session → likely context overflow (hermes heuristic)
    if (
      (connectionDetails.code === 'ECONNRESET' || connectionDetails.code === 'EPIPE') &&
      isLargeDisconnectSession(context)
    ) {
      return result('context_overflow', {
        retryable: true,
        shouldCompress: true,
        message,
      })
    }
    return result('connection', { retryable: true, message })
  }

  // 6. Non-SDK errors — try message pattern matching
  if (hasAnyPattern(lowerMessage, SSL_TRANSIENT_PATTERNS)) {
    return result('timeout', { retryable: true, message })
  }

  if (hasAnyPattern(lowerMessage, SERVER_DISCONNECT_PATTERNS)) {
    if (isLargeDisconnectSession(context)) {
      return result('context_overflow', {
        retryable: true,
        shouldCompress: true,
        message,
      })
    }
    return result('timeout', { retryable: true, message })
  }

  if (hasAnyPattern(lowerMessage, TIMEOUT_MESSAGE_PATTERNS)) {
    return result('timeout', { retryable: true, message })
  }

  if (hasAnyPattern(lowerMessage, MULTIMODAL_TOOL_CONTENT_PATTERNS)) {
    return result('multimodal_tool_content_unsupported', {
      retryable: true,
      message,
    })
  }

  if (
    hasAnyPattern(lowerMessage, IMAGE_TOO_LARGE_PATTERNS) ||
    errorCode === 'image_too_large'
  ) {
    return result('image_too_large', {
      retryable: true,
      imageRecoveryProfile: inferImageRecoveryProfile(lowerMessage),
      message,
    })
  }

  if (
    errorCode === 'invalid_encrypted_content' ||
    lowerMessage.includes('invalid_encrypted_content') ||
    (lowerMessage.includes('encrypted content for item') &&
      lowerMessage.includes('could not be verified'))
  ) {
    return result('invalid_encrypted_content', {
      retryable: true,
      message,
    })
  }

  if (hasExplicitRequestFieldValidationSignal(lowerMessage, errorCode)) {
    const requestFieldsToOmit = extractOmittableRequestFields(
      error,
      lowerMessage,
    )
    if (requestFieldsToOmit.length > 0) {
      return result('unsupported_parameter', {
        retryable: true,
        requestFieldsToOmit,
        message,
      })
    }
    return result('format_error', {
      retryable: false,
      shouldFallback: true,
      message,
    })
  }

  if (hasAnyPattern(lowerMessage, MAX_TOKENS_TOO_LARGE_PATTERNS)) {
    return result('max_tokens_too_large', {
      retryable: true,
      shouldCompress: false,
      message,
    })
  }

  if (hasAnyPattern(lowerMessage, CONTEXT_OVERFLOW_PATTERNS)) {
    return result('context_overflow', {
      retryable: true,
      shouldCompress: true,
      message,
    })
  }

  if (
    hasAnyPattern(lowerMessage, RATE_LIMIT_PATTERNS) ||
    ['resource_exhausted', 'throttled', 'rate_limit_exceeded'].includes(
      errorCode,
    )
  ) {
    return result('rate_limit', { retryable: true, shouldFallback: true, message })
  }

  if (hasUsageLimitWithTransientSignal(lowerMessage)) {
    return result('rate_limit', { retryable: true, shouldFallback: true, message })
  }

  if (
    hasAnyPattern(lowerMessage, BILLING_PATTERNS) ||
    ['insufficient_quota', 'billing_not_active', 'payment_required'].includes(
      errorCode,
    ) ||
    hasAnyPattern(lowerMessage, USAGE_LIMIT_PATTERNS)
  ) {
    return result('billing', { retryable: false, shouldFallback: true, message })
  }

  if (hasAnyPattern(lowerMessage, PROVIDER_POLICY_BLOCKED_PATTERNS)) {
    return result('provider_policy_blocked', {
      retryable: false,
      message,
    })
  }

  if (
    hasAnyPattern(lowerMessage, MODEL_NOT_FOUND_PATTERNS) ||
    MODEL_NOT_FOUND_ERROR_CODES.includes(errorCode)
  ) {
    return result('model_not_found', { retryable: false, shouldFallback: true, message })
  }

  if (hasAnyPattern(lowerMessage, AUTH_PATTERNS)) {
    return result('auth', { retryable: false, shouldFallback: true, message })
  }

  // 7. Generic timeout / connection from non-SDK errors
  if (isTimeoutLikeError(error)) {
    return result('timeout', { retryable: true, message })
  }

  if (isConnectionLikeError(error)) {
    return result('connection', { retryable: true, message })
  }

  // 8. Fallback: unknown, retryable
  return result('unknown', { retryable: true, message })
}

// ---------------------------------------------------------------------------
// Disambiguation helpers
// ---------------------------------------------------------------------------

/**
 * 402 disambiguation: billing exhaustion (permanent) vs transient rate limit.
 *
 * Key insight from hermes: "usage limit, try again in 5 minutes" is NOT billing
 * — it's a periodic quota reset. Look for transient signals.
 */
function classify402(
  lowerMessage: string,
  statusCode: number,
  message: string,
  retryAfterMs: number | undefined,
): ClassifiedError {
  if (
    hasUsageLimitWithTransientSignal(lowerMessage) ||
    (retryAfterMs !== undefined && hasAnyPattern(lowerMessage, RATE_LIMIT_PATTERNS))
  ) {
    return result('rate_limit', {
      statusCode,
      retryable: true,
      shouldFallback: true,
      retryAfterMs,
      message,
    })
  }
  return result('billing', {
    statusCode,
    retryable: false,
    shouldFallback: true,
    message,
  })
}

/**
 * 400 disambiguation: context_overflow vs format_error vs model_not_found.
 *
 * Some providers return 400 instead of 413/404, so we check message patterns.
 * When the message is generic and the session is large, we apply the hermes
 * heuristic: generic 400 + large session → likely context overflow.
 */
function classify400(
  error: unknown,
  lowerMessage: string,
  errorCode: string,
  statusCode: number,
  message: string,
  context: ErrorClassificationContext,
): ClassifiedError {
  // Check max_tokens-too-large BEFORE context_overflow — "max_tokens" is a
  // keyword in both categories but the fix differs (retry-without-max_tokens
  // vs compact input), so precedence matters.
  if (hasAnyPattern(lowerMessage, MAX_TOKENS_TOO_LARGE_PATTERNS)) {
    return result('max_tokens_too_large', {
      statusCode,
      retryable: true,
      shouldCompress: false,
      message,
    })
  }
  if (hasAnyPattern(lowerMessage, MULTIMODAL_TOOL_CONTENT_PATTERNS)) {
    return result('multimodal_tool_content_unsupported', {
      statusCode,
      retryable: true,
      message,
    })
  }
  if (
    hasAnyPattern(lowerMessage, IMAGE_TOO_LARGE_PATTERNS) ||
    errorCode === 'image_too_large'
  ) {
    return result('image_too_large', {
      statusCode,
      retryable: true,
      imageRecoveryProfile: inferImageRecoveryProfile(lowerMessage),
      message,
    })
  }
  if (
    errorCode === 'invalid_encrypted_content' ||
    lowerMessage.includes('invalid_encrypted_content') ||
    (lowerMessage.includes('encrypted content for item') &&
      lowerMessage.includes('could not be verified'))
  ) {
    return result('invalid_encrypted_content', {
      statusCode,
      retryable: true,
      message,
    })
  }
  if (hasExplicitRequestFieldValidationSignal(lowerMessage, errorCode)) {
    const requestFieldsToOmit = extractOmittableRequestFields(
      error,
      lowerMessage,
    )
    if (requestFieldsToOmit.length > 0) {
      return result('unsupported_parameter', {
        statusCode,
        retryable: true,
        requestFieldsToOmit,
        message,
      })
    }
    return result('format_error', {
      statusCode,
      retryable: false,
      shouldFallback: true,
      message,
    })
  }
  if (hasAnyPattern(lowerMessage, CONTEXT_OVERFLOW_PATTERNS)) {
    return result('context_overflow', {
      statusCode,
      retryable: true,
      shouldCompress: true,
      message,
    })
  }
  if (hasAnyPattern(lowerMessage, MODEL_NOT_FOUND_PATTERNS)) {
    return result('model_not_found', {
      statusCode,
      retryable: false,
      shouldFallback: true,
      message,
    })
  }
  if (hasAnyPattern(lowerMessage, PROVIDER_POLICY_BLOCKED_PATTERNS)) {
    return result('provider_policy_blocked', {
      statusCode,
      retryable: false,
      message,
    })
  }
  if (hasAnyPattern(lowerMessage, RATE_LIMIT_PATTERNS)) {
    return result('rate_limit', {
      statusCode,
      retryable: true,
      shouldFallback: true,
      message,
    })
  }
  if (hasAnyPattern(lowerMessage, BILLING_PATTERNS)) {
    return result('billing', {
      statusCode,
      retryable: false,
      shouldFallback: true,
      message,
    })
  }
  // Hermes heuristic: generic 400 + large session → likely context overflow.
  // Only apply it to generic/bare messages; a specific unknown 400 should not
  // trigger expensive compaction just because the current session is large.
  if (isGenericBadRequestMessage(lowerMessage) && isLargeSession(context)) {
    return result('context_overflow', {
      statusCode,
      retryable: true,
      shouldCompress: true,
      message,
    })
  }
  return result('format_error', {
    statusCode,
    retryable: false,
    message,
  })
}

function inferImageRecoveryProfile(
  lowerMessage: string,
): ImageRecoveryProfile {
  if (
    lowerMessage.includes('tool_result') ||
    lowerMessage.includes('tool result')
  ) {
    return 'drop_or_textualize_tool_result_images'
  }
  if (
    lowerMessage.includes('many-image') ||
    lowerMessage.includes('many image') ||
    lowerMessage.includes('image dimensions exceed')
  ) {
    return 'fit_many_image_dimension_limit'
  }
  if (
    lowerMessage.includes('base64') ||
    lowerMessage.includes('bytes') ||
    lowerMessage.includes('mb') ||
    lowerMessage.includes('maximum')
  ) {
    return 'aggressive_size_compression'
  }
  return 'fit_provider_image_limit'
}

function isImagePayloadTooLarge(
  lowerMessage: string,
  errorCode: string,
): boolean {
  return (
    errorCode === 'image_too_large' ||
    hasAnyPattern(lowerMessage, IMAGE_TOO_LARGE_PATTERNS) ||
    (lowerMessage.includes('image') &&
      hasAnyPattern(lowerMessage, PAYLOAD_TOO_LARGE_PATTERNS))
  )
}

// ---------------------------------------------------------------------------
// Error introspection helpers
// ---------------------------------------------------------------------------

function extractStatusCode(error: unknown): number | undefined {
  if (error instanceof LLMAPIError) {
    return error.status
  }
  // Walk cause chain for wrapped errors (max depth 5)
  let current: unknown = error
  for (let i = 0; i < 5 && current != null; i++) {
    if (typeof current === 'object') {
      const obj = current as Record<string, unknown>
      if (typeof obj.status === 'number') return obj.status
      if (typeof obj.statusCode === 'number') return obj.statusCode
      current = obj.cause ?? obj.error
    } else {
      break
    }
  }
  return undefined
}

function extractMessage(error: unknown): string {
  if (error instanceof LLMAPIError) {
    return (error.message ?? String(error)).slice(0, 500)
  }
  if (error instanceof Error) {
    return (error.message ?? String(error)).slice(0, 500)
  }
  return String(error).slice(0, 500)
}

function buildPatternMessage(error: unknown, message: string): string {
  const parts = [message.toLowerCase()]
  for (const candidate of collectErrorPayloadStrings(error)) {
    const lower = candidate.toLowerCase()
    if (lower && !parts.includes(lower)) {
      parts.push(lower)
    }
  }
  return parts.join(' ')
}

function collectErrorPayloadStrings(error: unknown): string[] {
  const values: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current !== 'object') {
      break
    }

    const obj = current as Record<string, unknown>
    collectStringsFromPayload(obj.error, values)
    collectStringsFromPayload(obj.body, values)
    collectStringsFromPayload(obj.response, values)
    collectStringsFromPayload(obj.metadata, values)
    current = obj.cause
  }
  return values
}

function collectStringsFromPayload(
  value: unknown,
  values: string[],
): void {
  if (!value || typeof value !== 'object') {
    return
  }

  const obj = value as Record<string, unknown>
  for (const key of ['message', 'code', 'type', 'param', 'error_code']) {
    const candidate = obj[key]
    if (typeof candidate === 'string') {
      values.push(candidate)
      if (key === 'message' && candidate.trim().startsWith('{')) {
        collectStringsFromJson(candidate, values)
      }
    }
  }

  collectStringsFromPayload(obj.error, values)
  collectStringsFromPayload(obj.metadata, values)

  const raw = obj.raw
  if (typeof raw === 'string') {
    collectStringsFromJson(raw, values)
  }
}

function collectStringsFromJson(raw: string, values: string[]): void {
  try {
    collectStringsFromPayload(JSON.parse(raw), values)
  } catch {
    // Ignore malformed provider metadata.
  }
}

function extractErrorCode(error: unknown): string {
  const codes: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current !== 'object') {
      break
    }
    const obj = current as Record<string, unknown>
    collectErrorCodesFromPayload(obj.error, codes)
    collectErrorCodesFromPayload(obj.body, codes)
    collectErrorCodesFromPayload(obj.response, codes)
    collectErrorCodesFromPayload(obj.metadata, codes)
    current = obj.cause
  }
  return codes[0]?.toLowerCase() ?? ''
}

function collectErrorCodesFromPayload(
  value: unknown,
  codes: string[],
): void {
  if (!value || typeof value !== 'object') {
    return
  }

  const obj = value as Record<string, unknown>
  for (const key of ['code', 'type', 'error_code']) {
    const candidate = obj[key]
    if (
      (typeof candidate === 'string' || typeof candidate === 'number') &&
      String(candidate).trim() !== '400'
    ) {
      codes.push(String(candidate).trim())
    }
  }
  const message = obj.message
  if (typeof message === 'string' && message.trim().startsWith('{')) {
    try {
      collectErrorCodesFromPayload(JSON.parse(message), codes)
    } catch {
      // Ignore malformed provider metadata.
    }
  }
  collectErrorCodesFromPayload(obj.error, codes)
  collectErrorCodesFromPayload(obj.metadata, codes)
  const raw = obj.raw
  if (typeof raw === 'string') {
    try {
      collectErrorCodesFromPayload(JSON.parse(raw), codes)
    } catch {
      // Ignore malformed provider metadata.
    }
  }
}

function parseRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof LLMAPIError)) return undefined
  const header = getHeader(error.headers, 'retry-after')
  if (!header) return undefined
  const seconds = parseInt(header, 10)
  if (isNaN(seconds)) return undefined
  return seconds * 1000
}

// ---------------------------------------------------------------------------
// Session heuristics
// ---------------------------------------------------------------------------

function isLargeSession(context: ErrorClassificationContext): boolean {
  if (context.approxTokens && context.contextLength) {
    if (context.approxTokens > context.contextLength * 0.4) return true
  }
  if (context.approxTokens && context.approxTokens > 80_000) return true
  if (context.numMessages && context.numMessages > 80) return true
  return false
}

function isLargeDisconnectSession(context: ErrorClassificationContext): boolean {
  const contextLength = context.contextLength
  const approxTokens = context.approxTokens ?? 0
  const numMessages = context.numMessages ?? 0

  if (contextLength !== undefined && approxTokens > contextLength * 0.6) {
    return true
  }

  if (
    contextLength !== undefined &&
    contextLength <= 256_000 &&
    (approxTokens > 120_000 || numMessages > 200)
  ) {
    return true
  }

  return contextLength === undefined && approxTokens > 120_000
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function hasAnyPattern(lowerMessage: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => lowerMessage.includes(pattern))
}

function hasUsageLimitWithTransientSignal(lowerMessage: string): boolean {
  return (
    hasAnyPattern(lowerMessage, USAGE_LIMIT_PATTERNS) &&
    hasAnyPattern(lowerMessage, RATE_LIMIT_TRANSIENT_SIGNALS)
  )
}

function isStreamingUnsupportedMessage(lowerMessage: string): boolean {
  if (
    lowerMessage.includes('stream_options') ||
    lowerMessage.includes('stream option')
  ) {
    return false
  }
  return STREAMING_UNSUPPORTED_PATTERNS.some(pattern =>
    pattern.test(lowerMessage),
  )
}

function isStreamEndpointNotFoundMessage(lowerMessage: string): boolean {
  return (
    (lowerMessage.includes('streaming endpoint') ||
      lowerMessage.includes('stream endpoint')) &&
    (lowerMessage.includes('not found') ||
      lowerMessage.includes('does not exist') ||
      lowerMessage.includes('not exist') ||
      lowerMessage.includes('404'))
  )
}

function isGenericBadRequestMessage(lowerMessage: string): boolean {
  const normalized = lowerMessage.trim()
  return (
    normalized.length === 0 ||
    normalized === 'error' ||
    normalized === 'bad request' ||
    normalized === 'invalid request' ||
    normalized === 'invalid_request_error' ||
    /^bad request[:.\s-]*$/i.test(normalized) ||
    /^invalid request[:.\s-]*$/i.test(normalized)
  )
}

function hasExplicitRequestFieldValidationSignal(
  lowerMessage: string,
  errorCode: string,
): boolean {
  return (
    hasAnyPattern(lowerMessage, REQUEST_FIELD_VALIDATION_PATTERNS) ||
    hasAnyPattern(errorCode, REQUEST_FIELD_VALIDATION_PATTERNS)
  )
}

function hasDeterministicRequestValidationSignal(
  lowerMessage: string,
  errorCode: string,
): boolean {
  return (
    hasExplicitRequestFieldValidationSignal(lowerMessage, errorCode) ||
    errorCode === 'invalid_request_error'
  )
}

function isModelNotFound404(
  lowerMessage: string,
  errorCode: string,
  model: string,
): boolean {
  if (MODEL_NOT_FOUND_ERROR_CODES.includes(errorCode)) {
    return true
  }

  const modelName = model.trim().toLowerCase()
  return (
    lowerMessage.includes('model_not_found') ||
    lowerMessage.includes('model not found') ||
    lowerMessage.includes('no such model') ||
    lowerMessage.includes('invalid model') ||
    lowerMessage.includes('unknown model') ||
    lowerMessage.includes('unsupported model') ||
    lowerMessage.includes('is not a valid model') ||
    (lowerMessage.includes('model') &&
      (lowerMessage.includes('does not exist') ||
        lowerMessage.includes('not found'))) ||
    (modelName.length > 0 &&
      lowerMessage.includes(modelName) &&
      (lowerMessage.includes('does not exist') ||
        lowerMessage.includes('not found')))
  )
}

function isGrokResponsesModelName(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    normalized.startsWith('grok-') ||
    normalized.startsWith('x-ai/grok-')
  )
}

function isSlashEnumUnsupportedMessage(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('invalid arguments passed to the model') ||
    (lowerMessage.includes('invalid argument') &&
      (lowerMessage.includes('schema') ||
        lowerMessage.includes('tool') ||
        lowerMessage.includes('enum')))
  )
}

function isResponsesNullOutputMessage(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('responses api returned null output') ||
    lowerMessage.includes('response.output=null') ||
    lowerMessage.includes('response output is null') ||
    (lowerMessage.includes('nonetype') &&
      lowerMessage.includes('not iterable')) ||
    (lowerMessage.includes('none') &&
      lowerMessage.includes('not iterable') &&
      lowerMessage.includes('response'))
  )
}

function isResponsesMalformedOutputMessage(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('responses api returned empty content') ||
    lowerMessage.includes('responses api returned malformed output') ||
    lowerMessage.includes('responses api returned no output items') ||
    (lowerMessage.includes('responses stream:') &&
      lowerMessage.includes('without prior')) ||
    lowerMessage.includes('stream ended without receiving any events') ||
    lowerMessage.includes('missing response_start')
  )
}

function isMalformedResponseMessage(lowerMessage: string): boolean {
  return hasAnyPattern(lowerMessage, MALFORMED_RESPONSE_PATTERNS)
}

function extractOmittableRequestFields(
  error: unknown,
  lowerMessage: string,
): string[] {
  const fields = new Set<string>()
  collectParamFields(error, fields)

  const patterns = [
    /(?:unknown|unsupported|unrecognized)\s+(?:parameter|request argument|field)[:\s]+[`'"]?([a-zA-Z0-9_.-]+)[`'"]?/g,
    /parameter\s+[`'"]?([a-zA-Z0-9_.-]+)[`'"]?\s+(?:is|was)\s+not\s+(?:supported|recognized|allowed)/g,
    /[`'"]([a-zA-Z0-9_.-]+)[`'"]\s+(?:is|was)\s+not\s+(?:supported|recognized|allowed)/g,
  ]

  for (const pattern of patterns) {
    for (const match of lowerMessage.matchAll(pattern)) {
      const field = normalizeOmittableField(match[1])
      if (field) {
        fields.add(field)
      }
    }
  }

  return [...fields]
}

function collectParamFields(
  value: unknown,
  fields: Set<string>,
): void {
  if (!value || typeof value !== 'object') {
    return
  }

  const obj = value as Record<string, unknown>
  const param = obj.param
  if (typeof param === 'string') {
    const field = normalizeOmittableField(param)
    if (field) {
      fields.add(field)
    }
  }
  collectParamFields(obj.error, fields)
  collectParamFields(obj.body, fields)
  collectParamFields(obj.cause, fields)
}

function normalizeOmittableField(field: string | undefined): string | null {
  if (!field) {
    return null
  }
  const normalized = field
    .trim()
    .replace(/^body\./, '')
    .split('.')[0]
    ?.replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase()

  if (!normalized || !OMITTABLE_REQUEST_FIELDS.has(normalized)) {
    return null
  }
  return normalized
}

// ---------------------------------------------------------------------------
// Non-SDK error detection
// ---------------------------------------------------------------------------

function isTimeoutLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    const name = error.constructor.name
    return (
      name === 'TimeoutError' ||
      name === 'ReadTimeout' ||
      name === 'ConnectTimeout' ||
      name === 'PoolTimeout' ||
      name === 'AbortError'
    )
  }
  return false
}

function isConnectionLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    const name = error.constructor.name
    return (
      name === 'ConnectionError' ||
      name === 'ConnectionResetError' ||
      name === 'BrokenPipeError' ||
      name === 'ServerDisconnectedError' ||
      name.includes('Connect')
    )
  }
  return false
}

function isRateLimitLikeError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current !== 'object') {
      return false
    }
    const obj = current as { cause?: unknown; error?: unknown }
    if (current instanceof Error) {
      const name = current.constructor.name || current.name
      if (name === 'RateLimitError') {
        return true
      }
    } else {
      const constructorName = (current as { constructor?: { name?: string } })
        .constructor?.name
      if (constructorName === 'RateLimitError') {
        return true
      }
    }
    current = obj.cause ?? obj.error
  }
  return false
}

// ---------------------------------------------------------------------------
// Result builder (fills defaults for omitted hints)
// ---------------------------------------------------------------------------

function result(
  reason: ErrorFailoverReason,
  overrides: Partial<ClassifiedError> & { message?: string },
): ClassifiedError {
  return {
    reason,
    statusCode: undefined,
    message: overrides.message ?? '',
    retryable: false,
    shouldCompress: false,
    shouldFallback: false,
    retryAfterMs: undefined,
    ...overrides,
  }
}
