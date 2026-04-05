/**
 * Protocol-neutral types for LLM streaming.
 * Both Anthropic and OpenAI streams get converted to these types
 * before being consumed by processStream().
 */

// ===== Content blocks (response side) =====

export type TextBlock = {
  type: 'text'
  text: string
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
  signature?: string
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

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ServerToolUseBlock
  | ServerToolResultBlock

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
   * Content blocks. Typed as any[] for compatibility with 97+ internal files
   * that access block fields without strict narrowing. The runtime values are
   * ContentBlock instances, but provider-specific blocks (mcp_tool_use,
   * code_execution_tool_result, etc.) may also appear.
   */
  content: any[]
  model: string
  stop_reason: StopReason
  stop_sequence: string | null
  usage: LLMMessageUsage
  /** Allow extra provider-specific fields (e.g. container, context_management) */
  [key: string]: unknown
}

export type LLMMessageUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
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
  cache_control?: { type: 'ephemeral' } | null
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

// ===== Tool choice =====

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'specific'; name: string }
