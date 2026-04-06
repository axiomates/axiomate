/**
 * Protocol-neutral types for LLM streaming.
 * Both Anthropic and OpenAI streams get converted to these types
 * before being consumed by processStream().
 */

// ===== Content blocks (response side) =====

export type TextBlock = {
  type: 'text'
  text: string
  /** Provider extension: Anthropic citations. Present when citation feature is enabled. */
  citations?: unknown[] | null
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ThinkingBlock = {
  type: 'thinking'
  thinking: string
  /** Always populated: accumulator initializes to '', signature_delta fills actual value. */
  signature: string
}

export type ServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ServerToolResultBlock = {
  type: 'server_tool_result'
  id: string
  toolUseId: string
  content: unknown
}

/** Redacted thinking block (content not visible) */
export type RedactedThinkingBlock = {
  type: 'redacted_thinking'
  data: string
}

/** Connector text block (Anthropic-specific, feature-gated) */
export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ServerToolUseBlock
  | ServerToolResultBlock
  | ConnectorTextBlock

// ===== Stop reason =====

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'content_filter'
  | null

// ===== Usage (stream event layer — camelCase) =====

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// ===== LLM Message (internal message layer — snake_case for 97+ file compatibility) =====

/**
 * Protocol-neutral LLM response message.
 * Field names use snake_case to maintain compatibility with 97+ internal files
 * that access .message.content, .message.stop_reason, .message.usage etc.
 */
export type LLMMessage = {
  id: string
  type: 'message'
  role: 'assistant'
  /**
   * Content blocks returned by the LLM.
   * Known block types (text, tool_use, thinking, etc.) are modeled explicitly.
   * Provider-specific blocks not yet modeled fall through as UnknownContentBlock.
   */
  content: ContentBlock[]
  model: string
  stop_reason: StopReason
  /** Anthropic-specific: which stop sequence was matched. OpenAI providers omit this. */
  stop_sequence?: string | null
  usage: LLMMessageUsage
}

export type LLMMessageUsage = {
  input_tokens: number
  output_tokens: number
  /** Anthropic prompt caching: tokens used to create cache. OpenAI providers set null. */
  cache_creation_input_tokens: number | null
  /** Anthropic prompt caching: tokens read from cache. OpenAI providers set null. */
  cache_read_input_tokens: number | null
}

// ===== API error (protocol-neutral) =====

/**
 * Protocol-neutral API error class.
 *
 * Providers wrap their SDK-specific errors into LLMAPIError at the boundary
 * (via provider.wrapError()). All non-protocol code uses `instanceof LLMAPIError`
 * instead of `instanceof APIError` from any specific SDK.
 */
export class LLMAPIError extends Error {
  /** HTTP status code (e.g. 429, 529, 500). Undefined for connection errors. */
  status?: number
  /** Response headers (for retry-after, rate-limit info). */
  headers?: Record<string, string> | { get(name: string): string | null }
  /** Provider-assigned request ID. */
  request_id?: string
  /** Nested error body (provider-specific deserialized error). */
  error?: unknown

  constructor(
    message: string,
    opts?: {
      status?: number
      cause?: unknown
      headers?: Record<string, string> | { get(name: string): string | null }
      request_id?: string
      error?: unknown
    },
  ) {
    super(message, { cause: opts?.cause })
    this.name = 'LLMAPIError'
    this.status = opts?.status
    this.headers = opts?.headers
    this.request_id = opts?.request_id
    this.error = opts?.error
  }
}

/**
 * Protocol-neutral abort error (user cancelled the request).
 * Providers wrap their SDK abort errors into this class.
 */
export class LLMAbortError extends LLMAPIError {
  constructor(cause?: unknown) {
    super('Request aborted', { cause })
    this.name = 'LLMAbortError'
  }
}

/**
 * Protocol-neutral timeout error (request exceeded time limit).
 */
export class LLMTimeoutError extends LLMAPIError {
  constructor(message?: string, cause?: unknown) {
    super(message ?? 'Request timed out', { cause })
    this.name = 'LLMTimeoutError'
  }
}

// ===== Response shell =====

export type LLMResponse = {
  id: string
  model: string
  stopReason: StopReason
  usage: Usage
}

// ===== Stream events =====

export type StreamEvent =
  | { type: 'response_start'; response: LLMResponse }
  | { type: 'block_start'; index: number; block: ContentBlock }
  | { type: 'block_delta'; index: number; delta: BlockDelta }
  | { type: 'block_stop'; index: number }
  | { type: 'response_delta'; stopReason: StopReason; usage: Usage }
  | { type: 'response_stop' }

export type BlockDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_input'; json: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'signature'; signature: string }

// =====================================================================
// Request-side types (what gets sent TO the LLM)
//
// Field names use snake_case for compatibility with ~60 internal files
// that construct these objects. OpenAI adapter converts to its own format.
// =====================================================================

// ===== Image source =====

export type Base64ImageSource = {
  data: string
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  type: 'base64'
}

export type URLImageSource = {
  type: 'url'
  url: string
}

// ===== Request content blocks =====

export type TextBlockParam = {
  type: 'text'
  text: string
  /** Provider extension: Anthropic prompt caching. Ignored by OpenAI. */
  cache_control?: { type: 'ephemeral' } | null
  /** Provider extension: Anthropic citations. */
  citations?: unknown[] | null
}

export type ImageBlockParam = {
  type: 'image'
  source: Base64ImageSource | URLImageSource
  cache_control?: { type: 'ephemeral' } | null
}

export type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | (TextBlockParam | ImageBlockParam)[]
  is_error?: boolean
  cache_control?: { type: 'ephemeral' } | null
}

