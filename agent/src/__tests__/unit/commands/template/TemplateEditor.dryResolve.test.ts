import { describe, expect, test, vi } from 'vitest'

const mockGetGlobalConfig = vi.hoisted(() =>
  vi.fn(
    (): { templates?: Record<string, unknown> } => ({}),
  ),
)

vi.mock('../../../../utils/config.js', () => ({
  getGlobalConfig: mockGetGlobalConfig,
  saveTemplateToConfig: vi.fn(),
}))

import { buildDryResolveSchema } from '../../../../commands/template/TemplateEditor.js'

describe('buildDryResolveSchema', () => {
  test("rejects extends typo with resolveTemplate's error message", () => {
    mockGetGlobalConfig.mockReturnValue({})
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      protocol: 'openai-chat',
      extends: 'openai-defaut', // typo: missing 'l'
      effort: { patch: { reasoning_effort: '<value>' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message).join('\n')
      expect(messages).toMatch(/Unknown vendor template.*openai-defaut/)
    }
  })

  test('rejects cyclic extends chain', () => {
    mockGetGlobalConfig.mockReturnValue({
      templates: {
        // Existing template a points back to the new template, forming
        // a cycle once `my-template` is added with extends 'a'.
        a: { protocol: 'openai-chat', extends: 'my-template' },
      },
    })
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      protocol: 'openai-chat',
      extends: 'a',
      effort: { patch: { reasoning_effort: '<value>' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message).join('\n')
      expect(messages).toMatch(/cyclic/)
    }
  })

  test('accepts template with no protocol and no extends (pinning-only vendor)', () => {
    // Vendors without a protocol are valid — they represent API quirks
    // that don't fit any single protocol. The user must pin them
    // explicitly via `vendor:` on the model entry (no auto-match).
    mockGetGlobalConfig.mockReturnValue({})
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      effort: { patch: { reasoning_effort: '<value>' } },
    })
    expect(result.success).toBe(true)
  })

  test('accepts valid template extending a built-in', () => {
    mockGetGlobalConfig.mockReturnValue({})
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      extends: 'openai-chat',
      effort: {
        patch: { reasoning_effort: '<value>' },
        valueMap: { high: 'high' },
      },
    })
    expect(result.success).toBe(true)
  })

  test('accepts valid template with own protocol', () => {
    mockGetGlobalConfig.mockReturnValue({})
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      protocol: 'openai-chat',
      effort: { patch: { reasoning_effort: '<value>' } },
    })
    expect(result.success).toBe(true)
  })
})
