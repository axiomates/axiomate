import { APIError } from '@anthropic-ai/sdk'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'
import {
  addToTotalDurationState,
  setLastApiCompletionTimestamp,
} from '../../bootstrap/state.js'
import type { AssistantMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import {
  endLLMRequestSpan,
  isBetaTracingEnabled,
  type Span,
} from '../../utils/telemetry/sessionTracing.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

export type { NonNullableUsage }
export { EMPTY_USAGE }

// Strategy used for global prompt caching
export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

function getErrorMessage(error: unknown): string {
  if (error instanceof APIError) {
    const body = error.error as { error?: { message?: string } } | undefined
    if (body?.error?.message) return body.error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export function logAPIError({
  error,
  model,
  durationMs,
  attempt,
  clientRequestId,
  llmSpan,
}: {
  error: unknown
  model: string
  durationMs: number
  attempt: number
  /** Client-generated ID sent as x-client-request-id header (survives timeouts) */
  clientRequestId?: string
  /** The span from startLLMRequestSpan - pass this to correctly match responses to requests */
  llmSpan?: Span
}): void {
  const errStr = getErrorMessage(error)
  const status = error instanceof APIError ? String(error.status) : undefined

  // Log detailed connection error info to debug logs (visible via --debug)
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    const sslLabel = connectionDetails.isSSLError ? ' (SSL error)' : ''
    logForDebugging(
      `Connection error details: code=${connectionDetails.code}${sslLabel}, message=${connectionDetails.message}`,
      { level: 'error' },
    )
  }

  if (clientRequestId) {
    logForDebugging(
      `API error x-client-request-id=${clientRequestId} (give this to the API team for server-log lookup)`,
      { level: 'error' },
    )
  }

  logError(error as Error)

  void logOTelEvent('api_error', {
    model: model,
    error: errStr,
    status_code: String(status),
    duration_ms: String(durationMs),
    attempt: String(attempt),
    speed: 'normal',
  })

  // Pass the span to correctly match responses to requests when beta tracing is enabled
  endLLMRequestSpan(llmSpan, {
    success: false,
    statusCode: status ? parseInt(status) : undefined,
    error: errStr,
    attempt,
  })
}

export function logAPISuccessAndDuration({
  start,
  startIncludingRetries,
  ttftMs,
  usage,
  attempt,
  costUSD,
  model,
  newMessages,
  llmSpan,
  requestSetupMs,
  attemptStartTimes,
}: {
  model: string
  start: number
  startIncludingRetries: number
  ttftMs: number | null
  usage: NonNullableUsage
  attempt: number
  costUSD: number
  /** Assistant messages from the response - used to extract model_output
   *  when beta tracing is enabled */
  newMessages?: AssistantMessage[]
  /** The span from startLLMRequestSpan - pass this to correctly match responses to requests */
  llmSpan?: Span
  /** Time spent in pre-request setup before the successful attempt */
  requestSetupMs?: number
  /** Timestamps (Date.now()) of each attempt start — used for retry sub-spans in Perfetto */
  attemptStartTimes?: number[]
}): void {
  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  addToTotalDurationState(durationMsIncludingRetries, durationMs)

  void logOTelEvent('api_request', {
    model,
    input_tokens: String(usage.input_tokens),
    output_tokens: String(usage.output_tokens),
    cache_read_tokens: String(usage.cache_read_input_tokens),
    cache_creation_tokens: String(usage.cache_creation_input_tokens),
    cost_usd: String(costUSD),
    duration_ms: String(durationMs),
    speed: 'normal',
  })

  // Extract model output and tool call flag when beta tracing is enabled
  let modelOutput: string | undefined
  let hasToolCall: boolean | undefined

  if (isBetaTracingEnabled() && newMessages) {
    modelOutput =
      newMessages
        .flatMap(m =>
          m.message.content
            .filter(c => c.type === 'text')
            .map(c => (c as { type: 'text'; text: string }).text),
        )
        .join('\n') || undefined

    hasToolCall = newMessages.some(m =>
      m.message.content.some(c => c.type === 'tool_use'),
    )
  }

  // Pass the span to correctly match responses to requests when beta tracing is enabled
  endLLMRequestSpan(llmSpan, {
    success: true,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    attempt,
    modelOutput,
    hasToolCall,
    ttftMs: ttftMs ?? undefined,
    requestSetupMs,
    attemptStartTimes,
  })

  setLastApiCompletionTimestamp(Date.now())
}