export type ToolUseBlockParam = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  cache_control?: { type: 'ephemeral' } | null
}

export type ThinkingBlockParam = {
  type: 'thinking'
  thinking: string
  signature: string
}

export type RedactedThinkingBlockParam = {
  type: 'redacted_thinking'
  data: string
}

export type DocumentBlockParam = {
  type: 'document'
  source: unknown
  cache_control?: { type: 'ephemeral' } | null
  title?: string | null
  context?: string | null
  citations?: unknown
}

export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolResultBlockParam
  | ToolUseBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam
  | DocumentBlockParam

// ===== Request messages =====

export type MessageParam = {
  /** User messages use ContentBlockParam[], assistant echo-back uses ContentBlock[]. */
  content: string | ContentBlockParam[] | ContentBlock[]
  role: 'user' | 'assistant'
}

export type UserMessageParam = MessageParam & { role: 'user' }
export type AssistantMessageParam = MessageParam & { role: 'assistant' }

// ===== Tool definition =====

export type ToolDefinition = {
  name: string
  description?: string
  inputSchema: Record<string, unknown> // JSON Schema
}

/**
 * Extended tool schema with provider-hint fields.
 * Returned by toolToAPISchema(). Provider adapters convert to SDK-specific types.
 *
 * Fields like strict, defer_loading, cache_control are provider hints —
 * providers that don't support them simply ignore them.
 */
export type NeutralToolSchema = ToolDefinition & {
  strict?: boolean
  /** Anthropic: defer loading for tool search feature */
  defer_loading?: boolean
  /** Anthropic: prompt caching control */
  cache_control?: { type: 'ephemeral'; scope?: string; ttl?: string } | null
  /** Anthropic: enable per-tool streaming of input JSON deltas */
  eager_input_streaming?: boolean
}

// ===== Tool choice =====

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'specific'; name: string }

// ===== Output format (protocol-neutral) =====

/**
 * Protocol-neutral structured output format.
 * Anthropic maps this to BetaJSONOutputFormat, OpenAI to response_format.
 */
export type NeutralOutputFormat = { type: string; [key: string]: unknown }

// ===== Stream intent (protocol-neutral request intent) =====

/**
 * Protocol-neutral description of what to send to the LLM.
 * Built by queryModel(), consumed by provider-specific serializers.
 *
 * Contains the "what" (messages, tools, config) without the "how"
 * (betas, cache breakpoints, effort config, SDK params).
 * Each provider converts StreamIntent → its own SDK params format.
 */
export type StreamIntent = {
  model: string
  /** Normalized messages. Typed as unknown[] because the actual shape
   *  is (UserMessage | AssistantMessage)[] which varies by provider. */
  messages: unknown[]
  systemPrompt: unknown[] // System prompt blocks (provider-specific format)
  tools: NeutralToolSchema[]
  toolChoice?: ToolChoice
  maxOutputTokens: number
  temperature?: number
  thinking?: {
    type: 'disabled' | 'enabled' | 'adaptive'
    budgetTokens?: number
  }
}
