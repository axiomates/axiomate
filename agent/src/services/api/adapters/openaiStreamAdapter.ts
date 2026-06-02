/**
 * OpenAI SSE stream → neutral StreamEvent conversion.
 *
 * Converts OpenAI chat.completions.create({ stream: true }) SSE chunks
 * into the protocol-neutral StreamEvent type consumed by processStream().
 */
import type {
  ContentBlock,
  StreamEvent,
  BlockDelta,
  Usage,
  StopReason,
} from '../streamTypes.js'
import { LLMAPIError } from '../streamTypes.js'
import { mapFinishReason } from './openaiRequestAdapter.js'
import type { ModelProviderUsageMapping } from '../../../utils/config.js'
import { mapOpenAIUsage } from './openaiUsageMapper.js'
import { summarizeUnexpectedResponse } from '../errors.js'

// ---------------------------------------------------------------------------
// OpenAI chunk shape (subset of openai SDK types we actually use)
// ---------------------------------------------------------------------------

/** Minimal typing for an OpenAI streaming chunk. Works with any OpenAI-compatible service. */
export type OpenAIChatChunk = {
  id: string
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | OpenAIChatContentPart[] | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
      /** Some providers (DeepSeek, Qwen) put thinking in reasoning_content */
      reasoning_content?: string | null
    }
    finish_reason: string | null
  }>
  usage?: (Record<string, unknown> & {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }) | null
}

