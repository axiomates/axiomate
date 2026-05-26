import { describe, it, expect } from 'vitest'
import {
  messagesToOpenAIResponsesInput,
  toolsToOpenAIResponses,
  toolChoiceToOpenAIResponses,
} from '../../../../services/api/adapters/openaiResponsesRequestAdapter.js'
import type { MessageParam } from '../../../../services/api/streamTypes.js'

describe('messagesToOpenAIResponsesInput', () => {
  it('user text → message item with input_text content', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Hello world' },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ role: 'user', content: 'Hello world' })
  })

  it('user complex content: text + image → single message item with content parts', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo',
            },
          },
        ],
      },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toHaveLength(2)
    expect(out[0].content[0]).toEqual({ type: 'input_text', text: 'Look at this' })
    expect(out[0].content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,iVBORw0KGgo',
      detail: 'auto',
    })
  })

  it('tool_result with text → function_call_output item', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_abc',
            content: 'tool said hi',
          },
        ],
      },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      type: 'function_call_output',
      call_id: 'call_abc',
      output: 'tool said hi',
    })
  })

  it('tool_result with is_error → output prefixed with Error:', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_abc',
            content: 'permission denied',
            is_error: true,
          },
        ],
      },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out[0].output).toBe('Error: permission denied')
  })

  it('tool_result with image → function_call_output placeholder + follow-up user message with image', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_screenshot',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'PNG_DATA',
                },
              },
            ],
          },
        ],
      },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      type: 'function_call_output',
      call_id: 'call_screenshot',
      output: '[image attached, see next message]',
    })
    expect(out[1].role).toBe('user')
    expect(out[1].content[0]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,PNG_DATA',
      detail: 'auto',
    })
  })

  it('assistant thinking with openai-responses roundTrip → reasoning input item', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Let me reason about this',
            roundTrip: {
              provider: 'openai-responses',
              id: 'rs_123',
              encryptedContent: 'enc_xyz',
              summaryParts: ['Step 1.', 'Step 2.'],
            },
          },
          { type: 'tool_use', id: 'call_1', name: 'foo', input: { x: 1 } },
        ],
      },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      type: 'reasoning',
      id: 'rs_123',
      summary: [
        { type: 'summary_text', text: 'Step 1.' },
        { type: 'summary_text', text: 'Step 2.' },
      ],
      encrypted_content: 'enc_xyz',
    })
    expect(out[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'foo',
      arguments: '{"x":1}',
    })
  })

  it('assistant thinking with anthropic roundTrip → skipped (foreign provider)', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'anthropic thinking',
            roundTrip: { provider: 'anthropic', signature: 'sig123' },
          },
          { type: 'text', text: 'answer' },
        ],
      },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
    expect(out[0].content[0]).toEqual({ type: 'output_text', text: 'answer' })
  })

  it('assistant thinking with provider:none roundTrip → skipped', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'unusable thinking',
            roundTrip: { provider: 'none' },
          },
          { type: 'text', text: 'answer' },
        ],
      },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
  })

  it('order preserved: reasoning → tool_use → text within one assistant message', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '...',
            roundTrip: {
              provider: 'openai-responses',
              id: 'rs_1',
              summaryParts: [],
            },
          },
          { type: 'tool_use', id: 'c1', name: 'foo', input: {} },
          { type: 'text', text: 'done' },
        ],
      },
    ]
    const out = messagesToOpenAIResponsesInput(messages) as any[]
    expect(out).toHaveLength(3)
    expect(out[0].type).toBe('reasoning')
    expect(out[1].type).toBe('function_call')
    expect(out[2].role).toBe('assistant')
  })
})

describe('toolsToOpenAIResponses', () => {
  it('flattens function tool format (no nested function: wrapper)', () => {
    const out = toolsToOpenAIResponses([
      {
        name: 'foo',
        description: 'does foo',
        inputSchema: { properties: { x: { type: 'number' } } } as any,
      },
    ])
    expect(out).toEqual([
      {
        type: 'function',
        name: 'foo',
        description: 'does foo',
        parameters: { type: 'object', properties: { x: { type: 'number' } } },
        strict: null,
      },
    ])
  })

  it('passes strict flag when set', () => {
    const out = toolsToOpenAIResponses([
      {
        name: 'foo',
        description: 'd',
        inputSchema: {} as any,
        strict: true,
      },
    ])
    expect(out[0].strict).toBe(true)
  })
})

describe('toolChoiceToOpenAIResponses', () => {
  it('maps auto/none/required as strings', () => {
    expect(toolChoiceToOpenAIResponses({ type: 'auto' })).toBe('auto')
    expect(toolChoiceToOpenAIResponses({ type: 'none' })).toBe('none')
    expect(toolChoiceToOpenAIResponses({ type: 'required' })).toBe('required')
  })

  it('maps specific tool with flat { type, name } shape (no nested function:)', () => {
    expect(toolChoiceToOpenAIResponses({ type: 'specific', name: 'my_tool' }))
      .toEqual({ type: 'function', name: 'my_tool' })
  })

  it('returns undefined when no choice provided', () => {
    expect(toolChoiceToOpenAIResponses(undefined)).toBeUndefined()
  })
})
