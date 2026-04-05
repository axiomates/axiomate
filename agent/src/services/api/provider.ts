/**
 * LLM Provider interface.
 *
 * Encapsulates everything protocol-specific: client creation, auth,
 * param building, API call, retry, stream adaptation, cost calculation.
 *
 * The caller (queryModel in claude.ts) only sees neutral types.
 */
import type {
  LLMMessage,
  StreamEvent,
  Usage,
} from './streamTypes.js'

// ---------------------------------------------------------------------------
// Stream request
// ---------------------------------------------------------------------------

/**
 * Protocol-neutral request for a streaming LLM call.
 *
 * Neutral fields (model, signal) are used by all providers.
 * providerOptions carries provider-specific configuration opaquely —
 * each provider knows what to extract from it.
 */
/**
 * Base stream request with generic provider options.
 *
 * Each provider defines a concrete options type (e.g. AnthropicProviderOptions).
 * The caller constructs the correct options based on the selected provider.
 * Defaults to Record<string, unknown> for backward compatibility.
 */
export interface StreamRequest<TOptions = Record<string, unknown>> {
  model: string
  signal: AbortSignal
  /** Provider-specific options. Type-safe when the provider type is known. */
  providerOptions: TOptions
}

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
   *
   * OpenAI providers that don't retry can simply return immediately:
   * ```
   * async *createStream(request) {
   *   const stream = await openai.chat.completions.create(...)
   *   return { stream: adapt(stream), ... }
   * }
   * ```
   */
  createStream(
    request: StreamRequest,
  ): AsyncGenerator<unknown, ProviderStreamResult>

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
   * Optional: non-streaming fallback when streaming fails.
   *
   * Anthropic needs this because proxy gateways can return 200 with non-SSE
   * body, or streams can silently hang. The fallback re-issues the same
   * request without `stream: true`.
   *
   * Other providers (OpenAI, etc.) don't have this failure mode and should
   * not implement this method.
   *
   * Like createStream, this is an async generator that yields retry error
   * messages during attempts, then returns the final result.
   */
  createNonStreamingFallback?(
    request: StreamRequest,
  ): AsyncGenerator<unknown, NonStreamingResult>
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
