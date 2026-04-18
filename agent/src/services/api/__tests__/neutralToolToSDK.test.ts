import { describe, it, expect } from 'vitest'
import { neutralToolToSDK } from '../adapters/anthropicRequestAdapter.js'
import type { NeutralToolSchema } from '../streamTypes.js'

describe('neutralToolToSDK', () => {
  it('converts basic tool schema with inputSchema → input_schema', () => {
    const tool: NeutralToolSchema = {
      name: 'Read',
      inputSchema: { properties: { path: { type: 'string' } } },
    }
    const result = neutralToolToSDK(tool)
    expect(result).toEqual({
      name: 'Read',
      description: undefined,
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    })
  })

  it('includes strict: true when set', () => {
    const tool: NeutralToolSchema = {
      name: 'Write',
      inputSchema: {},
      strict: true,
    }
    const result = neutralToolToSDK(tool)
    expect(result.strict).toBe(true)
  })

  it('includes cache_control when set', () => {
    const tool: NeutralToolSchema = {
      name: 'Edit',
      inputSchema: {},
      cache_control: { type: 'ephemeral' },
    }
    const result = neutralToolToSDK(tool)
    expect(result.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('includes eager_input_streaming: true when set', () => {
    const tool: NeutralToolSchema = {
      name: 'Bash',
      inputSchema: {},
      eager_input_streaming: true,
    }
    const result = neutralToolToSDK(tool)
    expect(result.eager_input_streaming).toBe(true)
  })

  it('does not include undefined keys when optional fields are absent', () => {
    const tool: NeutralToolSchema = {
      name: 'Read',
      inputSchema: { properties: {} },
    }
    const result = neutralToolToSDK(tool)
    const keys = Object.keys(result)
    expect(keys).not.toContain('strict')
    expect(keys).not.toContain('cache_control')
    expect(keys).not.toContain('eager_input_streaming')
  })

  it('passes description through', () => {
    const tool: NeutralToolSchema = {
      name: 'Read',
      description: 'Reads a file from disk',
      inputSchema: {},
    }
    const result = neutralToolToSDK(tool)
    expect(result.description).toBe('Reads a file from disk')
  })
})
