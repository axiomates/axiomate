import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))

import { logForDebugging } from '../../../utils/debug.js'
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

  it('openai-chat + api.deepseek.com baseUrl → deepseek-reasoning', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
      }),
    ).toBe('deepseek-reasoning')
  })

  it('openai-chat + SiliconFlow baseUrl → openai-siliconflow-thinking (gateway-level)', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'Qwen/Qwen3-235B',
        baseUrl: 'https://api.siliconflow.cn/v1',
      }),
    ).toBe('openai-siliconflow-thinking')
    // Even DeepSeek-via-SiliconFlow uses the gateway's wire schema:
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-ai/DeepSeek-V4-Flash',
        baseUrl: 'https://api.siliconflow.cn/v1',
      }),
    ).toBe('openai-siliconflow-thinking')
  })

  it('openai-chat + aliyun DashScope baseUrl → openai-ali-thinking', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'qwen3.6-plus',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    ).toBe('openai-ali-thinking')
  })

  it('openai-chat + DeepSeek V4 model name (unknown gateway) → deepseek-reasoning', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://my-private-relay.example.com/v1',
      }),
    ).toBe('deepseek-reasoning')
  })

  it('openai-chat + future DeepSeek versions (v4.1, v5, v10, v100) on unknown gateway → deepseek-reasoning', () => {
    for (const m of ['deepseek-v4.1-pro', 'deepseek-v5', 'deepseek-v10', 'deepseek-v100-ultra']) {
      expect(
        inferVendor({
          protocol: 'openai-chat',
          model: m,
          baseUrl: 'https://example.com/v1',
        }),
      ).toBe('deepseek-reasoning')
    }
  })

  it('openai-chat + DeepSeek versions WITHOUT the v prefix → deepseek-reasoning', () => {
    // Common third-party-relay naming uses bare numbers instead of v-prefix.
    for (const m of [
      'deepseek-4',
      'DeepSeek 4',
      'deepseek 4.1',
      'deepseek_4',
      'DeepSeek-4.2-Pro',
    ]) {
      expect(
        inferVendor({
          protocol: 'openai-chat',
          model: m,
          baseUrl: 'https://example.com/v1',
        }),
      ).toBe('deepseek-reasoning')
    }
  })

  it('openai-chat + non-version model lines that happen to contain "deepseek" + a digit later → openai-default', () => {
    // The regex requires the digit to be adjacent to deepseek (only optional
    // 'v' + space/dash/underscore between them), so unrelated R-series and
    // distill names don't get misclassified as a reasoning version.
    for (const m of [
      'deepseek-r1',
      'deepseek-r1-distill-70b',
      'deepseek-coder-7b',
      'deepseek-chat',
    ]) {
      expect(
        inferVendor({
          protocol: 'openai-chat',
          model: m,
          baseUrl: 'https://example.com/v1',
        }),
      ).toBe('openai-default')
    }
  })

  it('openai-chat + unknown gateway + unknown model → openai-default', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'gpt-4o',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBe('openai-default')
  })

  it('does not match deepseek-v2 / v3 (older non-reasoning models)', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v2',
        baseUrl: 'https://example.com/v1',
      }),
    ).toBe('openai-default')
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v3',
        baseUrl: 'https://example.com/v1',
      }),
    ).toBe('openai-default')
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v3.5',
        baseUrl: 'https://example.com/v1',
      }),
    ).toBe('openai-default')
  })

  it('Qwen model on a non-aliyun/SiliconFlow gateway → openai-default (no name-based inference)', () => {
    // OpenRouter etc. host Qwen but use OpenAI-standard schema.
    // User must explicitly set vendor: 'openai-ali-thinking' if needed.
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'qwen/qwen3-235b',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBe('openai-default')
  })
})

