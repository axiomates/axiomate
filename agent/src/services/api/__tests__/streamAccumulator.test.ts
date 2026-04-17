import { describe, it, expect, vi } from 'vitest'

// Mock heavy dependencies
vi.mock('../../../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))
vi.mock('../../../services/analytics/metadata.js', () => ({
  sanitizeToolNameForAnalytics: vi.fn((n: string) => n),
}))
vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
  logDevError: vi.fn(),
}))
vi.mock('../../../utils/log.js', () => ({
  logError: vi.fn(),
  logMCPDebug: vi.fn(),
}))
vi.mock('../../../utils/api.js', () => ({
  normalizeToolInput: vi.fn(
    (_tool: unknown, input: Record<string, unknown>) => input,
  ),
}))
vi.mock('../../../Tool.js', () => ({
  findToolByName: vi.fn(() => undefined),
}))
vi.mock('../errors.js', () => ({
  API_ERROR_MESSAGE_PREFIX: 'API Error',
  getErrorMessageIfRefusal: vi.fn(() => undefined),
}))
vi.mock('../../../utils/messages.js', () => ({
  createAssistantAPIErrorMessage: vi.fn(
    ({ content, apiError, error }: any) => ({
      type: 'assistant' as const,
      message: {
        id: 'err_msg',
        type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: content, citations: null }],
        model: 'test',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      uuid: 'err-uuid',
      timestamp: '2025-01-01T00:00:00.000Z',
      isApiErrorMessage: true,
      apiError,
      error,
    }),
  ),
}))

import {
  processStream,
  type StreamAccumulatorConfig,
  type StreamOutput,
} from '../streamAccumulator.js'
import type { StreamEvent, Usage } from '../streamTypes.js'

// ---------------------------------------------------------------------------
// Test helpers — now using neutral StreamEvent types
// ---------------------------------------------------------------------------

function responseStart(
  overrides: { id?: string; model?: string; usage?: Partial<Usage> } = {},
): StreamEvent {
  return {
    type: 'response_start',
    response: {
      id: overrides.id ?? 'msg_test',
      model: overrides.model ?? 'provider-main-model',
      stopReason: null,
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        ...overrides.usage,
      },
    },
  }
}

function blockStart(
  index: number,
  block: { type: 'text' } | { type: 'tool_use'; id: string; name: string } | { type: 'thinking' },
): StreamEvent {
  switch (block.type) {
    case 'text':
      return { type: 'block_start', index, block: { type: 'text', text: '' } }
    case 'tool_use':
      return {
        type: 'block_start',
        index,
        block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      }
    case 'thinking':
      return {
        type: 'block_start',
        index,
        block: { type: 'thinking', thinking: '', signature: '' },
      }
  }
}

function textDelta(index: number, text: string): StreamEvent {
  return { type: 'block_delta', index, delta: { type: 'text', text } }
}

function toolInputDelta(index: number, json: string): StreamEvent {
  return { type: 'block_delta', index, delta: { type: 'tool_input', json } }
}

function thinkingDelta(index: number, thinking: string): StreamEvent {
  return { type: 'block_delta', index, delta: { type: 'thinking', thinking } }
}

function signatureDelta(index: number, signature: string): StreamEvent {
  return { type: 'block_delta', index, delta: { type: 'signature', signature } }
}

function blockStop(index: number): StreamEvent {
  return { type: 'block_stop', index }
}

function responseDelta(
  stopReason: string | null,
  usage: Partial<Usage> = {},
): StreamEvent {
  return {
    type: 'response_delta',
    stopReason: stopReason as any,
    usage: { inputTokens: 0, outputTokens: 0, ...usage },
  }
}

function responseStop(): StreamEvent {
  return { type: 'response_stop' }
}

async function* mockStream(
  events: StreamEvent[],
): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e
}