type OpenAIChatContentPart =
  | { type: 'text'; text?: string | null }
  | { type: 'thinking'; thinking?: string | null }
  | { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Adapter state — tracks block indices across chunks
// ---------------------------------------------------------------------------

export class OpenAIStreamState {
  /** Current text block index (content deltas) */
  private textBlockIndex = -1
  /** Whether we've started a text block */
  private hasTextBlock = false
  /** Current thinking block index (reasoning_content deltas) */
  private thinkingBlockIndex = -1
  private hasThinkingBlock = false
  /** Tool call blocks: openai tool_call index → our block index */
  private toolBlockIndices = new Map<number, number>()
  /** Buffered tool call metadata for tool calls whose id/name arrived late */
  private pendingToolCalls = new Map<number, { id?: string; name?: string; argChunks: string[] }>()
  /** Next available block index */
  private nextIndex = 0
  /** Accumulated usage from final chunk */
  usage: Usage = { inputTokens: 0, outputTokens: 0 }
  /** Response ID from first chunk */
  responseId = ''
  /** Model from first chunk */
  model = ''
  /** Whether response_start has been emitted */
  private responseStarted = false
  /** Stop reason from finish_reason chunk, needed for usage-only supplemental event */
  private lastStopReason: StopReason = null

  constructor(private readonly usageMapping?: ModelProviderUsageMapping) {}

  /**
   * Convert one OpenAI SSE chunk into zero or more neutral StreamEvents.
   */
  mapChunk(chunk: OpenAIChatChunk): StreamEvent[] {
    const events: StreamEvent[] = []

    // Some OpenAI-compatible providers (proxies, Chinese vendors) occasionally
    // emit chunks missing `choices` entirely — defend so we don't crash with
    // a TypeError that the error harness can't classify.
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : []

    // Inline error envelope (e.g. proxy injecting {"error":{"message":"..."}}
    // mid-stream). Surface as LLMAPIError so withRetry's classifyError can
    // route it through the standard retry/failover paths.
    const inlineError = (chunk as { error?: unknown })?.error
    if (inlineError && typeof inlineError === 'object') {
      throw new LLMAPIError(
        `Provider streamed inline error: ${summarizeUnexpectedResponse(chunk)}`,
        { status: 502 },
      )
    }

    if (!this.responseStarted) {
      this.responseId = chunk.id || `openai-${Date.now()}`
      this.model = chunk.model || 'unknown'
      this.responseStarted = true
      events.push({
        type: 'response_start',
        response: {
          id: this.responseId,
          model: this.model,
          stopReason: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      })
    }

    for (const choice of choices) {
      // Only process first choice — we never request n > 1
      if (choice.index !== 0) continue
      const delta = choice.delta ?? {}

      // --- Thinking (reasoning_content) ---
      const hasReasoningContent =
        typeof delta.reasoning_content === 'string' &&
        delta.reasoning_content.length > 0
      if (hasReasoningContent) {
        this.appendThinking(events, delta.reasoning_content)
      }

      // --- Text content ---
      const content = delta.content
      if (typeof content === 'string') {
        this.appendText(events, content)
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            !hasReasoningContent &&
            part.type === 'thinking' &&
            typeof part.thinking === 'string'
          ) {
            this.appendThinking(events, part.thinking)
          } else if (part.type === 'text' && typeof part.text === 'string') {
            this.appendText(events, part.text)
          }
        }
      }

      // --- Tool calls ---
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let blockIdx = this.toolBlockIndices.get(tc.index)

          if (blockIdx === undefined) {
            // Block not yet initialized — accumulate metadata until id + name are both available
            let pending = this.pendingToolCalls.get(tc.index)
            if (!pending) {
              pending = { argChunks: [] }
              this.pendingToolCalls.set(tc.index, pending)
            }
            if (tc.id) pending.id = tc.id
            if (tc.function?.name) pending.name = tc.function.name
            if (tc.function?.arguments) pending.argChunks.push(tc.function.arguments)

            // Once we have both id and name, emit block_start + any buffered argument deltas
            if (pending.id && pending.name) {
              blockIdx = this.nextIndex++
              this.toolBlockIndices.set(tc.index, blockIdx)
              this.pendingToolCalls.delete(tc.index)
              // Close open blocks before starting tool
              this.closeThinking(events)
              this.closeText(events)
              const block: ContentBlock = {
                type: 'tool_use',
                id: pending.id,
                name: pending.name,
                input: {},
              }
              events.push({ type: 'block_start', index: blockIdx, block })
              // Flush buffered argument chunks
              for (const arg of pending.argChunks) {
                events.push({ type: 'block_delta', index: blockIdx, delta: { type: 'tool_input', json: arg } })
              }
            }
          } else if (tc.function?.arguments) {
            // Block already initialized — emit argument delta directly
            const inputDelta: BlockDelta = { type: 'tool_input', json: tc.function.arguments }
            events.push({ type: 'block_delta', index: blockIdx, delta: inputDelta })
          }
        }
      }

      // --- Finish reason ---
      if (choice.finish_reason) {
        // Close any open blocks and clear flags (so flush() won't duplicate)
        this.closeThinking(events)
        this.closeText(events)
        for (const [, idx] of this.toolBlockIndices) {
          events.push({ type: 'block_stop', index: idx })
        }

        // Clear the tool index map after emitting block_stops, mirroring
        // the thinking/text flag pattern above. Without this, flush() (which
        // runs when the SDK iterator returns done=true after [DONE]) iterates
        // the still-populated map and emits a SECOND block_stop per tool
        // block. The streamAccumulator turns each block_stop into its own
        // AssistantMessage, and normalizeMessagesForAPI merges by message.id
        // — collapsing the two into one assistant message with the same
        // tool_use entry repeated, which dispatch then executes twice.
        this.toolBlockIndices.clear()

        // Extract usage if present in this chunk (SiliconFlow sends it with finish_reason)
        if (chunk.usage) {
          this.usage = mapOpenAIUsage(chunk, this.usageMapping)
        }

        const stopReason: StopReason = mapFinishReason(choice.finish_reason)
        this.lastStopReason = stopReason
        events.push({
          type: 'response_delta',
          stopReason,
          usage: this.usage,
        })
        events.push({ type: 'response_stop' })
      }
    }

    // Handle usage-only chunks: OpenAI sends a final chunk with choices: []
    // and usage data AFTER the finish_reason chunk. Extract usage and emit
    // a supplemental response_delta so processStream updates the message usage.
    // Use stopReason from the earlier finish_reason chunk (already stored in this.usage
    // path) — we must NOT send null here as processStream would overwrite the real value.
    if (choices.length === 0 && chunk.usage) {
      const prevUsage = this.usage
      const mappedUsage = mapOpenAIUsage(chunk, this.usageMapping)
      this.usage = {
        inputTokens: mappedUsage.inputTokens || prevUsage.inputTokens,
        outputTokens: mappedUsage.outputTokens || prevUsage.outputTokens,
        ...((mappedUsage.cacheReadTokens ?? prevUsage.cacheReadTokens) != null
          ? {
              cacheReadTokens:
                mappedUsage.cacheReadTokens ?? prevUsage.cacheReadTokens,
            }
          : {}),
        ...((mappedUsage.cacheWriteTokens ?? prevUsage.cacheWriteTokens) != null
          ? {
              cacheWriteTokens:
                mappedUsage.cacheWriteTokens ?? prevUsage.cacheWriteTokens,
            }
          : {}),
      }
      // Only emit if usage actually has data (avoid no-op response_delta)
      if (this.usage.inputTokens > 0 || this.usage.outputTokens > 0) {
        events.push({
          type: 'response_delta',
          stopReason: this.lastStopReason ?? 'end_turn',
          usage: this.usage,
        })
      }
    }

    return events
  }

  /**
   * Flush unclosed blocks on stream end.
   * Called when the SDK iterator returns done=true (normal end or network error).
   * Ensures all block_start events have matching block_stop events.
   */
  flush(): StreamEvent[] {
    const events: StreamEvent[] = []
    this.closeThinking(events)
    this.closeText(events)
    for (const [, idx] of this.toolBlockIndices) {
      events.push({ type: 'block_stop', index: idx })
    }
    this.toolBlockIndices.clear()
    // Emit response_delta + response_stop if not already sent (no finish_reason received)
    if (this.lastStopReason === null && this.responseStarted && events.length > 0) {
      events.push({
        type: 'response_delta',
        stopReason: 'end_turn',
        usage: this.usage,
      })
      events.push({ type: 'response_stop' })
    }
    return events
  }

  private appendThinking(events: StreamEvent[], thinking: string): void {
    if (thinking.length === 0) return
    if (!this.hasThinkingBlock) {
      this.closeText(events)
      this.hasThinkingBlock = true
      this.thinkingBlockIndex = this.nextIndex++
      const block: ContentBlock = {
        type: 'thinking',
        thinking: '',
        roundTrip: { provider: 'none' },
      }
      events.push({ type: 'block_start', index: this.thinkingBlockIndex, block })
    }
    const thinkingDelta: BlockDelta = { type: 'thinking', thinking }
    events.push({ type: 'block_delta', index: this.thinkingBlockIndex, delta: thinkingDelta })
  }

  private appendText(events: StreamEvent[], text: string): void {
    if (text.length === 0) return
    if (!this.hasTextBlock) {
      this.closeThinking(events)
      this.hasTextBlock = true
      this.textBlockIndex = this.nextIndex++
      const block: ContentBlock = { type: 'text', text: '' }
      events.push({ type: 'block_start', index: this.textBlockIndex, block })
    }
    const textDelta: BlockDelta = { type: 'text', text }
    events.push({ type: 'block_delta', index: this.textBlockIndex, delta: textDelta })
  }

  private closeThinking(events: StreamEvent[]): void {
    if (!this.hasThinkingBlock) return
    events.push({ type: 'block_stop', index: this.thinkingBlockIndex })
    this.hasThinkingBlock = false
  }

  private closeText(events: StreamEvent[]): void {
    if (!this.hasTextBlock) return
    events.push({ type: 'block_stop', index: this.textBlockIndex })
    this.hasTextBlock = false
  }
}
