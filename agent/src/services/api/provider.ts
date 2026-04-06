/**
 * LLM Provider interface.
 *
 * Encapsulates everything protocol-specific: client creation, auth,
 * param building, API call, retry, stream adaptation, cost calculation.
 *
 * The caller (queryModel in claude.ts) only sees neutral types.
 */
import {
  LLMAPIError,
} from './streamTypes.js'
import type {
  LLMMessage,
  StreamEvent,
  StreamIntent,
  Usage,
} from './streamTypes.js'
import type {
  SystemAPIErrorMessage,
} from '../../types/message.js'

// ---------------------------------------------------------------------------
// Stream request (protocol-neutral)
// ---------------------------------------------------------------------------

/**
 * Protocol-neutral request for a streaming LLM call.
 * Contains only model-agnostic fields. Provider-specific configuration
 * is injected through the provider's constructor (session-level) or
 * through RequestHooks (request-level).
 */
export interface StreamRequest {
  model: string
  signal: AbortSignal
  intent: StreamIntent
  hooks?: RequestHooks
}

// ---------------------------------------------------------------------------
// Request hooks (protocol-neutral callbacks)
// ---------------------------------------------------------------------------

/**
 * Request-level hooks for orchestration.
 *
 * These are callbacks that the caller (claude.ts) passes per-request
 * to receive lifecycle notifications. They are protocol-neutral —
 * any provider can call them.
 *
 * Provider-specific data (e.g., Anthropic raw events) is NOT exposed
 * through these hooks. Instead, providers emit neutral ProviderEvents
 * via onProviderEvent.
 */
export interface RequestHooks {
  /** Called at each retry attempt start. */
  onAttemptStart?: (info: { attempt: number; start: number; fastMode?: boolean }) => void
  /** Called after request headers are received. */
  onRequestSent?: (info: { maxOutputTokens: number; requestId?: string; response?: unknown }) => void
  /** Called with provider-neutral events (TTFB, research, advisor, etc.). */
  onProviderEvent?: (event: ProviderEvent) => void
  /**
   * Transitional: Anthropic-specific params builder injected per-request.
   * Will be internalized into AnthropicProvider when StreamIntent is enriched
   * to carry all necessary application-layer state.
   */
  buildParams?: (retryContext: unknown) => Record<string, unknown>
}

/**
 * Provider-neutral events emitted during streaming.
 * Providers convert their SDK-specific events into these neutral events.
 */
export type ProviderEvent =
  | { type: 'ttfb'; ms: number }
  | { type: 'research'; data: unknown }
  | { type: 'advisor_start'; model: string }
  | { type: 'advisor_end' }

// ---------------------------------------------------------------------------
// Stream result
// ---------------------------------------------------------------------------

/**
 * Result of a streaming request.
 * Carries the neutral event stream plus metadata the caller needs.
 */
export interface ProviderStreamResult {
  /** Neutral stream events for processStream */
  stream: AsyncIterable<StreamEvent>
  /** Server-assigned request ID (for logging/correlation) */
  requestId?: string
  /** Response headers (for quota status, gateway detection) */
  responseHeaders?: Headers
  /** Max output tokens used for this request (for error messages) */
  maxOutputTokens: number
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Error classification for retry/fallback decisions.
 * The caller uses this to decide: retry? fallback to non-streaming? abort?
 */
export interface ErrorClassification {
  retryable: boolean
  type:
    | 'rate_limit'
    | 'overloaded'
    | 'auth'
    | 'connection'
    | 'abort'
    | 'timeout'
    | 'other'
  statusCode?: number
  retryAfterMs?: number
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  readonly name: string

  /**
   * Create a streaming request.
   *
   * This is an async generator because providers may need to yield
   * messages during the connection phase (e.g. Anthropic yields retry
   * error notifications). After all retries succeed, the generator
   * returns the final ProviderStreamResult.
   *
   * Usage:
   * ```
   * const gen = provider.createStream(request)
   * let result: ProviderStreamResult
   * for (;;) {
   *   const next = await gen.next()
   *   if (next.done) { result = next.value; break }
   *   yield next.value  // retry messages
   * }
   * // Now consume result.stream via processStream
   * ```
   */
  createStream(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, ProviderStreamResult>

  /**
   * Classify an error for retry/fallback decisions.
   * Called when the stream fails or processStream throws.
   */
  classifyError(error: unknown): ErrorClassification

  /**
   * Calculate cost in USD for the given model and usage.
   * Returns null if pricing is unknown.
   */
  calculateCost(model: string, usage: Usage): number | null

  /**
   * Wrap a provider-specific error into a protocol-neutral LLMAPIError.
   * Called at catch boundaries to normalize errors before they propagate
   * to non-protocol code. Returns the original error if it's already
   * an LLMAPIError.
   */
  wrapError(error: unknown): LLMAPIError

  /**
   * Optional: non-streaming fallback when streaming fails.
   *
   * Anthropic needs this because proxy gateways can return 200 with non-SSE
   * body, or streams can silently hang. The fallback re-issues the same
   * request without `stream: true`.
   *
   * Other providers (OpenAI, etc.) don't have this failure mode and should
   * not implement this method.
   */
  createNonStreamingFallback?(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, NonStreamingResult>

}

// ---------------------------------------------------------------------------
// Non-streaming fallback result
// ---------------------------------------------------------------------------

/**
 * Result of a non-streaming fallback request.
 * Carries a complete LLM message (neutral type) plus metadata.
 */
export interface NonStreamingResult {
  /** The complete response message in neutral format. */
  message: LLMMessage
  /** Server-assigned request ID (for logging/correlation). */
  requestId?: string
}
