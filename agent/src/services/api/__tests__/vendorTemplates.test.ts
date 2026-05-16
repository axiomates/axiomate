import { describe, it, expect } from 'vitest'
import {
  applyThinkingTemplate,
  inferVendor,
  isBuiltinVendor,
  resolveTemplate,
  deepMerge,
  getBuiltinTemplates,
  type VendorTemplate,
} from '../vendorTemplates.js'

describe('inferVendor', () => {
  it('anthropic protocol → anthropic', () => {
    expect(inferVendor({ protocol: 'anthropic', model: 'anthropic-flagship-4' })).toBe('anthropic')
  })

  it('openai-responses protocol → openai-responses', () => {
    expect(inferVendor({ protocol: 'openai-responses', model: 'o4-mini' })).toBe('openai-responses')
  })

  it('openai + DeepSeek V4 → deepseek-reasoning', () => {
    expect(inferVendor({ protocol: 'openai-chat', model: 'deepseek-v4-pro' })).toBe('deepseek-reasoning')
    expect(inferVendor({ protocol: 'openai-chat', model: 'deepseek-ai/DeepSeek-V4-Flash' })).toBe('deepseek-reasoning')
  })

  it('openai + Qwen3+ → qwen-thinking', () => {
    expect(inferVendor({ protocol: 'openai-chat', model: 'Qwen/Qwen3-235B' })).toBe('qwen-thinking')
    expect(inferVendor({ protocol: 'openai-chat', model: 'qwen3-235b' })).toBe('qwen-thinking')
    expect(inferVendor({ protocol: 'openai-chat', model: 'Qwen/Qwen3.5-122B' })).toBe('qwen-thinking')
  })

  it('openai + unknown model → openai-default', () => {
    expect(inferVendor({ protocol: 'openai-chat', model: 'gpt-4o' })).toBe('openai-default')
    expect(inferVendor({ protocol: 'openai-chat', model: 'mistral-large' })).toBe('openai-default')
  })

  it('does not match deepseek-v2 (older non-reasoning models)', () => {
    expect(inferVendor({ protocol: 'openai-chat', model: 'deepseek-v2' })).toBe('openai-default')
  })
})

describe('isBuiltinVendor', () => {
  it('recognizes all 5 built-ins', () => {
    expect(isBuiltinVendor('openai-default')).toBe(true)
    expect(isBuiltinVendor('openai-responses')).toBe(true)
    expect(isBuiltinVendor('anthropic')).toBe(true)
    expect(isBuiltinVendor('deepseek-reasoning')).toBe(true)
    expect(isBuiltinVendor('qwen-thinking')).toBe(true)
  })

  it('rejects unknown names', () => {
    expect(isBuiltinVendor('my-custom')).toBe(false)
    expect(isBuiltinVendor('')).toBe(false)
  })
})

describe('resolveTemplate', () => {
  it('returns built-in template by name', () => {
    const t = resolveTemplate('openai-default')
    expect(t.effort?.patch).toEqual({ reasoning_effort: '<value>' })
  })

  it('throws on unknown name', () => {
    expect(() => resolveTemplate('does-not-exist')).toThrow(/Unknown vendor template/)
  })

  it('applies extends chain (custom extends built-in)', () => {
    const custom: Record<string, VendorTemplate> = {
      'my-deepseek-mod': {
        extends: 'deepseek-reasoning',
        // Override only effort.valueMap (rest inherited)
        effort: {
          patch: { reasoning_effort: '<value>' },
          valueMap: { low: 'low', medium: 'medium', high: 'high', max: 'max' }, // disable DeepSeek's collapse
        },
      },
    }
    const t = resolveTemplate('my-deepseek-mod', custom)
    expect(t.autoRoundTripReasoningContent).toBe(true) // inherited
    expect(t.effort?.valueMap?.low).toBe('low') // overridden
  })

  it('detects extends cycles', () => {
    const custom: Record<string, VendorTemplate> = {
      a: { extends: 'b' },
      b: { extends: 'a' },
    }
    expect(() => resolveTemplate('a', custom)).toThrow(/cyclic/)
  })

  it('custom template wins over built-in on name collision', () => {
    const custom: Record<string, VendorTemplate> = {
      'openai-default': {
        effort: { patch: { my_custom_effort: '<value>' } },
      },
    }
    const t = resolveTemplate('openai-default', custom)
    expect(t.effort?.patch).toEqual({ my_custom_effort: '<value>' })
  })
})