describe('isBuiltinVendor', () => {
  it('recognizes all 6 built-ins', () => {
    expect(isBuiltinVendor('openai-default')).toBe(true)
    expect(isBuiltinVendor('openai-responses')).toBe(true)
    expect(isBuiltinVendor('anthropic')).toBe(true)
    expect(isBuiltinVendor('deepseek-reasoning')).toBe(true)
    expect(isBuiltinVendor('openai-ali-thinking')).toBe(true)
    expect(isBuiltinVendor('openai-siliconflow-thinking')).toBe(true)
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
          valueMap: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
        },
      },
    }
    const t = resolveTemplate('my-deepseek-mod', custom)
    expect(t.autoRoundTripReasoningContent).toBe(true) // inherited
    // Override exposes low (built-in deepseek-reasoning omits it).
    expect(t.effort?.valueMap?.low).toBe('low')
  })

  it('detects extends cycles', () => {
    const custom: Record<string, VendorTemplate> = {
      a: { extends: 'b' },
      b: { extends: 'a' },
    }
    expect(() => resolveTemplate('a', custom)).toThrow(/cyclic/)
  })

  it('throws when a custom template has neither protocols nor extends', () => {
    const custom: Record<string, VendorTemplate> = {
      'bare-vendor': {
        effort: { patch: { reasoning_effort: '<value>' } },
      },
    }
    expect(() => resolveTemplate('bare-vendor', custom)).toThrow(
      /missing 'protocols'/,
    )
  })

  it('inherits protocols from extends chain when child omits it', () => {
    const custom: Record<string, VendorTemplate> = {
      'derived-from-deepseek': {
        extends: 'deepseek-reasoning',
        // no protocols here — inherited from deepseek-reasoning
      },
    }
    const t = resolveTemplate('derived-from-deepseek', custom)
    expect(t.protocols).toEqual(['openai-chat'])
  })

  it("child's explicit protocols override the parent", () => {
    const custom: Record<string, VendorTemplate> = {
      'override-vendor': {
        protocols: ['openai-responses'],
        extends: 'openai-default',
      },
    }
    const t = resolveTemplate('override-vendor', custom)
    expect(t.protocols).toEqual(['openai-responses'])
  })

  it('custom template wins over built-in on name collision', () => {
    const custom: Record<string, VendorTemplate> = {
      'openai-default': {
        protocols: ['openai-chat'],
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

  it('thinking enabled maps each axiomate level to a distinct OpenAI level', () => {
    // axiomate's 4 levels (low/medium/high/max) cover OpenAI's 4 levels
    // (minimal/low/medium/high) so each ModelPicker tier has a distinct
    // wire effort rather than collapsing onto 'high'.
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'low' }, template),
    ).toEqual({ reasoning_effort: 'minimal' })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'medium' }, template),
    ).toEqual({ reasoning_effort: 'low' })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'high' }, template),
    ).toEqual({ reasoning_effort: 'medium' })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'max' }, template),
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

  it('thinking enabled maps each axiomate level to a distinct OpenAI Responses level', () => {
    // Same axiomate→OpenAI mapping as openai-default; effort lives under reasoning.effort.
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'low' }, template),
    ).toEqual({ reasoning: { effort: 'minimal', summary: 'auto' } })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'medium' }, template),
    ).toEqual({ reasoning: { effort: 'low', summary: 'auto' } })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'high' }, template),
    ).toEqual({ reasoning: { effort: 'medium', summary: 'auto' } })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'max' }, template),
    ).toEqual({ reasoning: { effort: 'high', summary: 'auto' } })
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

  it('low/medium/high pass through identity (anthropic supports the lower 3 tiers)', () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'low' }, template)).toEqual({
      output_config: { effort: 'low' },
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'medium' }, template)).toEqual({
      output_config: { effort: 'medium' },
    })
  })

  it("'max' is not in valueMap — transmits literal 'max' (anthropic will likely reject)", () => {
    // 'max' was intentionally removed from valueMap; runtime fallback emits
    // the literal so off-grid configs surface as vendor errors rather than
    // silently collapsing.
    expect(applyThinkingTemplate({ enabled: true, effort: 'max' }, template)).toEqual({
      output_config: { effort: 'max' },
    })
  })

  it('exposes anthropicThinkingField default budget for SDK construction', () => {
    expect(template.anthropicThinkingField?.defaultBudgetTokens).toBe(16000)
  })
})

describe('applyThinkingTemplate — built-in: deepseek-reasoning', () => {
  const template = resolveTemplate('deepseek-reasoning')

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

  it("low/medium not in valueMap — pass through as literals (DeepSeek will reject)", () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'low' }, template)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'medium' }, template)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
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

