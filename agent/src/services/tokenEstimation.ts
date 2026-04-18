import type { Attachment } from '../utils/attachments.js'
import { getModelBetas } from '../utils/betas.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import {
  getMidModel,
  getMainLoopModel,
  getFastModel,
  normalizeModelStringForAPI,
} from '../utils/model/model.js'
import type { MessageParam } from './api/streamTypes.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
import { getAPIMetadata } from './api/llm.js'
import { withTokenCountVCR } from './vcr.js'
import type { LLMProvider } from './api/provider.js'

// Minimal values for token counting with thinking enabled
// API constraint: max_tokens must be greater than thinking.budget_tokens
const TOKEN_COUNT_THINKING_BUDGET = 1024
const TOKEN_COUNT_MAX_TOKENS = 2048

/**
 * Check if messages contain thinking blocks
 */
function hasThinkingBlocks(
  messages: MessageParam[],
): boolean {
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking')
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Strip tool search-specific fields from messages before sending for token counting.
 * This removes 'caller' from tool_use blocks and 'tool_reference' from tool_result content.
 * These fields are only valid with the tool search beta and will cause errors otherwise.
 *
 * Note: We use 'as unknown as' casts because the SDK types don't include tool search beta fields,
 * but at runtime these fields may exist from API responses when tool search was enabled.
 */
function stripToolSearchFieldsFromMessages(
  messages: MessageParam[],
): MessageParam[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) {
      return message
    }

    const normalizedContent = message.content.map(block => {
      // Strip 'caller' from tool_use blocks (assistant messages)
      if (block.type === 'tool_use') {
        // Destructure to exclude any extra fields like 'caller'
        const toolUse =
          block as import("./api/streamTypes.js").ToolUseBlockParam & {
            caller?: unknown
          }
        return {
          type: 'tool_use' as const,
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }
      }

      // Strip tool_reference blocks from tool_result content (user messages)
      if (block.type === 'tool_result') {
        const toolResult =
          block as import("./api/streamTypes.js").ToolResultBlockParam
        if (Array.isArray(toolResult.content)) {
          const filteredContent = (toolResult.content as unknown[]).filter(
            c => !isToolReferenceBlock(c),
          ) as typeof toolResult.content

          if (filteredContent.length === 0) {
            return {
              ...toolResult,
              content: [{ type: 'text' as const, text: '[tool references]' }],
            }
          }
          if (filteredContent.length !== toolResult.content.length) {
            return {
              ...toolResult,
              content: filteredContent,
            }
          }
        }
      }

      return block
    })

    return {
      ...message,
      content: normalizedContent,
    }
  })
}

export async function countTokensWithAPI(
  content: string,
  provider: LLMProvider,
): Promise<number | null> {
  if (!content) return 0

  const message: MessageParam = { role: 'user', content }
  return countMessagesTokensWithAPI([message], [], provider)
}

export async function countMessagesTokensWithAPI(
  messages: unknown[],
  tools: unknown[],
  provider: LLMProvider,
): Promise<number | null> {
  return withTokenCountVCR(messages as any, tools as any, async () => {
    try {
      const model = getMainLoopModel()
      const containsThinking = hasThinkingBlocks(messages as MessageParam[])

      return provider.countTokens({
        model,
        messages: messages as import('./api/streamTypes.js').MessageParam[],
        tools: tools as import('./api/streamTypes.js').NeutralToolSchema[],
        thinking: containsThinking,
      })
    } catch (error) {
      logError(error)
      return null
    }
  })
}

export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * Returns an estimated bytes-per-token ratio for a given file extension.
 * Dense JSON has many single-character tokens (`{`, `}`, `:`, `,`, `"`)
 * which makes the real ratio closer to 2 rather than the default 4.
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * Like {@link roughTokenCountEstimation} but uses a more accurate
 * bytes-per-token ratio when the file type is known.
 *
 * This matters when the API-based token count is unavailable and we fall back
 * to the rough estimate — an underestimate can let an oversized tool result
 * slip into the conversation.
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

/**
 * Estimates token count for a Message object by extracting and analyzing its text content.
 * This provides a more reliable estimate than getTokenUsage for messages that may have been compacted.
 * Uses the configured fast model for token counting where provider token
 * counting is unavailable.
 */
