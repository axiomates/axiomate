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
  CountTokensRequest,
  InferenceRequest,
  InferenceResponse,
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
// Bound provider (returned by LLMProvider.bind)
// ---------------------------------------------------------------------------

/**
 * A provider bound with provider-specific request configuration.
 * Returned by LLMProvider.bind(ext). All methods accept pure neutral StreamRequest
 * (no providerExt field needed — the ext is already bound).
 */
export interface BoundProvider {
  createStream(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, ProviderStreamResult>

  createNonStreamingFallback?(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, NonStreamingResult>
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  readonly name: string

  /**
   * Bind provider-specific configuration for a request scope.
   * Returns a BoundProvider whose createStream/createNonStreamingFallback
   * methods accept pure neutral StreamRequest (no providerExt).
   *
   * The ext parameter is provider-specific (e.g. AnthropicRequestExt).
   * Type safety is enforced at the call site via `satisfies ProviderExtType`.
   */
  bind(ext: unknown): BoundProvider

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

  /**
   * Verify that the provider connection works (e.g. API key is valid).
   * Returns true if the key is valid, false if authentication fails.
   * Throws on non-auth errors (network, overloaded, etc.).
   *
   * Provider handles all retry logic, betas, metadata internally.
   */
  verifyConnection?(options: { apiKey?: string }): Promise<boolean>

  /**
   * Non-streaming inference for side queries, classifiers, validation.
   * Unlike createStream, returns a complete response in one call.
   * Provider handles all protocol-specific details (betas, caching, etc.)
   * based on providerHints in the request.
   */
  inference(request: InferenceRequest): Promise<InferenceResponse>

  /**
   * Count tokens for messages + tools.
   * Returns null if the provider doesn't support server-side token counting.
   * Providers that lack a countTokens API (e.g. OpenAI) return null;
   * callers should fall back to local estimation (tiktoken, etc.).
   */
  countTokens(request: CountTokensRequest): Promise<number | null>
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
