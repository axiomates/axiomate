import { feature } from 'bun:bundle'
import type { QuerySource } from '../../constants/querySource.js'
import type { SystemAPIErrorMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { createSystemAPIErrorMessage } from '../../utils/messages.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import {
  logEvent,
} from '../analytics/index.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { classifyError } from './errorClassifier.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { LLMAbortError, LLMAPIError } from './streamTypes.js'

const abortError = () => new LLMAbortError()

const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_OVERLOADED_RETRIES = 3
export const BASE_DELAY_MS = 500

// Foreground query sources where the user IS blocking on the result — these
// retry on overloaded errors. Everything else (summaries, titles, suggestions,
// classifiers) bails immediately: during a capacity cascade each retry is
// 3-10× gateway amplification, and the user never sees those fail anyway.
const FOREGROUND_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  'auto_mode',
  ...(feature('DEV') ? (['bash_classifier'] as const) : []),
])

function isForegroundSource(querySource: QuerySource | undefined): boolean {
  return querySource === undefined || FOREGROUND_RETRY_SOURCES.has(querySource)
}

function isStaleConnectionError(error: unknown): boolean {
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  /**
   * Provider-level adaptive flag: drop the max_tokens field from the request
   * body before retrying. Set when the classifier detects the caller's
   * max_tokens alone exceeds the model's output cap (OpenAI-family only;
   * Anthropic requires max_tokens). Providers that honor this field re-issue
   * without max_tokens and let the provider pick a default output budget.
   */
  dropMaxTokens?: boolean
  model: string
  thinkingConfig: ThinkingConfig
}

export interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<C, T>(
  getClient: () => Promise<C>,
  operation: (
    client: C,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
  }
  let client: C | null = null
  let consecutiveOverloadedErrors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new LLMAbortError()
    }

    try {
      // Get a fresh client instance on first attempt or after authentication
      // errors, stale OAuth tokens, or stale keep-alive sockets.
      // - ECONNRESET/EPIPE: stale keep-alive socket; disable pooling and reconnect
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        false
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof LLMAPIError && lastError.status === 401) ||
        isStaleConnection
      ) {
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof LLMAPIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // ---------------------------------------------------------------
      // Single-pass classification — all retry decisions read from this
      // ---------------------------------------------------------------
      const classified = classifyError(error, {
        provider: 'axiomate',
        model: options.model,
      })


      // ---------------------------------------------------------------
      // 1. Abort — user cancelled, no recovery
      // ---------------------------------------------------------------
      if (classified.reason === 'abort') {
        throw error
      }

      // ---------------------------------------------------------------
      // 2. Overloaded — background sources bail, foreground track + fallback
      // ---------------------------------------------------------------
      if (classified.reason === 'overloaded') {
        if (!isForegroundSource(options.querySource)) {
          throw new CannotRetryError(error, retryContext)
        }

        consecutiveOverloadedErrors++
        if (consecutiveOverloadedErrors >= MAX_OVERLOADED_RETRIES) {
          if (options.fallbackModel) {
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }
          throw new CannotRetryError(
            new Error(REPEATED_529_ERROR_MESSAGE),
            retryContext,
          )
        }
      } else {
        consecutiveOverloadedErrors = 0
      }

      // ---------------------------------------------------------------
      // 3. Max retries exhausted — fail
      // ---------------------------------------------------------------
      if (attempt > maxRetries) {
        throw new CannotRetryError(error, retryContext)
      }

      // ---------------------------------------------------------------
      // 4. Thinking signature error — disable thinking and retry
      // ---------------------------------------------------------------
      if (classified.reason === 'thinking_signature') {
        logForDebugging('Thinking signature error — disabling thinking for retry')
        retryContext.thinkingConfig = { type: 'disabled' }
        continue
      }

      // ---------------------------------------------------------------
      // 5. max_tokens alone too large — drop the field and retry once.
      //     OpenAI-family: max_tokens is optional, provider picks a default
      //     when omitted. Anthropic ignores the flag (max_tokens is required
      //     there) and falls through to the retryable-or-fail gate below.
      //     Already dropped once? No further adaptation possible — bail.
      // ---------------------------------------------------------------
      if (classified.reason === 'max_tokens_too_large') {
        if (!retryContext.dropMaxTokens) {
          logForDebugging(
            'max_tokens too large — retrying without max_tokens field',
          )
          retryContext.dropMaxTokens = true
          continue
        }
      }

      // ---------------------------------------------------------------
      // 6. Context overflow — try disabling thinking first, then adjust max_tokens
      // ---------------------------------------------------------------
      if (classified.reason === 'context_overflow') {
        // First attempt: if thinking is consuming output tokens, disable it
        if (retryContext.thinkingConfig.type !== 'disabled') {
          logForDebugging('Context overflow with thinking enabled — disabling thinking to free tokens')
          retryContext.thinkingConfig = { type: 'disabled' }
          continue
        }

        // Second attempt: adjust max_tokens if we can parse the overflow details
        if (error instanceof LLMAPIError) {
          const overflowData = parseMaxTokensContextOverflowError(error)
          if (overflowData) {
            const { inputTokens, contextLimit } = overflowData
            const safetyBuffer = 1000
            const availableContext = Math.max(
              0,
              contextLimit - inputTokens - safetyBuffer,
            )
            if (availableContext < FLOOR_OUTPUT_TOKENS) {
              logError(
                new Error(
                  `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
                ),
              )
              throw error
            }
            const adjustedMaxTokens = Math.max(
              FLOOR_OUTPUT_TOKENS,
              availableContext,
            )
            retryContext.maxTokensOverride = adjustedMaxTokens
            continue
          }
        }
      }

      // ---------------------------------------------------------------
      // 6. Not retryable — fail immediately
      // ---------------------------------------------------------------
      if (!classified.retryable) {
        throw new CannotRetryError(error, retryContext)
      }

      // ---------------------------------------------------------------
      // 7. Retryable — backoff and retry
      // ---------------------------------------------------------------
      const delayMs = classified.retryAfterMs ?? getRetryDelay(attempt)


      if (error instanceof LLMAPIError) {
        yield createSystemAPIErrorMessage(
          error,
          delayMs,
          attempt,
          maxRetries,
          classified.reason,
        )
      }
      await sleep(delayMs, options.signal, { abortError })
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function parseMaxTokensContextOverflowError(error: LLMAPIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

export function is529Error(error: unknown): boolean {
  if (!(error instanceof LLMAPIError)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // See below: the SDK sometimes fails to properly pass the 529 status code during streaming
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

export function getDefaultMaxRetries(): number {
  if (process.env.AXIOMATE_CODE_MAX_RETRIES) {
    return parseInt(process.env.AXIOMATE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}
