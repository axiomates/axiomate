import { describe, it, expect } from 'vitest'
import {
  blockParamToNeutral,
  blockParamToAnthropic,
  messageToNeutral,
  messagesToAnthropic,
  toolsToNeutral,
  toolsToAnthropic,
  toolChoiceToNeutral,
  toolChoiceToAnthropic,
} from '../../../../services/api/adapters/anthropicRequestAdapter.js'

// ---------------------------------------------------------------------------
// blockParamToNeutral — now pass-through since field names match
// ---------------------------------------------------------------------------

describe('blockParamToNeutral', () => {
  it('passes through text block unchanged', () => {
    const block = { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }
    expect(blockParamToNeutral(block)).toBe(block) // same reference
  })

  it('passes through tool_result block with snake_case fields', () => {
    const block = { type: 'tool_result', tool_use_id: 'toolu_01', content: 'output', is_error: false }
    const result = blockParamToNeutral(block)
    expect(result).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: 'output',
      is_error: false,
    })
  })

  it('passes through image block with source structure', () => {
    const block = {
      type: 'image',
      source: { type: 'base64', data: 'abc', media_type: 'image/png' },
    }
    expect(blockParamToNeutral(block)).toBe(block)
  })

  it('passes through tool_use block', () => {
    const block = { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: '/a' } }
    expect(blockParamToNeutral(block)).toBe(block)
  })

  it('passes through thinking block', () => {
    const block = {
      type: 'thinking',
      thinking: 'hmm',
      roundTrip: { provider: 'anthropic', signature: 'sig' },
    }
    expect(blockParamToNeutral(block)).toBe(block)
  })
})

// ---------------------------------------------------------------------------
// messageToNeutral — pass-through cast
// ---------------------------------------------------------------------------

describe('messageToNeutral', () => {
  it('passes through user message with string content', () => {
    const msg = { role: 'user' as const, content: 'hello' }
    expect(messageToNeutral(msg)).toBe(msg)
  })

  it('passes through user message with block array', () => {
    const msg = {
      role: 'user' as const,
      content: [
        { type: 'text', text: 'look' },
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' },
      ],
    }
    expect(messageToNeutral(msg)).toBe(msg)
  })

  it('passes through assistant message', () => {
    const msg = {
      role: 'assistant' as const,
      content: [{ type: 'text', text: 'hello' }],
    }
    expect(messageToNeutral(msg)).toBe(msg)
  })
})

// ---------------------------------------------------------------------------
// messagesToAnthropic — pass-through cast
// ---------------------------------------------------------------------------

describe('messagesToAnthropic', () => {
  it('passes through messages (field names are compatible)', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'hello' }] },
    ]
    const result = messagesToAnthropic(messages as any)
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('user')
    expect(result[1].role).toBe('assistant')
  })
})

// ---------------------------------------------------------------------------
// blockParamToAnthropic — pass-through cast
// ---------------------------------------------------------------------------

describe('blockParamToAnthropic', () => {
  it('passes through text block', () => {
    const block = { type: 'text' as const, text: 'hi' }
    expect(blockParamToAnthropic(block)).toBe(block)
  })

  it('passes through tool_result block with snake_case fields', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'toolu_01',
      content: 'output',
      is_error: true,
    }
    const result = blockParamToAnthropic(block)
    expect(result).toBe(block)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: neutral → anthropic → neutral (trivial since pass-through)
// ---------------------------------------------------------------------------

describe('round-trip conversion', () => {
  it('text block is identity', () => {
    const block = { type: 'text' as const, text: 'hello' }
    expect(blockParamToNeutral(blockParamToAnthropic(block))).toBe(block)
  })

  it('tool_use block is identity', () => {
    const block = {
      type: 'tool_use' as const,
      id: 'toolu_01',
      name: 'Read',
      input: { path: '/a' },
    }
    expect(blockParamToNeutral(blockParamToAnthropic(block))).toBe(block)
  })

  it('tool_result block is identity', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'toolu_01',
      content: 'output',
      is_error: false,
    }
    expect(blockParamToNeutral(blockParamToAnthropic(block))).toBe(block)
  })
})

// ---------------------------------------------------------------------------
// toolsToNeutral / toolsToAnthropic
// ---------------------------------------------------------------------------

describe('toolsToNeutral', () => {
  it('converts BetaTool to ToolDefinition', () => {
    const tools = [{
      name: 'Read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }]
    expect(toolsToNeutral(tools as any)).toEqual([{
      name: 'Read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }])
  })

  it('filters out special tool types without input_schema', () => {
    const tools = [
      { name: 'bash', type: 'bash_20250124' },
      { name: 'Read', input_schema: { type: 'object' }, description: 'read' },
    ]
    const result = toolsToNeutral(tools as any)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Read')
  })
})

describe('toolsToAnthropic', () => {
  it('converts ToolDefinition to BetaTool', () => {
    const result = toolsToAnthropic([{
      name: 'Read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }])
    expect(result[0]).toMatchObject({
      name: 'Read',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    })
  })
})

// ---------------------------------------------------------------------------
// toolChoiceToNeutral / toolChoiceToAnthropic
// ---------------------------------------------------------------------------

describe('toolChoiceToNeutral', () => {
  it('maps auto', () => expect(toolChoiceToNeutral({ type: 'auto' })).toEqual({ type: 'auto' }))
  it('maps any → required', () => expect(toolChoiceToNeutral({ type: 'any' })).toEqual({ type: 'required' }))
  it('maps tool → specific', () =>
    expect(toolChoiceToNeutral({ type: 'tool', name: 'Read' })).toEqual({ type: 'specific', name: 'Read' }))
  it('maps none', () => expect(toolChoiceToNeutral({ type: 'none' })).toEqual({ type: 'none' }))
  it('returns undefined for undefined', () => expect(toolChoiceToNeutral(undefined)).toBeUndefined())
})

describe('toolChoiceToAnthropic', () => {
  it('maps auto', () => expect(toolChoiceToAnthropic({ type: 'auto' })).toEqual({ type: 'auto' }))
  it('maps required → any', () => expect(toolChoiceToAnthropic({ type: 'required' })).toEqual({ type: 'any' }))
  it('maps specific → tool', () =>
    expect(toolChoiceToAnthropic({ type: 'specific', name: 'Read' })).toEqual({ type: 'tool', name: 'Read' }))
  it('maps none', () => expect(toolChoiceToAnthropic({ type: 'none' })).toEqual({ type: 'none' }))
  it('returns undefined for undefined', () => expect(toolChoiceToAnthropic(undefined)).toBeUndefined())
})
