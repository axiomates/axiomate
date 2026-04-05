/**
 * Protocol-neutral stream accumulator.
 * Consumes neutral StreamEvent (from any provider adapter), accumulates
 * content blocks, and yields AssistantMessage / error messages.
 *
 * Deliberately excludes provider-specific concerns: stall detection, TTFB,
 * cost calculation, research field handling, advisor state tracking.
 */
import { randomUUID } from 'crypto'
import { logEvent } from '../../services/analytics/index.js'
import type { Tools } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { AssistantMessage } from '../../types/message.js'
import { normalizeContentFromAPI } from '../../utils/contentNormalization.js'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getErrorMessageIfRefusal,
} from './errors.js'
import type {
  LLMResponse,
  StopReason,
  StreamEvent,
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

type AccTextBlock = { type: 'text'; text: string }
type AccToolUseBlock = { type: 'tool_use'; id: string; name: string; input: string }
type AccThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
type AccBlock = AccTextBlock | AccToolUseBlock | AccThinkingBlock

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
  const blocks: AccBlock[] = []
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
        }
        break
      }

      case 'block_delta': {
        const block = blocks[event.index]
        if (!block) {
          throw new RangeError(
            `Content block not found at index ${event.index}`,
          )
        }
        const delta = event.delta
        switch (delta.type) {
          case 'text':
            if (block.type !== 'text') {
              throw new Error('Delta type mismatch: expected text block')
            }
            block.text += delta.text
            break
          case 'tool_input':
            if (block.type !== 'tool_use') {
              throw new Error('Delta type mismatch: expected tool_use block')
            }
            block.input += delta.json
            break
          case 'thinking':
            if (block.type !== 'thinking') {
              throw new Error('Delta type mismatch: expected thinking block')
            }
            block.thinking += delta.thinking
            break
          case 'signature':
            if (block.type !== 'thinking') {
              throw new Error('Delta type mismatch: expected thinking block')
            }
            block.signature = delta.signature
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

        // Convert accumulated block to the format normalizeContentFromAPI expects
        const rawBlock = accBlockToApiBlock(block)
        const normalizedContent = normalizeContentFromAPI(
          [rawBlock] as any,
          tools,
          agentId,
        )

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
          lastMsg.message.stop_reason = mapStopReasonToApi(stopReason)
        }

        // Refusal
        const refusalMessage = getErrorMessageIfRefusal(
          mapStopReasonToApi(stopReason),
          model,
        )
        if (refusalMessage) {
          yield { type: 'error_message', message: refusalMessage }
        }

        // Max tokens
        if (stopReason === 'max_tokens') {
          logEvent('tengu_max_tokens_reached', {
            max_tokens: maxOutputTokens,
          })
          yield {
            type: 'error_message',
            message: createAssistantAPIErrorMessage({
              content: `${API_ERROR_MESSAGE_PREFIX}: Response exceeded the ${maxOutputTokens} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
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
 * Converts an accumulated block back to BetaContentBlock-like shape
 * for normalizeContentFromAPI (which handles JSON parsing of tool input).
 */
function accBlockToApiBlock(block: AccBlock): any {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, citations: null }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input, // string — normalizeContentFromAPI will JSON.parse it
      }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      }
  }
}

/**
 * Maps neutral StopReason back to Anthropic BetaStopReason for
 * compatibility with existing AssistantMessage.message.stop_reason type.
 */
function mapStopReasonToApi(reason: StopReason): any {
  return reason // same string values, just different type aliases
}