describe('applyThinkingTemplate — built-in: openai-default', () => {
  const template = resolveTemplate('openai-default')

  it('thinking undefined → empty', () => {
    expect(applyThinkingTemplate(undefined, template)).toEqual({})
  })

  it('thinking enabled with effort=high → reasoning_effort: high', () => {
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'high' }, template),
    ).toEqual({ reasoning_effort: 'high' })
  })

  it('thinking enabled without effort → empty (no patch fires)', () => {
    expect(applyThinkingTemplate({ enabled: true }, template)).toEqual({})
  })

  it('thinking disabled → empty (no disabledPatch on this vendor)', () => {
    expect(applyThinkingTemplate({ enabled: false, effort: 'high' }, template)).toEqual({})
  })
})

describe('applyThinkingTemplate — built-in: openai-responses', () => {
  const template = resolveTemplate('openai-responses')

  it('thinking enabled with effort → reasoning: { effort, summary: auto }', () => {
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'medium' }, template),
    ).toEqual({ reasoning: { effort: 'medium', summary: 'auto' } })
  })

  it('thinking enabled without effort → reasoning: { summary: auto } only', () => {
    expect(applyThinkingTemplate({ enabled: true }, template)).toEqual({
      reasoning: { summary: 'auto' },
    })
  })
})

describe('applyThinkingTemplate — built-in: anthropic', () => {
  const template = resolveTemplate('anthropic')

  it('thinking enabled with effort + budget → output_config.effort + thinking.budget_tokens', () => {
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'high', budget: 8000 }, template),
    ).toEqual({
      output_config: { effort: 'high' },
      thinking: { budget_tokens: 8000 },
    })
  })

  it('exposes anthropicThinkingField default budget for SDK construction', () => {
    expect(template.anthropicThinkingField?.defaultBudgetTokens).toBe(16000)
  })
})

describe('applyThinkingTemplate — built-in: deepseek-reasoning', () => {
  const template = resolveTemplate('deepseek-reasoning')

  it('low/medium effort collapses to high (DeepSeek docs)', () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'low' }, template)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'medium' }, template)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  it('high stays high; max stays max', () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'high' }, template)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'max' }, template)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })

  it('enabled without effort still emits thinking field', () => {
    expect(applyThinkingTemplate({ enabled: true }, template)).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  it('autoRoundTripReasoningContent flag is set', () => {
    expect(template.autoRoundTripReasoningContent).toBe(true)
  })
})

describe('applyThinkingTemplate — built-in: qwen-thinking', () => {
  const template = resolveTemplate('qwen-thinking')

  it('enabled with budget → enable_thinking: true + thinking_budget', () => {
    expect(
      applyThinkingTemplate({ enabled: true, budget: 4096 }, template),
    ).toEqual({ enable_thinking: true, thinking_budget: 4096 })
  })

  it('enabled without budget → enable_thinking: true only', () => {
    expect(applyThinkingTemplate({ enabled: true }, template)).toEqual({
      enable_thinking: true,
    })
  })

  it('disabled → enable_thinking: false (explicit disabledPatch)', () => {
    expect(applyThinkingTemplate({ enabled: false }, template)).toEqual({
      enable_thinking: false,
    })
  })
})

describe('deepMerge', () => {
  it('overwrites primitive at leaf', () => {
    const dst: Record<string, unknown> = { a: 1, b: 2 }
    deepMerge(dst, { b: 3 })
    expect(dst).toEqual({ a: 1, b: 3 })
  })

  it('merges nested objects field-by-field', () => {
    const dst: Record<string, unknown> = { thinking: { type: 'enabled', budget_tokens: 1000 } }
    deepMerge(dst, { thinking: { budget_tokens: 8000 } })
    expect(dst).toEqual({ thinking: { type: 'enabled', budget_tokens: 8000 } })
  })

  it('replaces arrays wholesale (no element merge)', () => {
    const dst: Record<string, unknown> = { tools: [1, 2, 3] }
    deepMerge(dst, { tools: [4] })
    expect(dst).toEqual({ tools: [4] })
  })
})

describe('built-in templates structural sanity', () => {
  it('all 5 expected names present', () => {
    const builtins = getBuiltinTemplates()
    expect(Object.keys(builtins).sort()).toEqual([
      'anthropic',
      'deepseek-reasoning',
      'openai-default',
      'openai-responses',
      'qwen-thinking',
    ])
  })
})
