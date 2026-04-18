/**
 * Protocol-neutral types for LLM streaming.
 * Both Anthropic and OpenAI streams get converted to these types
 * before being consumed by processStream().
 */

import type {
  CitationsConfigParam,
  TextCitation,
  TextCitationParam,
} from '@anthropic-ai/sdk/resources/messages/messages'

// Re-export so consumers don't need a direct SDK dependency
export type { CitationsConfigParam, TextCitation, TextCitationParam }

// ===== Content blocks (response side) =====

export type TextBlock = {
  type: 'text'
  text: string
  /** Provider extension: Anthropic citations. Present when citation feature is enabled. */
  citations?: TextCitation[] | null
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
  | { type: 'citations'; citation: TextCitation }
  | { type: 'connector_text'; text: string }

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
  citations?: TextCitationParam[] | null
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

export type Base64PDFSource = {
  type: 'base64'
  media_type: 'application/pdf'
  data: string
}

export type PlainTextSource = {
  type: 'text'
  media_type: 'text/plain'
  data: string
}

export type ContentBlockSource = {
  type: 'content'
  content: string | ContentBlockParam[]
}

export type URLPDFSource = {
  type: 'url'
  url: string
}

export type DocumentBlockSource =
  | Base64PDFSource
  | PlainTextSource
  | ContentBlockSource
  | URLPDFSource

export type DocumentBlockParam = {
  type: 'document'
  source: DocumentBlockSource
  cache_control?: { type: 'ephemeral' } | null
  title?: string | null
  context?: string | null
  citations?: CitationsConfigParam
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
  content: string | ContentBlockParam[]
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
 * Fields like strict, cache_control are provider hints — providers that don't
 * support them simply ignore them.
 */
export type NeutralToolSchema = ToolDefinition & {
  strict?: boolean
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

// =====================================================================
// Non-streaming inference (side queries, classifiers, validation)
// =====================================================================

/**
 * Non-streaming inference request.
 * Used by sideQuery, classifiers, model validation — lightweight API calls
 * outside the main conversation streaming loop.
 */
export type InferenceRequest = {
  model: string
  messages: MessageParam[]
  system?: string | ContentBlockParam[]
  tools?: NeutralToolSchema[]
  toolChoice?: ToolChoice
  outputFormat?: NeutralOutputFormat
  maxTokens?: number
  temperature?: number
  thinking?: { type: 'enabled' | 'disabled' | 'adaptive'; budgetTokens?: number }
  stopSequences?: string[]
  signal?: AbortSignal
  /** Provider-specific metadata (fingerprint, attribution, query source, etc.) */
  metadata?: Record<string, unknown>
  /**
   * Provider-specific hints. Providers read hints they understand, ignore the rest.
   * Anthropic: { betas?: string[], cacheControl?: boolean, ... }
   * OpenAI: { ... }
   */
  providerHints?: Record<string, unknown>
}

/**
 * Non-streaming inference response.
 * Protocol-neutral: content blocks, usage, stop reason.
 */
export type InferenceResponse = {
  id: string
  content: ContentBlock[]
  model: string
  stopReason: StopReason
  usage: Usage
  /** Provider-assigned request ID (for correlation/logging) */
  requestId?: string
}

/**
 * Token counting request.
 * Not all providers support this (OpenAI uses local tiktoken instead).
 */
export type CountTokensRequest = {
  model: string
  messages: MessageParam[]
  tools?: NeutralToolSchema[]
  thinking?: boolean
}