describe('applyThinkingTemplate — built-in: openai-ali-thinking', () => {
  const template = resolveTemplate('openai-ali-thinking')

  it('enabled with effort + budget → enable_thinking + reasoning_effort + thinking_budget', () => {
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'high', budget: 4096 }, template),
    ).toEqual({
      enable_thinking: true,
      reasoning_effort: 'high',
      thinking_budget: 4096,
    })
  })

  it("max maps to xhigh (the gateway's top tier)", () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'max' }, template)).toEqual({
      enable_thinking: true,
      reasoning_effort: 'xhigh',
    })
  })

  it("low/medium not in valueMap — pass through as literals (gateway will reject)", () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'low' }, template)).toEqual({
      enable_thinking: true,
      reasoning_effort: 'low',
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'medium' }, template)).toEqual({
      enable_thinking: true,
      reasoning_effort: 'medium',
    })
  })

  it('enabled without effort/budget → enable_thinking: true only', () => {
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

describe('applyThinkingTemplate — built-in: openai-siliconflow-thinking', () => {
  const template = resolveTemplate('openai-siliconflow-thinking')

  it('high/max pass through unchanged (the only tiers SiliconFlow accepts)', () => {
    for (const lvl of ['high', 'max'] as const) {
      expect(
        applyThinkingTemplate({ enabled: true, effort: lvl }, template),
      ).toEqual({
        enable_thinking: true,
        reasoning_effort: lvl,
      })
    }
  })

  it("low/medium not in valueMap — pass through as literals", () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'low' }, template)).toEqual({
      enable_thinking: true,
      reasoning_effort: 'low',
    })
  })

  it('budget passes through as thinking_budget', () => {
    expect(
      applyThinkingTemplate({ enabled: true, budget: 4096 }, template),
    ).toEqual({
      enable_thinking: true,
      thinking_budget: 4096,
    })
  })

  it('disabled → enable_thinking: false', () => {
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
  it('all 6 expected names present', () => {
    const builtins = getBuiltinTemplates()
    expect(Object.keys(builtins).sort()).toEqual([
      'anthropic',
      'deepseek-reasoning',
      'openai-ali-thinking',
      'openai-default',
      'openai-responses',
      'openai-siliconflow-thinking',
    ])
  })

  it('every built-in declares non-empty protocols', () => {
    const builtins = getBuiltinTemplates()
    for (const [name, tpl] of Object.entries(builtins)) {
      expect(tpl.protocols, `${name} should declare protocols`).toBeDefined()
      expect(
        tpl.protocols!.length,
        `${name} should have at least one protocol`,
      ).toBeGreaterThan(0)
    }
  })

  it('protocol-to-template mapping is what M1 expects', () => {
    expect(resolveTemplate('anthropic').protocols).toEqual(['anthropic'])
    expect(resolveTemplate('openai-responses').protocols).toEqual([
      'openai-responses',
    ])
    expect(resolveTemplate('openai-default').protocols).toEqual(['openai-chat'])
    expect(resolveTemplate('deepseek-reasoning').protocols).toEqual([
      'openai-chat',
    ])
    expect(resolveTemplate('openai-ali-thinking').protocols).toEqual([
      'openai-chat',
    ])
    expect(resolveTemplate('openai-siliconflow-thinking').protocols).toEqual([
      'openai-chat',
    ])
  })
})

describe("applyThinkingTemplate — effort: 'none' bypasses enabledPatch/effort/budget", () => {
  it('openai-default with effort=none → empty (no disabledPatch defined; just omit reasoning fields)', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('openai-default'),
      ),
    ).toEqual({})
  })

  it('openai-responses with effort=none → empty (no disabledPatch defined)', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('openai-responses'),
      ),
    ).toEqual({})
  })

  it('anthropic with effort=none → empty (no disabledPatch defined)', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('anthropic'),
      ),
    ).toEqual({})
  })

  it("deepseek-reasoning with effort=none → { thinking: { type: 'disabled' } }", () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('deepseek-reasoning'),
      ),
    ).toEqual({ thinking: { type: 'disabled' } })
  })

  it('openai-ali-thinking with effort=none → { enable_thinking: false }', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('openai-ali-thinking'),
      ),
    ).toEqual({ enable_thinking: false })
  })

  it('openai-siliconflow-thinking with effort=none → { enable_thinking: false }', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('openai-siliconflow-thinking'),
      ),
    ).toEqual({ enable_thinking: false })
  })

  it('effort=none ignores valueMap remapping (none always means off)', () => {
    const customWithRemap: VendorTemplate = {
      enabledPatch: { mode: 'on' },
      disabledPatch: { mode: 'off' },
      effort: {
        patch: { level: '<value>' },
        // Even if a vendor template sets a remap for 'none', the runtime
        // bypasses it and emits disabledPatch only.
        valueMap: { none: 'something-else', max: 'max' },
      },
    }
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        customWithRemap,
      ),
    ).toEqual({ mode: 'off' })
  })

  it('effort=none skips budget patch (thinking is fully off, budget is meaningless)', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none', budget: 4096 },
        resolveTemplate('openai-ali-thinking'),
      ),
    ).toEqual({ enable_thinking: false })
  })

  it('effort=none with thinking.enabled=false still emits disabledPatch (consistent shape)', () => {
    expect(
      applyThinkingTemplate(
        { enabled: false, effort: 'none' },
        resolveTemplate('openai-siliconflow-thinking'),
      ),
    ).toEqual({ enable_thinking: false })
  })
})

