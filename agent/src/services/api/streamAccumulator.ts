/**
 * Protocol-neutral stream accumulator.
 * Consumes neutral StreamEvent (from any provider adapter), accumulates
 * content blocks, and yields AssistantMessage / error messages.
 *
 * Deliberately excludes provider-specific concerns: stall detection, TTFB,
 * cost calculation, research field handling.
 */
import { randomUUID } from 'crypto'
import type { Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { AssistantMessage } from '../../types/message.js'
import { normalizeToolInput } from '../../utils/api.js'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getErrorMessageIfRefusal,
} from './errors.js'
import type {
  ContentBlock,
  LLMResponse,
  StopReason,
  StreamEvent,
  TextCitation,
  Usage,
} from './streamTypes.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamAccumulatorConfig = {
  tools: Tools
  agentId?: AgentId
  model: string
  streamRequestId?: string
  maxOutputTokens: number
}

export type StreamOutput =
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'error_message'; message: AssistantMessage }
  | { type: 'stream_event'; event: StreamEvent }

/**
 * State exposed after the generator completes, so the caller can perform
 * post-stream checks (e.g. "did we receive response_start?").
 */
export type StreamAccumulatorResult = {
  hasResponseStart: boolean
  newMessages: AssistantMessage[]
  usage: Usage
  stopReason: StopReason
}

// ---------------------------------------------------------------------------
// Internal mutable block types (for accumulation)
// ---------------------------------------------------------------------------

type AccTextBlock = { type: 'text'; text: string; citations?: TextCitation[] }
type AccToolUseBlock = { type: 'tool_use'; id: string; name: string; input: string }
type AccThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
type AccServerToolUseBlock = { type: 'server_tool_use'; id: string; name: string; input: string }
type AccRedactedThinkingBlock = { type: 'redacted_thinking'; data: string }
type AccConnectorTextBlock = { type: 'connector_text'; connector_text: string }
type AccBlock = AccTextBlock | AccToolUseBlock | AccThinkingBlock | AccServerToolUseBlock | AccRedactedThinkingBlock | AccConnectorTextBlock

// ---------------------------------------------------------------------------
// processStream
// ---------------------------------------------------------------------------

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0 }

/**
 * Consumes a stream of neutral StreamEvent and yields structured outputs.
 * Protocol-agnostic — works with Anthropic, OpenAI, or any future provider.
 */
