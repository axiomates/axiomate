import { describe, expect, test, vi } from 'vitest'

const mockGetGlobalConfig = vi.hoisted(() =>
  vi.fn<() => { templates?: Record<string, unknown> }>(() => ({})),
)

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: mockGetGlobalConfig,
  saveTemplateToConfig: vi.fn(),
}))

import { buildDryResolveSchema } from '../TemplateEditor.js'

describe('buildDryResolveSchema', () => {
  test("rejects extends typo with resolveTemplate's error message", () => {
    mockGetGlobalConfig.mockReturnValue({})
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      protocols: ['openai-chat'],
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
        a: { protocols: ['openai-chat'], extends: 'my-template' },
      },
    })
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      protocols: ['openai-chat'],
      extends: 'a',
      effort: { patch: { reasoning_effort: '<value>' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message).join('\n')
      expect(messages).toMatch(/cyclic/)
    }
  })

  test('rejects template with no protocols and no extends', () => {
    mockGetGlobalConfig.mockReturnValue({})
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      effort: { patch: { reasoning_effort: '<value>' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message).join('\n')
      expect(messages).toMatch(/missing 'protocols'/)
    }
  })

  test('accepts valid template extending a built-in', () => {
    mockGetGlobalConfig.mockReturnValue({})
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      extends: 'openai-default',
      effort: {
        patch: { reasoning_effort: '<value>' },
        valueMap: { high: 'high' },
      },
    })
    expect(result.success).toBe(true)
  })

  test('accepts valid template with own protocols', () => {
    mockGetGlobalConfig.mockReturnValue({})
    const schema = buildDryResolveSchema('my-template')
    const result = schema.safeParse({
      protocols: ['openai-chat'],
      effort: { patch: { reasoning_effort: '<value>' } },
    })
    expect(result.success).toBe(true)
  })
})
