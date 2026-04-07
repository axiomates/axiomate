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
import { mapFinishReason } from './openaiRequestAdapter.js'

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
      content?: string | null
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
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  } | null
}

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

  /**
   * Convert one OpenAI SSE chunk into zero or more neutral StreamEvents.
   */
  mapChunk(chunk: OpenAIChatChunk): StreamEvent[] {
    const events: StreamEvent[] = []

    if (!this.responseStarted) {
      this.responseId = chunk.id
      this.model = chunk.model
      this.responseStarted = true
      events.push({
        type: 'response_start',
        response: {
          id: chunk.id,
          model: chunk.model,
          stopReason: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      })
    }

    for (const choice of chunk.choices) {
      const delta = choice.delta

      // --- Thinking (reasoning_content) ---
      if (delta.reasoning_content) {
        if (!this.hasThinkingBlock) {
          this.hasThinkingBlock = true
          this.thinkingBlockIndex = this.nextIndex++
          const block: ContentBlock = {
            type: 'thinking',
            thinking: '',
            signature: '',
          }
          events.push({ type: 'block_start', index: this.thinkingBlockIndex, block })
        }
        const thinkingDelta: BlockDelta = { type: 'thinking', thinking: delta.reasoning_content }
        events.push({ type: 'block_delta', index: this.thinkingBlockIndex, delta: thinkingDelta })
      }

      // --- Text content ---
      if (delta.content) {
        if (!this.hasTextBlock) {
          this.hasTextBlock = true
          this.textBlockIndex = this.nextIndex++
          // Close thinking block before starting text
          if (this.hasThinkingBlock) {
            events.push({ type: 'block_stop', index: this.thinkingBlockIndex })
          }
          const block: ContentBlock = { type: 'text', text: '' }
          events.push({ type: 'block_start', index: this.textBlockIndex, block })
        }
        const textDelta: BlockDelta = { type: 'text', text: delta.content }
        events.push({ type: 'block_delta', index: this.textBlockIndex, delta: textDelta })
      }

      // --- Tool calls ---
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let blockIdx = this.toolBlockIndices.get(tc.index)

          if (blockIdx === undefined && tc.id && tc.function?.name) {
            // New tool call — emit block_start
            blockIdx = this.nextIndex++
            this.toolBlockIndices.set(tc.index, blockIdx)
            // Close text block before starting tool
            if (this.hasTextBlock) {
              events.push({ type: 'block_stop', index: this.textBlockIndex })
              this.hasTextBlock = false
            }
            const block: ContentBlock = {
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: {},
            }
            events.push({ type: 'block_start', index: blockIdx, block })
          }

          if (blockIdx !== undefined && tc.function?.arguments) {
            // Tool input delta
            const inputDelta: BlockDelta = { type: 'tool_input', json: tc.function.arguments }
            events.push({ type: 'block_delta', index: blockIdx, delta: inputDelta })
          }
        }
      }

      // --- Finish reason ---
      if (choice.finish_reason) {
        // Close any open blocks
        if (this.hasTextBlock) {
          events.push({ type: 'block_stop', index: this.textBlockIndex })
        }
        for (const [, idx] of this.toolBlockIndices) {
          events.push({ type: 'block_stop', index: idx })
        }

        // Usage from the final chunk (if stream_options: { include_usage: true })
        if (chunk.usage) {
          this.usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          }
        }

        const stopReason: StopReason = mapFinishReason(choice.finish_reason)
        events.push({
          type: 'response_delta',
          stopReason,
          usage: this.usage,
        })
        events.push({ type: 'response_stop' })
      }
    }

    return events
  }
}
