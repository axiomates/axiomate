/**
 * LLM Provider interface.
 *
 * Encapsulates everything protocol-specific: client creation, auth,
 * param building, API call, retry, stream adaptation, cost calculation.
 *
 * The caller (queryModel in claude.ts) only sees neutral types.
 */
import type {
  MessageParam,
  StreamEvent,
  TextBlockParam,
  ToolChoice,
  ToolDefinition,
  Usage,
} from './streamTypes.js'

// ---------------------------------------------------------------------------
// Stream request
// ---------------------------------------------------------------------------

/**
 * Protocol-neutral request for a streaming LLM call.
 * Each provider converts this to its own SDK format internally.
 */
export interface StreamRequest {
  model: string
  messages: MessageParam[]
  systemPrompt: string | TextBlockParam[]
  tools: ToolDefinition[]
  toolChoice?: ToolChoice
  maxTokens: number
  temperature?: number
  /**
   * Provider-specific options passed opaquely.
   * Anthropic: { betas, thinkingConfig, cacheControl, fastMode, metadata, ... }
   * OpenAI: { streamOptions, responseFormat, seed, ... }
   */
  providerOptions?: Record<string, unknown>
  signal: AbortSignal
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
   * Create a streaming request and return neutral events.
   * Handles internally: client creation, auth, param building,
   * SDK call, retry logic, raw→neutral stream adaptation.
   */
  createStream(request: StreamRequest): Promise<ProviderStreamResult>

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
}
