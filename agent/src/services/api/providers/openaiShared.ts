/**
 * Shared OpenAI SDK helpers used by both Chat Completions and Responses API
 * providers.
 *
 * These helpers operate on `OpenAI.APIError` — the SDK error shape is identical
 * across the two surfaces, so the error classification, wrapping, connection
 * verification, and stream-unsupported detection are all protocol-agnostic.
 */
import OpenAI from 'openai'
import {
  LLMAPIError,
  LLMAbortError,
} from '../streamTypes.js'
import type { ErrorClassification } from '../provider.js'
import {
  emitAuxiliaryRecoveryTrace,
  type AuxiliaryRecoveryTraceInput,
} from '../auxiliaryRecoveryTrace.js'

/**
 * Wrap a provider-specific error into the protocol-neutral LLMAPIError.
 * Called at every SDK call site so withRetry's classifier sees a uniform type.
 */
export function wrapError(error: unknown): LLMAPIError {
  if (error instanceof LLMAPIError) return error

  if (error instanceof OpenAI.APIError) {
    if (error instanceof OpenAI.APIUserAbortError) {
      return new LLMAbortError(error)
    }
    return new LLMAPIError(error.message, {
      status: error.status,
      cause: error,
      headers: error.headers as Record<string, string> | undefined,
    })
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new LLMAbortError(error)
    }
    return new LLMAPIError(error.message, { cause: error })
  }

  return new LLMAPIError(String(error))
}

/**
 * Classify an error for retry/fallback decisions.
 */
export function classifyError(error: unknown): ErrorClassification {
  if (
    error instanceof LLMAbortError ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return { retryable: false, type: 'abort' }
  }

  const status =
    error instanceof LLMAPIError
      ? error.status
      : error instanceof OpenAI.APIError
        ? error.status
        : undefined

  if (!status) {
    return { retryable: true, type: 'connection' }
  }

  switch (status) {
    case 429:
      return { retryable: true, type: 'rate_limit', statusCode: 429 }
    case 503:
    case 529:
      return { retryable: true, type: 'overloaded', statusCode: status }
    case 401:
    case 403:
      return { retryable: false, type: 'auth', statusCode: status }
    case 408:
      return { retryable: true, type: 'timeout', statusCode: 408 }
    default:
      return { retryable: status >= 500, type: 'other', statusCode: status }
  }
}

/**
 * Verify an OpenAI-compatible endpoint by listing models.
 * Returns true if auth works, false on 401/403, throws on other errors.
 */
export async function verifyConnection(
  client: OpenAI,
  traceOptions: Omit<
    AuxiliaryRecoveryTraceInput,
    'provider' | 'operation' | 'error'
  > & {
    provider: AuxiliaryRecoveryTraceInput['provider']
  },
): Promise<boolean> {
  try {
    await client.models.list()
    return true
  } catch (error) {
    const classified = classifyError(error)
    if (classified.type === 'auth') {
      emitAuxiliaryRecoveryTrace({
        ...traceOptions,
        operation: 'verify_connection',
        error,
      })
      return false
    }
    throw wrapError(error)
  }
}

/**
 * Detect "endpoint does not support streaming" errors. Kept intentionally
 * narrow: must be a 400 whose message rejects streaming mode itself. Do not
 * match request-field errors such as unsupported `stream_options`; those belong
 * to the normal observe→decide→execute request-shape recovery path.
 */
export function isStreamUnsupportedError(err: unknown): boolean {
  const wrapped = wrapError(err)
  if (wrapped.status !== 400) return false
  const msg = String(wrapped.message || '').toLowerCase()
  if (mentionsRequestStreamOption(msg)) return false
  return STREAM_UNSUPPORTED_PATTERNS.some(pattern => pattern.test(msg))
}

const STREAM_UNSUPPORTED_PATTERNS = [
  /\bstreaming\s+(?:is\s+)?not\s+supported\b/,
  /\bstream\s+mode\s+(?:is\s+)?not\s+supported\b/,
  /\bdoes\s+not\s+support\s+streaming\b/,
  /\bdoes\s+not\s+support\s+stream(?:ing)?\s+(?:mode|responses?|requests?)\b/,
  /\bstream(?:ing)?\s+(?:mode\s+)?(?:is\s+)?unsupported\b/,
]

function mentionsRequestStreamOption(message: string): boolean {
  return (
    message.includes('stream_options') ||
    message.includes('stream option')
  )
}
