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
import { LLMAbortError, LLMAPIError } from './streamTypes.js'

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
  | 'payload_too_large'  // 413
  | 'model_not_found'    // 404 / invalid model
  | 'format_error'       // 400 bad request (not context overflow)
  | 'server_error'       // 500/502
  | 'thinking_signature' // Anthropic thinking block signature invalid
  | 'long_context_tier'  // Anthropic "extra usage" tier gate (429 + long context)
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
  'credit balance',
  'credits have been exhausted',
  'top up your credits',
  'payment required',
  'billing hard limit',
  'exceeded your current quota',
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

  // 2. Extract HTTP status code and message from the error chain
  const statusCode = extractStatusCode(error)
  const message = extractMessage(error)
  const lowerMessage = message.toLowerCase()

  // 3. Provider-specific patterns (highest priority — before generic HTTP dispatch)
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

  // 4. HTTP status dispatch
  if (statusCode !== undefined) {
    const retryAfterMs = parseRetryAfterMs(error)

    switch (statusCode) {
      case 401:
      case 403:
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
        return result('model_not_found', {
          statusCode,
          retryable: false,
          shouldFallback: true,
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
        return classify400(lowerMessage, statusCode, message, context)

      case 500:
      case 502:
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
      isLargeSession(context)
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
  if (hasAnyPattern(lowerMessage, SERVER_DISCONNECT_PATTERNS) && isLargeSession(context)) {
    return result('context_overflow', {
      retryable: true,
      shouldCompress: true,
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

  if (hasAnyPattern(lowerMessage, RATE_LIMIT_PATTERNS)) {
    return result('rate_limit', { retryable: true, shouldFallback: true, message })
  }

  if (hasAnyPattern(lowerMessage, BILLING_PATTERNS)) {
    return result('billing', { retryable: false, shouldFallback: true, message })
  }

  if (hasAnyPattern(lowerMessage, MODEL_NOT_FOUND_PATTERNS)) {
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
  if (hasAnyPattern(lowerMessage, RATE_LIMIT_TRANSIENT_SIGNALS)) {
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
  lowerMessage: string,
  statusCode: number,
  message: string,
  context: ErrorClassificationContext,
): ClassifiedError {
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
  // Hermes heuristic: generic 400 + large session → likely context overflow
  // Threshold: >40% of context window OR >80K tokens OR >80 messages
  if (isLargeSession(context)) {
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

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function hasAnyPattern(lowerMessage: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => lowerMessage.includes(pattern))
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