export async function* processStream(
  stream: AsyncIterable<StreamEvent>,
  config: StreamAccumulatorConfig,
): AsyncGenerator<StreamOutput, StreamAccumulatorResult> {
  const { tools, agentId, model, streamRequestId, maxOutputTokens } = config

  // Accumulator state
  let response: LLMResponse | undefined
  const blocks: (AccBlock | ContentBlock)[] = []
  let usage: Usage = { ...EMPTY_USAGE }
  let stopReason: StopReason = null
  const newMessages: AssistantMessage[] = []

  for await (const event of stream) {
    switch (event.type) {
      case 'response_start': {
        response = event.response
        usage = { ...event.response.usage }
        break
      }

      case 'block_start': {
        const block = event.block
        switch (block.type) {
          case 'text':
            blocks[event.index] = { type: 'text', text: '' }
            break
          case 'tool_use':
            // During streaming, input is accumulated as a JSON string
            blocks[event.index] = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: '',
            }
            break
          case 'thinking':
            blocks[event.index] = {
              type: 'thinking',
              thinking: '',
              signature: '',
            }
            break
          case 'server_tool_use':
            blocks[event.index] = {
              type: 'server_tool_use',
              id: block.id,
              name: block.name,
              input: '',
            }
            break
          case 'redacted_thinking':
            blocks[event.index] = {
              type: 'redacted_thinking',
              data: block.data,
            }
            break
          case 'connector_text':
            blocks[event.index] = {
              type: 'connector_text',
              connector_text: '',
            }
            break
          default:
            // Pass through unknown block types (server_tool_result, etc.)
            blocks[event.index] = block
            break
        }
        break
      }

      case 'block_delta': {
        const block = blocks[event.index]
        if (!block) {
          // Defensive: skip deltas for blocks we didn't initialize (unknown types)
          break
        }
        const delta = event.delta
        switch (delta.type) {
          case 'text':
            if (block.type === 'text') {
              block.text += delta.text
            }
            break
          case 'tool_input':
            if (block.type === 'tool_use') {
              block.input += delta.json
            } else if (block.type === 'server_tool_use') {
              block.input += delta.json
            }
            break
          case 'thinking':
            if (block.type === 'thinking') {
              block.thinking += delta.thinking
            }
            break
          case 'signature':
            if (block.type === 'thinking') {
              block.signature = delta.signature
            }
            break
          case 'citations':
            if (block.type === 'text') {
              if (!block.citations) block.citations = []
              block.citations.push(delta.citation)
            }
            break
          case 'connector_text':
            if (block.type === 'connector_text') {
              block.connector_text += delta.text
            }
            break
        }
        break
      }

      case 'block_stop': {
        const block = blocks[event.index]
        if (!block) {
          throw new RangeError(
            `Content block not found at index ${event.index}`,
          )
        }
        if (!response) {
          throw new Error('Response not found (missing response_start)')
        }

        // Finalize accumulated block: parse JSON input, apply tool-specific normalization
        const normalizedContent = [finalizeBlock(block, tools, agentId)]

        const m: AssistantMessage = {
          message: {
            id: response.id,
            type: 'message',
            role: 'assistant',
            content: normalizedContent,
            model: response.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cache_creation_input_tokens: usage.cacheWriteTokens ?? null,
              cache_read_input_tokens: usage.cacheReadTokens ?? null,
            },
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        }
        newMessages.push(m)
        yield { type: 'assistant_message', message: m }
        break
      }

      case 'response_delta': {
        stopReason = event.stopReason
        usage = {
          inputTokens: event.usage.inputTokens || usage.inputTokens,
          outputTokens: event.usage.outputTokens || usage.outputTokens,
          ...(event.usage.cacheReadTokens != null && {
            cacheReadTokens: event.usage.cacheReadTokens,
          }),
          ...(event.usage.cacheWriteTokens != null && {
            cacheWriteTokens: event.usage.cacheWriteTokens,
          }),
        }

        // Write final usage and stop_reason back to the last yielded message.
        // IMPORTANT: direct mutation — transcript write queue holds a reference.
        const lastMsg = newMessages.at(-1)
        if (lastMsg) {
          lastMsg.message.usage = {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_creation_input_tokens: usage.cacheWriteTokens ?? null,
            cache_read_input_tokens: usage.cacheReadTokens ?? null,
          }
          lastMsg.message.stop_reason = stopReason
        }

        // Refusal
        const refusalMessage = getErrorMessageIfRefusal(
          stopReason,
          model,
        )
        if (refusalMessage) {
          yield { type: 'error_message', message: refusalMessage }
        }

        // Max tokens
        if (stopReason === 'max_tokens') {
          yield {
            type: 'error_message',
            message: createAssistantAPIErrorMessage({
              content: `${API_ERROR_MESSAGE_PREFIX}: Response exceeded the ${maxOutputTokens} output token maximum. To configure this behavior, set the AXIOMATE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
              apiError: 'max_output_tokens',
              error: 'max_output_tokens',
            }),
          }
        }
        break
      }

      case 'response_stop':
        break
    }

    // Always yield the neutral event for stream_event passthrough
    yield { type: 'stream_event', event }
  }

  // Return final state for post-stream checks
  return {
    hasResponseStart: response !== undefined,
    newMessages,
    usage,
    stopReason,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finalize an accumulated block into a content block for AssistantMessage.
 * Protocol-neutral: parses JSON tool input (both Anthropic and OpenAI accumulate
 * tool arguments as JSON strings), applies tool-specific input normalization.
 */
function finalizeBlock(block: AccBlock | ContentBlock, tools: Tools, agentId?: AgentId): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, ...(block.citations ? { citations: block.citations } : {}) }
    case 'tool_use': {
      // Parse accumulated JSON string → object
      let input: unknown = typeof block.input === 'object' ? block.input : {}
      const accumulatedInputText =
        typeof block.input === 'string' ? block.input : ''
      // Always preserve the raw text for schema repair; repair uses it both when
      // JSON.parse fails and when the parsed shape doesn't match the tool schema.
      const unparsedInput: string | undefined =
        accumulatedInputText.length > 0 ? accumulatedInputText : undefined
      if (accumulatedInputText.length > 0) {
        try {
          input = JSON.parse(accumulatedInputText)
        } catch {
          input = {}
        }
      }
      // Apply tool-specific input corrections (e.g., type coercion)
      if (typeof input === 'object' && input !== null) {
        const tool = findToolByName(tools, block.name)
        if (tool) {
          try {
            input = normalizeToolInput(
              tool,
              input as { [key: string]: unknown },
              agentId,
            )
          } catch {
            // Keep original input if normalization fails
          }
        }
      }
      const finalizedBlock: ContentBlock = {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: input as Record<string, unknown>,
        ...(unparsedInput ? { unparsedInput } : {}),
      }
      return finalizedBlock
    }
    case 'server_tool_use': {
      // Same JSON parsing as tool_use, but no tool-specific normalization
      let input: unknown = typeof block.input === 'object' ? block.input : {}
      const rawServerInput = typeof block.input === 'string' ? block.input : ''
      if (rawServerInput.length > 0) {
        try { input = JSON.parse(rawServerInput) } catch { input = {} }
      }
      return { type: 'server_tool_use', id: block.id, name: block.name, input: input as Record<string, unknown> }
    }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      }
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data }
    case 'connector_text':
      return { type: 'connector_text', connector_text: block.connector_text } as ContentBlock
    default:
      // Pass-through for unknown block types
      return block as ContentBlock
  }
}
