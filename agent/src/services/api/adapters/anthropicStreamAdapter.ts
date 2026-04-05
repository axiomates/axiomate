/**
 * Converts Anthropic BetaRawMessageStreamEvent stream to neutral StreamEvent stream.
 */
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaRawMessageStreamEvent,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  BlockDelta,
  ContentBlock,
  LLMResponse,
  StopReason,
  StreamEvent,
  Usage,
} from '../streamTypes.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adapts an Anthropic raw SSE stream into neutral StreamEvent.
 * Optionally calls `onRawEvent` for each raw event before conversion,
 * allowing the caller to perform provider-specific side effects
 * (stall detection, TTFB recording, research capture, etc.)
 */
export async function* anthropicStreamAdapter(
  stream: AsyncIterable<BetaRawMessageStreamEvent>,
  onRawEvent?: (raw: BetaRawMessageStreamEvent) => void,
): AsyncGenerator<StreamEvent> {
  for await (const raw of stream) {
    onRawEvent?.(raw)
    const neutral = convertToNeutral(raw)
    if (neutral) {
      yield neutral
    }
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function convertToNeutral(
  event: BetaRawMessageStreamEvent,
): StreamEvent | null {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'response_start',
        response: mapResponse(event.message),
      }

    case 'content_block_start':
      return {
        type: 'block_start',
        index: event.index,
        block: mapContentBlock(event.content_block),
      }

    case 'content_block_delta': {
      const delta = mapDelta(event.delta)
      if (!delta) return null // unknown delta type (e.g. citations_delta)
      return {
        type: 'block_delta',
        index: event.index,
        delta,
      }
    }

    case 'content_block_stop':
      return {
        type: 'block_stop',
        index: event.index,
      }

    case 'message_delta':
      return {
        type: 'response_delta',
        stopReason: mapStopReason(event.delta.stop_reason),
        usage: mapDeltaUsage(event.usage),
      }

    case 'message_stop':
      return { type: 'response_stop' }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Mappers (exported for testing)
// ---------------------------------------------------------------------------

export function mapStopReason(reason: BetaStopReason | null): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case null:
      return null
    default:
      // stop_sequence, refusal, model_context_window_exceeded etc.
      // Pass through as-is — StopReason union will catch unknown values at compile time
      // For runtime, treat as end_turn (safest default)
      return reason as StopReason
  }
}

export function mapContentBlock(block: BetaContentBlock | any): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text ?? '' }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: typeof block.input === 'object' && block.input !== null
          ? block.input
          : {},
      }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking ?? '',
        signature: block.signature,
      }
    default:
      // server_tool_use, redacted_thinking, etc. → map to text placeholder
      // These are Anthropic-specific; the neutral layer doesn't model them.
      return { type: 'text', text: '' }
  }
}

export function mapDelta(delta: any): BlockDelta | null {
  switch (delta.type) {
    case 'text_delta':
      return { type: 'text', text: delta.text }
    case 'input_json_delta':
      return { type: 'tool_input', json: delta.partial_json }
    case 'thinking_delta':
      return { type: 'thinking', thinking: delta.thinking }
    case 'signature_delta':
      return { type: 'signature', signature: delta.signature }
    case 'citations_delta':
    case 'connector_text_delta':
      // Not modeled in neutral types (yet)
      return null
    default:
      return null
  }
}

export function mapUsage(usage: BetaMessage['usage']): Usage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens != null && {
      cacheReadTokens: usage.cache_read_input_tokens,
    }),
    ...(usage?.cache_creation_input_tokens != null && {
      cacheWriteTokens: usage.cache_creation_input_tokens,
    }),
  }
}

export function mapDeltaUsage(usage: BetaMessageDeltaUsage): Usage {
  return {
    inputTokens: (usage as any).input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  }
}

export function mapResponse(message: BetaMessage): LLMResponse {
  return {
    id: message.id,
    model: message.model,
    stopReason: mapStopReason(message.stop_reason),
    usage: mapUsage(message.usage),
  }
}