describe('applyThinkingTemplate — partial valueMap', () => {
  it('omitted valueMap = identity over all 4 tiers (back-compat)', () => {
    const tpl: VendorTemplate = {
      effort: { patch: { reasoning_effort: '<value>' } },
      // valueMap deliberately omitted
    }
    for (const lvl of ['low', 'medium', 'high', 'max'] as const) {
      expect(
        applyThinkingTemplate({ enabled: true, effort: lvl }, tpl),
      ).toEqual({ reasoning_effort: lvl })
    }
  })

  it('off-grid effort (not a key in valueMap) passes through as literal', () => {
    const tpl: VendorTemplate = {
      effort: {
        patch: { reasoning_effort: '<value>' },
        valueMap: { high: 'high', max: 'max' },
      },
    }
    // 'low' isn't in valueMap → fallback to identity 'low'.
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'low' }, tpl),
    ).toEqual({ reasoning_effort: 'low' })
  })

  it('partial valueMap with explicit remap on listed keys works as expected', () => {
    const tpl: VendorTemplate = {
      effort: {
        patch: { reasoning_effort: '<value>' },
        valueMap: { high: 'high', max: 'xhigh' },
      },
    }
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'max' }, tpl),
    ).toEqual({ reasoning_effort: 'xhigh' })
  })
})

describe('applyThinkingTemplate — silent-drop warnings', () => {
  const mockedLog = vi.mocked(logForDebugging)

  it('warns when thinking.budget is set but template has no budget patch', () => {
    mockedLog.mockClear()
    const tpl = resolveTemplate('openai-default')
    applyThinkingTemplate(
      { enabled: true, effort: 'high', budget: 8192 },
      tpl,
    )
    expect(mockedLog).toHaveBeenCalled()
    const msg = mockedLog.mock.calls.map(c => c[0]).join('\n')
    expect(msg).toMatch(/budget=8192/)
    expect(msg).toMatch(/no budget patch/)
  })

  it('does NOT warn when budget is set and the template has a budget patch', () => {
    mockedLog.mockClear()
    const tpl = resolveTemplate('anthropic')
    applyThinkingTemplate(
      { enabled: true, effort: 'high', budget: 4096 },
      tpl,
    )
    const budgetWarnings = mockedLog.mock.calls.filter(c =>
      String(c[0]).includes('no budget patch'),
    )
    expect(budgetWarnings).toHaveLength(0)
  })

  it('warns when enabled:false but a non-none effort is configured', () => {
    mockedLog.mockClear()
    const tpl = resolveTemplate('openai-ali-thinking')
    const out = applyThinkingTemplate(
      { enabled: false, effort: 'high' },
      tpl,
    )
    // disabledPatch is still emitted; effort is dropped.
    expect(out).toEqual({ enable_thinking: false })
    expect(mockedLog).toHaveBeenCalled()
    const msg = mockedLog.mock.calls.map(c => c[0]).join('\n')
    expect(msg).toMatch(/effort='high' ignored/)
    expect(msg).toMatch(/enabled=false/)
  })

  it("does NOT warn when enabled:false + effort:'none' (consistent off-state)", () => {
    mockedLog.mockClear()
    const tpl = resolveTemplate('openai-ali-thinking')
    applyThinkingTemplate({ enabled: false, effort: 'none' }, tpl)
    const effortWarnings = mockedLog.mock.calls.filter(c =>
      String(c[0]).includes("effort='"),
    )
    expect(effortWarnings).toHaveLength(0)
  })

  it('does NOT warn when enabled:false and no effort configured', () => {
    mockedLog.mockClear()
    const tpl = resolveTemplate('openai-ali-thinking')
    applyThinkingTemplate({ enabled: false }, tpl)
    expect(mockedLog).not.toHaveBeenCalled()
  })
})
