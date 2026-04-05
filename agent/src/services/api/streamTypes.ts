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

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock

// ===== Stop reason =====

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'content_filter'
  | null

// ===== Usage =====

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
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
// =====================================================================

// ===== Request content blocks =====

export type TextBlockParam = {
  type: 'text'
  text: string
}

export type ImageBlockParam = {
  type: 'image'
  mediaType: string
  data: string // base64
}

export type ToolResultBlockParam = {
  type: 'tool_result'
  toolUseId: string
  content: string | TextBlockParam[]
  isError?: boolean
}

export type ToolUseBlockParam = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ThinkingBlockParam = {
  type: 'thinking'
  thinking: string
  signature?: string
}

export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolResultBlockParam
  | ToolUseBlockParam
  | ThinkingBlockParam

// ===== Request messages =====

export type UserMessageParam = {
  role: 'user'
  content: string | ContentBlockParam[]
}

export type AssistantMessageParam = {
  role: 'assistant'
  content: ContentBlockParam[]
}

export type MessageParam = UserMessageParam | AssistantMessageParam

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
