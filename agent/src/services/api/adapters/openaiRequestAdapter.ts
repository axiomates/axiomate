/**
 * Neutral → OpenAI request conversion.
 *
 * Converts protocol-neutral types (MessageParam, NeutralToolSchema, ToolChoice)
 * into OpenAI chat.completions.create() parameter shapes.
 */
import type {
  ContentBlockParam,
  MessageParam,
  NeutralToolSchema,
  ToolChoice,
} from '../streamTypes.js'

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Convert neutral MessageParam[] → OpenAI messages.
 *
 * Key mappings:
 * - text blocks → string content or content parts
 * - image blocks → image_url content parts (base64 data URI or URL)
 * - tool_use blocks → assistant message with tool_calls
 * - tool_result blocks → tool role messages
 * - thinking blocks → stripped (OpenAI doesn't support them in history)
 */
export function messagesToOpenAI(
  messages: MessageParam[],
  systemPrompt?: string | ContentBlockParam[],
  options?: { supportsImages?: boolean },
): OpenAIMessage[] {
  const supportsImages = options?.supportsImages ?? true
  const result: OpenAIMessage[] = []

  // System prompt
  if (systemPrompt) {
    const text = typeof systemPrompt === 'string'
      ? systemPrompt
      : systemPrompt
          .filter(b => b.type === 'text')
          .map(b => (b as { text: string }).text)
          .join('\n')
    if (text) {
      result.push({ role: 'system', content: text })
    }
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    // Complex content — need to split tool_use, tool_result, and regular content
    const textParts: OpenAIContentPart[] = []
    const toolCalls: OpenAIToolCall[] = []
    const toolResults: OpenAIMessage[] = []
    // Image parts extracted from tool_result blocks in this msg. OpenAI's
    // role:'tool' message can't carry image content; deferred and emitted
    // as a follow-up role:'user' message after all tool replies.
    const pendingToolResultImages: OpenAIContentPart[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push({ type: 'text', text: block.text })
          break
        case 'image': {
          if (!supportsImages) {
            textParts.push({ type: 'text', text: '[Image omitted: this model does not support image input. Set "supportsImages": true in ~/.axiomate.json if it does.]' })
            break
          }
          const src = block.source
          if (src.type === 'base64') {
            textParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${src.media_type};base64,${src.data}`,
              },
            })
          } else if (src.type === 'url') {
            textParts.push({
              type: 'image_url',
              image_url: { url: src.url },
            })
          }
          break
        }
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input),
            },
          })
          break
        case 'tool_result': {
          // Split tool_result content: text → tool message string content,
          // image → deferred to a follow-up user message (OpenAI forbids
          // image_url inside role:'tool').
          let textContent = ''
          let hadImageDropped = false
          if (typeof block.content === 'string') {
            textContent = block.content
          } else if (Array.isArray(block.content)) {
            const textChunks: string[] = []
            for (const inner of block.content) {
              if (inner.type === 'text') {
                textChunks.push((inner as { text: string }).text)
              } else if (inner.type === 'image') {
                if (!supportsImages) {
                  hadImageDropped = true
                  continue
                }
                const src = (inner as {
                  source?: {
                    type?: string
                    data?: string
                    media_type?: string
                    url?: string
                  }
                }).source
                if (src?.type === 'base64' && src.data && src.media_type) {
                  pendingToolResultImages.push({
                    type: 'image_url',
                    image_url: {
                      url: `data:${src.media_type};base64,${src.data}`,
                    },
                  })
                } else if (src?.type === 'url' && src.url) {
                  pendingToolResultImages.push({
                    type: 'image_url',
                    image_url: { url: src.url },
                  })
                }
              }
            }
            textContent = textChunks.join('\n')
          }
          // OpenAI requires non-empty tool message content. If we deferred
          // images, tell the model so it doesn't see an empty result.
          if (textContent.length === 0) {
            if (pendingToolResultImages.length > 0) {
              textContent = '[Image returned in following message]'
            } else if (hadImageDropped) {
              textContent =
                '[Tool returned an image; this model does not support image input]'
            }
          }
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.is_error ? `Error: ${textContent}` : textContent,
          })
          break
        }
        case 'thinking':
        case 'redacted_thinking':
          // Strip thinking blocks — OpenAI doesn't support them in conversation history
          break
        case 'document':
          // Documents: extract text content if available
          textParts.push({ type: 'text', text: '[Document attached]' })
          break
      }
    }

    // Emit assistant message with tool_calls if present
    if (msg.role === 'assistant' && toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts : null,
        tool_calls: toolCalls,
      })
    } else if (textParts.length > 0) {
      result.push({
        role: msg.role,
        content: textParts.length === 1 && textParts[0]!.type === 'text'
          ? textParts[0]!.text
          : textParts,
      })
    }

    // Emit tool results as separate messages
    for (const tr of toolResults) {
      result.push(tr)
    }

    // Emit images returned by tools as a follow-up user message. OpenAI
    // protocol routes images through user/image_url, never role:'tool'.
    if (pendingToolResultImages.length > 0) {
      result.push({ role: 'user', content: pendingToolResultImages })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

export function toolsToOpenAI(tools: NeutralToolSchema[]): OpenAITool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: 'object', ...t.inputSchema },
      ...(t.strict ? { strict: true } : {}),
    },
  }))
}

// ---------------------------------------------------------------------------
// Tool choice
// ---------------------------------------------------------------------------

export type OpenAIToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }

export function toolChoiceToOpenAI(choice?: ToolChoice): OpenAIToolChoice | undefined {
  if (!choice) return undefined
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'required':
      return 'required'
    case 'specific':
      return { type: 'function', function: { name: choice.name } }
  }
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

import type { StopReason } from '../streamTypes.js'

export function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'content_filter'
    default:
      return reason ? 'end_turn' : null
  }
}