async function collectOutputs(
  stream: AsyncIterable<StreamEvent>,
  config: Partial<StreamAccumulatorConfig> = {},
) {
  const fullConfig: StreamAccumulatorConfig = {
    tools: [] as any,
    model: 'provider-main-model',
    maxOutputTokens: 16384,
    ...config,
  }
  const gen = processStream(stream, fullConfig)
  const outputs: StreamOutput[] = []
  let result: any

  while (true) {
    const next = await gen.next()
    if (next.done) {
      result = next.value
      break
    }
    outputs.push(next.value as StreamOutput)
  }
  return { outputs, result }
}

function assistantMessages(outputs: StreamOutput[]) {
  return outputs.filter(o => o.type === 'assistant_message')
}

function errorMessages(outputs: StreamOutput[]) {
  return outputs.filter(o => o.type === 'error_message')
}

function streamEvents(outputs: StreamOutput[]) {
  return outputs.filter(o => o.type === 'stream_event')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processStream (neutral)', () => {
  describe('scenario 1: pure text response', () => {
    it('accumulates text deltas into a single AssistantMessage', async () => {
      const events: StreamEvent[] = [
        responseStart(),
        blockStart(0, { type: 'text' }),
        textDelta(0, 'hello'),
        textDelta(0, ' world'),
        blockStop(0),
        responseDelta('end_turn', { outputTokens: 10 }),
        responseStop(),
      ]

      const { outputs, result } = await collectOutputs(mockStream(events))
      const msgs = assistantMessages(outputs)

      expect(msgs).toHaveLength(1)
      const msg = msgs[0].message
      expect(msg.message.content).toHaveLength(1)
      expect(msg.message.content[0]).toMatchObject({
        type: 'text',
        text: 'hello world',
      })
      expect(msg.message.stop_reason).toBe('end_turn')
      expect(result.stopReason).toBe('end_turn')
      expect(result.newMessages).toHaveLength(1)
    })
  })

  describe('scenario 2: single tool call', () => {
    it('accumulates JSON deltas and parses tool input', async () => {
      const events: StreamEvent[] = [
        responseStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_01', name: 'Read' }),
        toolInputDelta(0, '{"pa'),
        toolInputDelta(0, 'th":"/a"}'),
        blockStop(0),
        responseDelta('tool_use', { outputTokens: 20 }),
        responseStop(),
      ]

      const { outputs, result } = await collectOutputs(mockStream(events))
      const msgs = assistantMessages(outputs)

      expect(msgs).toHaveLength(1)
      const content = msgs[0].message.message.content[0]
      expect(content).toMatchObject({
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Read',
        input: { path: '/a' },
      })
      expect(result.stopReason).toBe('tool_use')
    })
  })

  describe('scenario 3: text + tool call', () => {
    it('yields two AssistantMessages (one per block_stop)', async () => {
      const events: StreamEvent[] = [
        responseStart(),
        blockStart(0, { type: 'text' }),
        textDelta(0, 'Let me read that.'),
        blockStop(0),
        blockStart(1, { type: 'tool_use', id: 'toolu_02', name: 'Read' }),
        toolInputDelta(1, '{"path":"/b"}'),
        blockStop(1),
        responseDelta('tool_use', { outputTokens: 30 }),
        responseStop(),
      ]

      const { outputs } = await collectOutputs(mockStream(events))
      const msgs = assistantMessages(outputs)

      expect(msgs).toHaveLength(2)
      expect(msgs[0].message.message.content[0]).toMatchObject({
        type: 'text',
        text: 'Let me read that.',
      })
      expect(msgs[1].message.message.content[0]).toMatchObject({
        type: 'tool_use',
        name: 'Read',
        input: { path: '/b' },
      })
    })
  })

  describe('scenario 4: thinking + text', () => {
    it('yields thinking block then text block', async () => {
      const events: StreamEvent[] = [
        responseStart(),
        blockStart(0, { type: 'thinking' }),
        thinkingDelta(0, 'I need to think about this...'),
        signatureDelta(0, 'sig123'),
        blockStop(0),
        blockStart(1, { type: 'text' }),
        textDelta(1, 'Here is my answer.'),
        blockStop(1),
        responseDelta('end_turn', { outputTokens: 40 }),
        responseStop(),
      ]

      const { outputs } = await collectOutputs(mockStream(events))
      const msgs = assistantMessages(outputs)

      expect(msgs).toHaveLength(2)
      expect(msgs[0].message.message.content[0]).toMatchObject({
        type: 'thinking',
        thinking: 'I need to think about this...',
        signature: 'sig123',
      })
      expect(msgs[1].message.message.content[0]).toMatchObject({
        type: 'text',
        text: 'Here is my answer.',
      })
    })
  })

  describe('scenario 5: max_tokens truncation', () => {
    it('yields assistant message + error message', async () => {
      const events: StreamEvent[] = [
        responseStart(),
        blockStart(0, { type: 'text' }),
        textDelta(0, 'partial response...'),
        blockStop(0),
        responseDelta('max_tokens', { outputTokens: 16384 }),
        responseStop(),
      ]

      const { outputs } = await collectOutputs(mockStream(events))
      const msgs = assistantMessages(outputs)
      const errs = errorMessages(outputs)

      expect(msgs).toHaveLength(1)
      expect(errs).toHaveLength(1)
      expect(errs[0].message.message.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('exceeded'),
      })
    })
  })

  describe('scenario 6: multiple parallel tool calls', () => {
    it('handles interleaved block events for two tools', async () => {
      const events: StreamEvent[] = [
        responseStart(),
        blockStart(0, { type: 'tool_use', id: 'toolu_a', name: 'Read' }),
        blockStart(1, { type: 'tool_use', id: 'toolu_b', name: 'Grep' }),
        toolInputDelta(0, '{"path":"/x"}'),
        toolInputDelta(1, '{"pattern":"foo"}'),
        blockStop(0),
        blockStop(1),
        responseDelta('tool_use', { outputTokens: 50 }),
        responseStop(),
      ]

      const { outputs } = await collectOutputs(mockStream(events))
      const msgs = assistantMessages(outputs)

      expect(msgs).toHaveLength(2)
      expect(msgs[0].message.message.content[0]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_a',
        name: 'Read',
      })
      expect(msgs[1].message.message.content[0]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_b',
        name: 'Grep',
      })
    })
  })

  describe('scenario 7: empty stream', () => {
    it('yields nothing and returns no response_start', async () => {
      const { outputs, result } = await collectOutputs(mockStream([]))
      expect(assistantMessages(outputs)).toHaveLength(0)
      expect(result.hasResponseStart).toBe(false)
      expect(result.newMessages).toHaveLength(0)
    })
  })

  describe('stream_event passthrough', () => {
    it('yields a stream_event for every input event', async () => {
      const events: StreamEvent[] = [
        responseStart(),
        blockStart(0, { type: 'text' }),
        textDelta(0, 'hi'),
        blockStop(0),
        responseDelta('end_turn', { outputTokens: 1 }),
        responseStop(),
      ]

      const { outputs } = await collectOutputs(mockStream(events))
      const se = streamEvents(outputs)
      expect(se).toHaveLength(events.length)
    })
  })

  describe('usage accumulation', () => {
    it('updates usage from response_start and response_delta', async () => {
      const events: StreamEvent[] = [
        responseStart({ usage: { inputTokens: 100, outputTokens: 0 } }),
        blockStart(0, { type: 'text' }),
        textDelta(0, 'ok'),
        blockStop(0),
        responseDelta('end_turn', { outputTokens: 25 }),
        responseStop(),
      ]

      const { result } = await collectOutputs(mockStream(events))
      expect(result.usage.inputTokens).toBe(100)
      expect(result.usage.outputTokens).toBe(25)
    })
  })
})
