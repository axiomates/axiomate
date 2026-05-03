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
import { isDebugMode, logForDebugging } from '../../../utils/debug.js'

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  /**
   * DeepSeek V4 Pro thinking-mode chain-of-thought, echoed back from a prior
   * assistant turn. Required by DeepSeek when the prior turn made tool calls
   * (server returns 400 otherwise). Other OpenAI-compat providers ignore the
   * field. Only emitted when the model's config opts in via
   * `roundTripReasoningContent`.
   */
  reasoning_content?: string
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
  options?: { supportsImages?: boolean; roundTripReasoningContent?: boolean },
): OpenAIMessage[] {
  const supportsImages = options?.supportsImages ?? true
  const roundTripReasoning = options?.roundTripReasoningContent ?? false
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
    // Accumulated thinking text for this assistant msg, attached as
    // `reasoning_content` only when roundTripReasoning is enabled.
    let reasoningText = ''

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
        case 'thinking': {
          // Default behavior: strip (OpenAI Chat Completions / vanilla doesn't
          // accept thinking in history). Opt-in: accumulate as reasoning_content
          // for DeepSeek V4 Pro thinking-mode multi-turn requirement.
          if (roundTripReasoning) {
            const t = (block as { thinking?: string }).thinking
            if (t) reasoningText += t
          }
          break
        }
        case 'redacted_thinking':
          // Anthropic-specific encrypted thinking; never sent through OpenAI path
          break
        case 'document':
          // Documents: extract text content if available
          textParts.push({ type: 'text', text: '[Document attached]' })
          break
      }
    }

    // Determine the main message to emit (if any). For user messages with
    // tool_results, the tool messages MUST come before the user text so they
    // sit directly after the preceding assistant's tool_calls. OpenAI and
    // strict providers (DeepSeek V4 Pro) reject tool messages separated from
    // their tool_calls by an intervening user message.
    let mainMessage: OpenAIMessage | null = null
    const emitToolResultsFirst = msg.role === 'user' && toolResults.length > 0

    if (msg.role === 'assistant' && toolCalls.length > 0) {
      mainMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts : null,
        tool_calls: toolCalls,
        ...(reasoningText.length > 0
          ? { reasoning_content: reasoningText }
          : {}),
      }
    } else if (textParts.length > 0) {
      mainMessage = {
        role: msg.role,
        content: textParts.length === 1 && textParts[0]!.type === 'text'
          ? textParts[0]!.text
          : textParts,
        ...(msg.role === 'assistant' && reasoningText.length > 0
          ? { reasoning_content: reasoningText }
          : {}),
      }
    } else if (msg.role === 'assistant' && reasoningText.length > 0) {
      // Edge case: assistant message with thinking only (no text, no tool_use).
      // Emit a stub assistant message so DeepSeek's reasoning chain stays
      // attached to the right turn.
      mainMessage = {
        role: 'assistant',
        content: '',
        reasoning_content: reasoningText,
      }
    }

    // Emit in the correct order: for user messages with tool_results, tool
    // results go first so they immediately follow the assistant's tool_calls.
    if (emitToolResultsFirst) {
      for (const tr of toolResults) result.push(tr)
      if (pendingToolResultImages.length > 0) {
        result.push({ role: 'user', content: pendingToolResultImages })
      }
      if (mainMessage) result.push(mainMessage)
    } else {
      if (mainMessage) result.push(mainMessage)
      for (const tr of toolResults) result.push(tr)
      if (pendingToolResultImages.length > 0) {
        result.push({ role: 'user', content: pendingToolResultImages })
      }
    }
  }

  // Diagnostic: log the final OpenAI message structure when tool_calls are present
  if (isDebugMode()) {
    const hasToolCalls = result.some(m => m.role === 'assistant' && m.tool_calls?.length)
    if (hasToolCalls) {
      const summary = result.map((m, i) => {
        if (m.role === 'assistant' && m.tool_calls) {
          const ids = m.tool_calls.map(tc => tc.id.slice(-8)).join(',')
          return `[${i}]asst(tool_calls=[...${ids}],hasContent=${m.content !== null},hasReasoning=${!!m.reasoning_content})`
        }
        if (m.role === 'tool') {
          return `[${i}]tool(id=...${m.tool_call_id.slice(-8)})`
        }
        return `[${i}]${m.role}`
      }).join(', ')
      logForDebugging(
        `[TOOL-CANCEL] messagesToOpenAI: ${result.length} msgs with tool_calls → ${summary}`,
      )
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