export async function countTokensViaFastModelFallback(
  messages: unknown[],
  tools: unknown[],
): Promise<number | null> {
  const containsThinking = hasThinkingBlocks(messages as MessageParam[])
  const model = getFastModel()
  const { getProviderForModel } = await import('./api/providerRegistry.js')
  const provider = getProviderForModel(model)
  const normalizedMessages = stripToolSearchFieldsFromMessages(messages as MessageParam[])
  const messagesToSend = normalizedMessages.length > 0
    ? normalizedMessages
    : [{ role: 'user' as const, content: 'count' }]

  try {
    const response = await provider.inference({
      model,
      messages: messagesToSend as import('./api/streamTypes.js').MessageParam[],
      maxTokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      tools: (tools as import('./api/streamTypes.js').NeutralToolSchema[]).length > 0
        ? tools as import('./api/streamTypes.js').NeutralToolSchema[]
        : undefined,
      thinking: containsThinking
        ? { type: 'enabled', budgetTokens: TOKEN_COUNT_THINKING_BUDGET }
        : undefined,
      metadata: getAPIMetadata() as Record<string, unknown>,
      providerHints: {
        maxRetries: 1,
        source: 'count_tokens',
        betas: getModelBetas(model),
      },
    })
    return response.usage.inputTokens
      + (response.usage.cacheWriteTokens ?? 0)
      + (response.usage.cacheReadTokens ?? 0)
  } catch {
    return null
  }
}

export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

export function roughTokenCountEstimationForMessage(message: {
  type: string
  message?: { content?: unknown }
  attachment?: Attachment
}): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(
      message.message?.content as
        | string
        | Array<import("./api/streamTypes.js").ContentBlock>
        | Array<import("./api/streamTypes.js").ContentBlockParam>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    const userMessages = normalizeAttachmentForAPI(message.attachment)
    let total = 0
    for (const userMsg of userMessages) {
      total += roughTokenCountEstimationForContent(userMsg.message.content)
    }
    return total
  }

  return 0
}

function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<import("./api/streamTypes.js").ContentBlock>
    | Array<import("./api/streamTypes.js").ContentBlockParam>
    | Array<import('./api/streamTypes.js').ContentBlockParam>
    | Array<import('./api/streamTypes.js').ContentBlock>
    | undefined,
): number {
  if (!content) {
    return 0
  }
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  let totalTokens = 0
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block)
  }
  return totalTokens
}

function roughTokenCountEstimationForBlock(
  block: string | import("./api/streamTypes.js").ContentBlock | import("./api/streamTypes.js").ContentBlockParam | import('./api/streamTypes.js').ContentBlock | import('./api/streamTypes.js').ContentBlockParam,
): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(block)
  }
  if (block.type === 'text') {
    return roughTokenCountEstimation(block.text)
  }
  if (block.type === 'image' || block.type === 'document') {
    // Image cost calculation
    // tokens = (width px * height px)/750
    // Images are resized to max 2000x2000 (5333 tokens). Use a conservative
    // estimate that matches microCompact's IMAGE_MAX_TOKEN_SIZE to avoid
    // underestimating and triggering auto-compact too late.
    //
    // document: base64 PDF in source.data.  Must NOT reach the
    // jsonStringify catch-all — a 1MB PDF is ~1.33M base64 chars →
    // ~325k estimated tokens, vs the ~2000 the API actually charges.
    // Same constant as microCompact's calculateToolResultTokens.
    return 2000
  }
  if (block.type === 'tool_result') {
    return roughTokenCountEstimationForContent(block.content)
  }
  if (block.type === 'tool_use') {
    // input is the JSON the model generated — arbitrarily large (bash
    // commands, Edit diffs, file contents).  Stringify once for the
    // char count; the API re-serializes anyway so this is what it sees.
    return roughTokenCountEstimation(
      block.name + jsonStringify(block.input ?? {}),
    )
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data)
  }
  // server_tool_use, web_search_tool_result, mcp_tool_use, etc. —
  // text-like payloads (tool inputs, search results, no base64).
  // Stringify-length tracks the serialized form the API sees; the
  // key/bracket overhead is single-digit percent on real blocks.
  return roughTokenCountEstimation(jsonStringify(block))
}
