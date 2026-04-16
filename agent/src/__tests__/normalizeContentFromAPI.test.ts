import { describe, it, expect, vi } from 'vitest'

// Mock heavy dependencies of contentNormalization.ts
vi.mock('../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))
vi.mock('../services/analytics/metadata.js', () => ({
  sanitizeToolNameForAnalytics: vi.fn((name: string) => name),
}))
vi.mock('../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
  logAntError: vi.fn(),
}))
vi.mock('../utils/log.js', () => ({
  logError: vi.fn(),
  logMCPDebug: vi.fn(),
}))
// Mock normalizeToolInput (from api.ts which has heavy imports)
vi.mock('../utils/api.js', () => ({
  normalizeToolInput: vi.fn(
    (_tool: unknown, input: Record<string, unknown>) => input,
  ),
}))
// Mock Tool.ts - findToolByName returns undefined (no tool match) by default
vi.mock('../Tool.js', () => ({
  findToolByName: vi.fn(() => undefined),
}))

import { normalizeContentFromAPI } from '../utils/contentNormalization.js'
import type { ContentBlock as BetaContentBlock } from '../services/api/streamTypes.js'

// ---- test data helpers ----

function textBlock(text: string): BetaContentBlock {
  return { type: 'text' as const, text } as BetaContentBlock
}

function toolUseBlock(
  name: string,
  input: unknown,
  id = 'toolu_01',
): BetaContentBlock {
  return { type: 'tool_use' as const, id, name, input } as BetaContentBlock
}

function serverToolUseBlock(
  name: string,
  input: unknown,
  id = 'srvtu_01',
): any {
  return { type: 'server_tool_use', id, name, input }
}

// ---- tests ----

describe('normalizeContentFromAPI', () => {
  const NO_TOOLS: any = []

  // -- text blocks --

  describe('text blocks', () => {
    it('passes through normal text', () => {
      const blocks = [textBlock('hello world')]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(textBlock('hello world'))
    })

    it('passes through whitespace-only text (does not filter)', () => {
      const blocks = [textBlock('   ')]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(textBlock('   '))
    })

    it('passes through empty string text', () => {
      const blocks = [textBlock('')]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(textBlock(''))
    })
  })

  // -- tool_use blocks --

  describe('tool_use blocks', () => {
    it('keeps input as-is when already an object', () => {
      const blocks = [toolUseBlock('Read', { path: '/a.ts' })]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result[0]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Read',
        input: { path: '/a.ts' },
      })
    })

    it('parses valid JSON string input into object', () => {
      const blocks = [toolUseBlock('Read', '{"path":"/a.ts"}')]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result[0]).toMatchObject({
        type: 'tool_use',
        name: 'Read',
        input: { path: '/a.ts' },
      })
    })

    it('converts empty string input to empty object', () => {
      const blocks = [toolUseBlock('Read', '')]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result[0]).toMatchObject({
        type: 'tool_use',
        name: 'Read',
        input: {},
      })
    })

    it('converts invalid JSON string to empty object (graceful fallback)', () => {
      const blocks = [toolUseBlock('Read', '{broken json')]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result[0]).toMatchObject({
        type: 'tool_use',
        name: 'Read',
        input: {},
      })
    })

    it('preserves id and name through normalization', () => {
      const blocks = [toolUseBlock('Write', '{"content":"x"}', 'toolu_99')]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result[0]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_99',
        name: 'Write',
      })
    })

    it('parses nested JSON (outer layer only)', () => {
      const nested = JSON.stringify({ key: 'value' })
      const blocks = [toolUseBlock('Read', nested)]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result[0]).toMatchObject({
        type: 'tool_use',
        input: { key: 'value' },
      })
    })
  })

  // -- server_tool_use blocks --

  describe('server_tool_use blocks', () => {
    it('parses string input to object', () => {
      const blocks = [serverToolUseBlock('web_search', '{"query":"test"}')]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result[0]).toMatchObject({
        type: 'server_tool_use',
        input: { query: 'test' },
      })
    })

    it('keeps object input as-is', () => {
      const blocks = [serverToolUseBlock('web_search', { query: 'test' })]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result[0]).toMatchObject({
        type: 'server_tool_use',
        input: { query: 'test' },
      })
    })
  })

  // -- unknown/future block types --

  describe('unknown block types', () => {
    it('passes through unknown types unchanged', () => {
      const block = { type: 'future_block_type', data: 'something' } as any
      const result = normalizeContentFromAPI([block], NO_TOOLS)
      expect(result[0]).toEqual(block)
    })

    it('passes through mcp_tool_use as-is', () => {
      const block = {
        type: 'mcp_tool_use',
        id: 'mcp_1',
        name: 'test',
        input: {},
      } as any
      const result = normalizeContentFromAPI([block], NO_TOOLS)
      expect(result[0]).toEqual(block)
    })
  })

  // -- mixed blocks / edge cases --

  describe('mixed blocks and edge cases', () => {
    it('handles array with mixed block types', () => {
      const blocks = [
        textBlock('thinking...'),
        toolUseBlock('Read', '{"path":"/b"}'),
        textBlock('done'),
      ]
      const result = normalizeContentFromAPI(blocks, NO_TOOLS)
      expect(result).toHaveLength(3)
      expect(result[0]).toMatchObject({ type: 'text', text: 'thinking...' })
      expect(result[1]).toMatchObject({
        type: 'tool_use',
        input: { path: '/b' },
      })
      expect(result[2]).toMatchObject({ type: 'text', text: 'done' })
    })

    it('returns empty array for empty input', () => {
      const result = normalizeContentFromAPI([], NO_TOOLS)
      expect(result).toEqual([])
    })

    it('returns empty array for null/undefined input', () => {
      const result = normalizeContentFromAPI(null as any, NO_TOOLS)
      expect(result).toEqual([])
      const result2 = normalizeContentFromAPI(undefined as any, NO_TOOLS)
      expect(result2).toEqual([])
    })
  })
})
