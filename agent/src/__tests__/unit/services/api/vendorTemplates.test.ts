import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))

import { logForDebugging } from '../../../../utils/debug.js'
import {
  applyThinkingTemplate,
  getMatchingModelTemplates,
  inferModelTemplate,
  inferVendor,
  isBuiltinModelTemplate,
  isBuiltinVendor,
  resolveStack,
  resolveTemplate,
  deepMerge,
  getBuiltinTemplates,
  type VendorTemplate,
} from '../../../../services/api/vendorTemplates.js'

describe('inferVendor', () => {
  it('anthropic protocol with no special baseUrl → undefined (vanilla protocol layer used)', () => {
    expect(inferVendor({ protocol: 'anthropic', model: 'anthropic-flagship-4' })).toBeUndefined()
  })

  it('openai-responses protocol with no special baseUrl → undefined (vanilla protocol layer used)', () => {
    expect(inferVendor({ protocol: 'openai-responses', model: 'o4-mini' })).toBeUndefined()
  })

  it('openai-chat + api.deepseek.com baseUrl → openai-chat-deepseek-official', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
      }),
    ).toBe('openai-chat-deepseek-official')
  })

  it('openai-chat + SiliconFlow baseUrl → openai-chat-siliconflow (gateway-level)', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'Qwen/Qwen3-235B',
        baseUrl: 'https://api.siliconflow.cn/v1',
      }),
    ).toBe('openai-chat-siliconflow')
    // Even DeepSeek-via-SiliconFlow uses the gateway's wire schema:
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-ai/DeepSeek-V4-Flash',
        baseUrl: 'https://api.siliconflow.cn/v1',
      }),
    ).toBe('openai-chat-siliconflow')
  })

  it.each([
    ['国内默认', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['美国（弗吉尼亚）', 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'],
    ['Coding Plan', 'https://coding.dashscope.aliyuncs.com/v1'],
    [
      'Token Plan',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    ],
    [
      '北京 MaaS',
      'https://1234567890.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    ],
    [
      '新加坡 MaaS',
      'https://abc.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    ],
    [
      '法兰克福 MaaS',
      'https://abc.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
    ],
    [
      '东京 MaaS',
      'https://abc.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
    ],
  ])(
    'openai-chat + aliyun DashScope baseUrl variant (%s) → openai-chat-aliyun',
    (_label, baseUrl) => {
      expect(
        inferVendor({
          protocol: 'openai-chat',
          model: 'qwen3.6-plus',
          baseUrl,
        }),
      ).toBe('openai-chat-aliyun')
    },
  )

  it('openai-chat + unrecognized relay baseUrl → undefined (no built-in vendor auto-match)', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://relay.example/v1',
      }),
    ).toBeUndefined()
  })

  it('openai-chat + unknown gateway → undefined (vanilla protocol layer; NO model-name-based vendor inference)', () => {
    // Vendor inference is now gateway-only. DeepSeek V4 quirks live in
    // the model template layer (openai-chat-deepseek-v4p), independent
    // of which vendor resolves. See inferModelTemplate tests below.
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://my-private-relay.example.com/v1',
      }),
    ).toBeUndefined()
  })

  it('openai-chat + DeepSeek versions on unknown gateway → undefined (model-name inference removed)', () => {
    for (const m of [
      'deepseek-v4.1-pro',
      'deepseek-v5',
      'deepseek-v10',
      'deepseek-v100-ultra',
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
      ).toBeUndefined()
    }
  })

  it('openai-chat + non-version model lines that happen to contain "deepseek" + a digit later → undefined', () => {
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
      ).toBeUndefined()
    }
  })

  it('openai-chat + unknown gateway + unknown model → undefined', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'gpt-4o',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBeUndefined()
  })

  it('does not match deepseek-v2 / v3 (older non-reasoning models)', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v2',
        baseUrl: 'https://example.com/v1',
      }),
    ).toBeUndefined()
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v3',
        baseUrl: 'https://example.com/v1',
      }),
    ).toBeUndefined()
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'deepseek-v3.5',
        baseUrl: 'https://example.com/v1',
      }),
    ).toBeUndefined()
  })

  it('Qwen model on a non-aliyun/SiliconFlow gateway → undefined (no name-based inference)', () => {
    // OpenRouter etc. host Qwen but use OpenAI-standard schema.
    // User must explicitly set vendor: 'openai-chat-aliyun' if needed.
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'qwen/qwen3-235b',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBeUndefined()
  })
})

describe('inferModelTemplate', () => {
  it('recommends openai-chat-deepseek-v4p for v4+ DeepSeek model names', () => {
    for (const m of [
      'deepseek-v4-pro',
      'deepseek-v4.1-pro',
      'deepseek-v5',
      'deepseek-v10',
      'deepseek-4',
      'DeepSeek 4.2',
      'deepseek_v100',
    ]) {
      expect(inferModelTemplate(m, undefined, 'openai-chat')).toBe('openai-chat-deepseek-v4p')
    }
  })

  it('does not recommend openai-chat-deepseek-v4p outside openai-chat protocol', () => {
    expect(inferModelTemplate('deepseek-v4-pro', undefined, 'openai-responses')).toBeUndefined()
    expect(inferModelTemplate('deepseek-v4-pro', undefined, 'anthropic')).toBeUndefined()
  })

  it('returns undefined for v3 / v3.5 / non-version DeepSeek names', () => {
    for (const m of [
      'deepseek-v3',
      'deepseek-v3.5',
      'deepseek-r1',
      'deepseek-coder-7b',
      'deepseek-chat',
    ]) {
      expect(inferModelTemplate(m, undefined, undefined)).toBeUndefined()
    }
  })

  it('returns undefined for non-DeepSeek model names', () => {
    expect(inferModelTemplate('gpt-4o', undefined, undefined)).toBeUndefined()
    expect(inferModelTemplate('anthropic-flagship-4', undefined, undefined)).toBeUndefined()
    expect(inferModelTemplate('Qwen3-235B', undefined, undefined)).toBeUndefined()
  })

  it('recommends the built-in DeepSeek template regardless of relay host', () => {
    expect(
      inferModelTemplate(
        'deepseek-v4-pro',
        'openai-chat-deepseek-official',
        'openai-chat',
        undefined,
        'https://relay.example/v1',
      ),
    ).toBe('openai-chat-deepseek-v4p')
    expect(
      inferModelTemplate(
        'deepseek-v4-pro',
        'openai-chat-deepseek-official',
        'openai-chat',
        undefined,
        'https://api.deepseek.com',
      ),
    ).toBe('openai-chat-deepseek-v4p')
  })

  it('returns all matching recommendations in priority order', () => {
    expect(
      getMatchingModelTemplates(
        'deepseek-v4-pro',
        'openai-chat-deepseek-official',
        'openai-chat',
        undefined,
        'https://relay.example/v1',
      ),
    ).toEqual(['openai-chat-deepseek-v4p'])
  })
})

describe('inferVendor — custom matchBaseUrlRegex', () => {
  it('custom vendor with matchBaseUrlRegex auto-matches', () => {
    const customs = {
      'my-private-relay': {
        protocol: 'openai-chat' as const,
        matchBaseUrlRegex: 'relay\\.internal\\.example',
        enabledPatch: { x_relay_token: 'internal' },
      },
    }
    expect(
      inferVendor(
        {
          protocol: 'openai-chat',
          model: 'whatever',
          baseUrl: 'https://relay.internal.example/v1',
        },
        customs,
      ),
    ).toBe('my-private-relay')
  })

  it('custom vendor without matchBaseUrlRegex requires manual pin', () => {
    const customs = {
      'manual-only': {
        protocol: 'openai-chat' as const,
        // No matchBaseUrlRegex — auto-match skips this entry.
        enabledPatch: { x: true },
      },
    }
    expect(
      inferVendor(
        {
          protocol: 'openai-chat',
          model: 'whatever',
          baseUrl: 'https://relay.internal.example/v1',
        },
        customs,
      ),
    ).toBeUndefined()
  })

  it('custom matchBaseUrlRegex wins over built-in on the same host', () => {
    // SiliconFlow normally claims siliconflow.cn — verify a custom can
    // pre-empt the built-in for the same host (custom registry walked first).
    const customs = {
      'my-siliconflow-overlay': {
        extends: 'openai-chat-siliconflow',
        matchBaseUrlRegex: 'siliconflow\\.cn',
      },
    }
    expect(
      inferVendor(
        {
          protocol: 'openai-chat',
          model: 'Qwen3-235B',
          baseUrl: 'https://api.siliconflow.cn/v1',
        },
        customs,
      ),
    ).toBe('my-siliconflow-overlay')
  })
})

describe('inferModelTemplate — matchVendorRegex gate', () => {
  it('model template with matchVendorRegex applies only on matching vendor', () => {
    const customs = {
      'glm-on-siliconflow-quirk': {
        matchModelRegex: 'GLM-5\\.1',
        matchVendorRegex: 'openai-chat-siliconflow',
        enabledPatch: { siliconflow_glm_workaround: true },
      },
    }
    // Match: model and vendor both hit.
    expect(
      inferModelTemplate('Pro/zai-org/GLM-5.1', 'openai-chat-siliconflow', 'openai-chat', customs),
    ).toBe('glm-on-siliconflow-quirk')
    // Miss: same model, different vendor.
    expect(
      inferModelTemplate('Pro/zai-org/GLM-5.1', 'openai-chat-aliyun', 'openai-chat', customs),
    ).toBeUndefined()
    // Miss: different model, matching vendor.
    expect(
      inferModelTemplate('Qwen3-235B', 'openai-chat-siliconflow', 'openai-chat', customs),
    ).toBeUndefined()
  })

  it('model template without matchVendorRegex applies on any vendor', () => {
    // Built-in openai-chat-deepseek-v4p has no matchVendorRegex.
    expect(
      inferModelTemplate('deepseek-v4-pro', 'openai-chat-deepseek-official', 'openai-chat'),
    ).toBe('openai-chat-deepseek-v4p')
    expect(
      inferModelTemplate('deepseek-v4-pro', 'openai-chat-siliconflow', 'openai-chat'),
    ).toBe('openai-chat-deepseek-v4p')
    expect(
      inferModelTemplate('deepseek-v4-pro', 'some-private-vendor', 'openai-chat'),
    ).toBe('openai-chat-deepseek-v4p')
  })
})

describe('resolveStack — model template trichotomy (auto / none / pin)', () => {
  it('auto-applies a matching model template when modelTemplate is omitted (undefined === auto)', () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'openai-chat-deepseek-official',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(t.autoRoundTripReasoningContent).toBe(true)
    expect(t.reasoningRoundTripFormat).toBe('reasoning_content')
  })

  it("'auto' explicitly smart-matches the same way", () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'openai-chat-deepseek-official',
      modelTemplate: 'auto',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(t.autoRoundTripReasoningContent).toBe(true)
  })

  it("'none' opts out of smart-matching even when a template would match", () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'openai-chat-deepseek-official',
      modelTemplate: 'none',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(t.autoRoundTripReasoningContent).toBeUndefined()
    expect(t.reasoningRoundTripFormat).toBeUndefined()
  })

  it('rejects an explicit model template whose protocol mismatches the entry', () => {
    const customModels = {
      'responses-only-quirk': {
        matchModelRegex: 'future-model',
        protocol: 'openai-responses' as const,
        enabledPatch: { responses_specific_field: true },
      },
    }
    expect(() =>
      resolveStack({
        protocol: 'openai-chat',
        vendor: 'openai-chat',
        modelTemplate: 'responses-only-quirk',
        model: 'future-model-pro',
        customModels,
      }),
    ).toThrow(/does not match/)
  })

  it('applies the explicit model template when compatibility gates match', () => {
    const customModels = {
      'chat-only-quirk': {
        matchModelRegex: 'special-model',
        protocol: 'openai-chat' as const,
        enabledPatch: { chat_specific: true },
      },
    }
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'openai-chat',
      modelTemplate: 'chat-only-quirk',
      model: 'special-model-pro',
      customModels,
    })
    expect((t.enabledPatch as Record<string, unknown>)?.chat_specific).toBe(true)
  })
})

describe('resolveStack — vendor trichotomy (auto / none / pin)', () => {
  it('auto-infers a gateway vendor by baseUrl when vendor is omitted (undefined === auto)', () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      model: 'glm-4.7',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    })
    // openai-chat-glm enabledPatch is the GLM thinking switch + Preserved
    // Thinking flag (clear_thinking:false enables coding-agent recommended mode).
    expect(t.enabledPatch).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
  })

  it("'auto' explicitly infers the same gateway", () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'auto',
      model: 'glm-4.7',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    })
    expect(t.enabledPatch).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
  })

  it("'none' skips inference even on a known gateway baseUrl (bare protocol layer)", () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'none',
      model: 'glm-4.7',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    })
    // No vendor enabledPatch — only the protocol layer's reasoning_effort remains.
    expect(t.enabledPatch).toBeUndefined()
    expect(t.protocol).toBe('openai-chat')
  })
})

describe('resolveStack — reasoning round-trip fields merge across layers', () => {
  it('vendor templates may force reasoning replay as an escape hatch', () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'force-replay-gateway',
      model: 'plain-model',
      customVendors: {
        'force-replay-gateway': {
          protocol: 'openai-chat',
          autoRoundTripReasoningContent: true,
          reasoningRoundTripFormat: 'reasoning_content',
        },
      },
    })
    expect(t.autoRoundTripReasoningContent).toBe(true)
    expect(t.reasoningRoundTripFormat).toBe('reasoning_content')
  })

  it('model templates preserve vendor reasoning replay when both set it', () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'force-replay-gateway',
      modelTemplate: 'special-model-official-format',
      model: 'special-model',
      customVendors: {
        'force-replay-gateway': {
          protocol: 'openai-chat',
          autoRoundTripReasoningContent: true,
          reasoningRoundTripFormat: 'reasoning_content',
        },
      },
      customModels: {
        'special-model-official-format': {
          matchModelRegex: 'special-model',
          reasoningRoundTripFormat: 'reasoning_content',
        },
      },
    })
    expect(t.autoRoundTripReasoningContent).toBe(true)
    expect(t.reasoningRoundTripFormat).toBe('reasoning_content')
  })
})

describe('isBuiltinVendor', () => {
  it('recognizes built-in protocol and gateway vendors', () => {
    expect(isBuiltinVendor('openai-chat')).toBe(true)
    expect(isBuiltinVendor('openai-responses')).toBe(true)
    expect(isBuiltinVendor('anthropic')).toBe(true)
    expect(isBuiltinVendor('openai-chat-deepseek-official')).toBe(true)
    expect(isBuiltinVendor('openai-chat-aliyun')).toBe(true)
    expect(isBuiltinVendor('openai-chat-siliconflow')).toBe(true)
  })

  it('rejects unknown names', () => {
    expect(isBuiltinVendor('openai-chat-micu-deepseek')).toBe(false)
    expect(isBuiltinVendor('my-custom')).toBe(false)
    expect(isBuiltinVendor('')).toBe(false)
  })
})

describe('isBuiltinModelTemplate', () => {
  it('recognizes built-in model templates', () => {
    expect(isBuiltinModelTemplate('openai-chat-deepseek-v4p')).toBe(true)
    expect(isBuiltinModelTemplate('openai-chat-micu-deepseek')).toBe(false)
  })
})

describe('resolveTemplate', () => {
  it('returns built-in template by name', () => {
    const t = resolveTemplate('openai-chat')
    expect(t.effort?.patch).toEqual({ reasoning_effort: '<value>' })
  })

  it('throws on unknown name', () => {
    expect(() => resolveTemplate('does-not-exist')).toThrow(/Unknown vendor template/)
  })

  it('applies extends chain (custom extends built-in)', () => {
    const custom: Record<string, VendorTemplate> = {
      'my-deepseek-mod': {
        extends: 'openai-chat-deepseek-official',
        // Override only effort.valueMap (rest inherited)
        effort: {
          patch: { reasoning_effort: '<value>' },
          valueMap: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
        },
      },
    }
    const t = resolveTemplate('my-deepseek-mod', custom)
    // protocol inherited from parent
    expect(t.protocol).toBe('openai-chat')
    // Override exposes low (built-in deepseek-official omits it).
    expect(t.effort?.valueMap?.low).toBe('low')
    // Inherited deepseek thinking switch
    expect(t.enabledPatch).toEqual({ thinking: { type: 'enabled' } })
  })

  it('detects extends cycles', () => {
    const custom: Record<string, VendorTemplate> = {
      a: { extends: 'b' },
      b: { extends: 'a' },
    }
    expect(() => resolveTemplate('a', custom)).toThrow(/cyclic/)
  })

  it('allows a custom template with neither protocol nor extends (vendor-only patches)', () => {
    // Vendor templates with no protocol declaration are valid — they
    // represent API quirks that don't fit any single protocol cleanly,
    // and the user pins them explicitly per model entry. resolveTemplate
    // returns just the vendor patches with no protocol-layer merge.
    const custom: Record<string, VendorTemplate> = {
      'bare-vendor': {
        effort: { patch: { reasoning_effort: '<value>' } },
      },
    }
    const t = resolveTemplate('bare-vendor', custom)
    expect(t.protocol).toBeUndefined()
    expect(t.effort?.patch).toEqual({ reasoning_effort: '<value>' })
  })

  it('inherits protocols from extends chain when child omits it', () => {
    const custom: Record<string, VendorTemplate> = {
      'derived-from-deepseek': {
        extends: 'openai-chat-deepseek-official',
        // no protocol here — inherited from openai-chat-deepseek-official
      },
    }
    const t = resolveTemplate('derived-from-deepseek', custom)
    expect(t.protocol).toBe('openai-chat')
  })

  it("child's explicit protocols override the parent", () => {
    const custom: Record<string, VendorTemplate> = {
      'override-vendor': {
        protocol: 'openai-responses',
        extends: 'openai-chat',
      },
    }
    const t = resolveTemplate('override-vendor', custom)
    expect(t.protocol).toBe('openai-responses')
  })

  it('custom template wins over built-in on name collision', () => {
    const custom: Record<string, VendorTemplate> = {
      'openai-chat': {
        protocol: 'openai-chat',
        effort: { patch: { my_custom_effort: '<value>' } },
      },
    }
    const t = resolveTemplate('openai-chat', custom)
    // After 3-layer refactor, protocol-layer patches merge in too. Custom
    // adds `my_custom_effort`; protocol contributes `reasoning_effort`.
    // Both keys end up in the resolved patch — confirm the custom field
    // is present without asserting exact dict equality.
    expect(t.effort?.patch).toMatchObject({ my_custom_effort: '<value>' })
  })
})

describe('applyThinkingTemplate — built-in: openai-default', () => {
  const template = resolveTemplate('openai-chat')

  it('thinking undefined → empty', () => {
    expect(applyThinkingTemplate(undefined, template)).toEqual({})
  })

  it('thinking enabled maps each axiomate tier to the modern GPT-5.x domain', () => {
    // axiomate's 4 tiers map onto OpenAI's modern reasoning_effort domain with
    // names aligned for low/medium/high and 'max' reaching the real top tier
    // 'xhigh'. 'minimal' is intentionally dropped (it 400s on models that
    // don't support it).
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'low' }, template),
    ).toEqual({ reasoning_effort: 'low' })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'medium' }, template),
    ).toEqual({ reasoning_effort: 'medium' })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'high' }, template),
    ).toEqual({ reasoning_effort: 'high' })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'max' }, template),
    ).toEqual({ reasoning_effort: 'xhigh' })
  })

  it('thinking enabled without effort → empty (no patch fires)', () => {
    expect(applyThinkingTemplate({ enabled: true }, template)).toEqual({})
  })

  it('thinking disabled → empty (no disabledPatch on this vendor)', () => {
    expect(applyThinkingTemplate({ enabled: false, effort: 'high' }, template)).toEqual({})
  })
})

describe('applyThinkingTemplate — built-in: openai-responses (protocol+vendor stack)', () => {
  // openai-responses' enabledPatch (`reasoning.summary: 'auto'`) lives in
  // the PROTOCOL layer now — every openai-responses vendor inherits it.
  // Use resolveStack to include the protocol patches.
  const template = resolveStack({
    protocol: 'openai-responses',
    vendor: 'openai-responses',
    model: 'gpt-5.4',
  })

  it('thinking enabled maps each axiomate level to the modern GPT-5.x Responses domain', () => {
    // axiomate's 4 tiers map onto OpenAI's modern effort domain with names
    // aligned for low/medium/high and 'max' reaching the real top tier
    // 'xhigh'. 'minimal' is intentionally dropped (it 400s on models that
    // don't support it).
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'low' }, template),
    ).toEqual({ reasoning: { effort: 'low', summary: 'auto' } })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'medium' }, template),
    ).toEqual({ reasoning: { effort: 'medium', summary: 'auto' } })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'high' }, template),
    ).toEqual({ reasoning: { effort: 'high', summary: 'auto' } })
    expect(
      applyThinkingTemplate({ enabled: true, effort: 'max' }, template),
    ).toEqual({ reasoning: { effort: 'xhigh', summary: 'auto' } })
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

describe('applyThinkingTemplate — built-in: openai-chat-deepseek-official', () => {
  const template = resolveTemplate('openai-chat-deepseek-official')

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

  // autoRoundTripReasoningContent and reasoningRoundTripFormat are tested
  // through resolveStack because both vendor and model layers may set them.
})

describe('applyThinkingTemplate — built-in: openai-chat-aliyun', () => {
  const template = resolveTemplate('openai-chat-aliyun')

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

describe('applyThinkingTemplate — built-in: openai-chat-siliconflow', () => {
  const template = resolveTemplate('openai-chat-siliconflow')

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

describe('inferVendor — bigmodel.cn / z.ai baseUrls → openai-chat-glm', () => {
  it('matches the domestic general endpoint', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'glm-4.7',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      }),
    ).toBe('openai-chat-glm')
  })

  it('matches the domestic coding-plan endpoint', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'glm-5.2',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      }),
    ).toBe('openai-chat-glm')
  })

  it('matches the international general endpoint (z.ai)', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'glm-4.7',
        baseUrl: 'https://api.z.ai/api/paas/v4',
      }),
    ).toBe('openai-chat-glm')
  })

  it('matches the international coding-plan endpoint (z.ai)', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'glm-5.2',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      }),
    ).toBe('openai-chat-glm')
  })
})

describe('applyThinkingTemplate — built-in: openai-chat-glm (vendor layer only)', () => {
  // Vendor layer carries the thinking switch but nulls out reasoning_effort
  // (GLM-5.2-only). Resolve through resolveStack so the protocol layer's
  // effort patch is present-then-deleted by the vendor null.
  const template = resolveStack({
    protocol: 'openai-chat',
    vendor: 'openai-chat-glm',
    model: 'glm-4.7',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  })

  it('enabled emits thinking switch, but no reasoning_effort even with effort set', () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'high' }, template)).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'max' }, template)).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
  })

  it('disabled → thinking: { type: disabled }', () => {
    expect(applyThinkingTemplate({ enabled: false }, template)).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  it('vendor sets coding-agent-recommended fields: do_sample:false, autoRoundTrip', () => {
    expect(template.extraBodyParams).toEqual({ do_sample: false })
    expect(template.autoRoundTripReasoningContent).toBe(true)
  })
})

describe('applyThinkingTemplate — built-in: openai-chat-glm-5.2 (model layer re-adds effort)', () => {
  const template = resolveStack({
    protocol: 'openai-chat',
    vendor: 'openai-chat-glm',
    modelTemplate: 'openai-chat-glm-5.2',
    model: 'glm-5.2',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  })

  it('low/medium/high all collapse to high; max stays max', () => {
    expect(applyThinkingTemplate({ enabled: true, effort: 'low' }, template)).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high',
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'medium' }, template)).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high',
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'high' }, template)).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high',
    })
    expect(applyThinkingTemplate({ enabled: true, effort: 'max' }, template)).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'max',
    })
  })

  it('enabled without effort still emits thinking switch only', () => {
    expect(applyThinkingTemplate({ enabled: true }, template)).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
  })

  it('disabled → thinking: { type: disabled }', () => {
    expect(applyThinkingTemplate({ enabled: false }, template)).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  it('pins to glm-5.2 only — resolveStack rejects glm-4.7', () => {
    expect(() =>
      resolveStack({
        protocol: 'openai-chat',
        vendor: 'openai-chat-glm',
        modelTemplate: 'openai-chat-glm-5.2',
        model: 'glm-4.7',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      }),
    ).toThrow(/does not match/)
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
  it('only gateway-specific built-ins remain (vanilla protocols are not vendor entries)', () => {
    const builtins = getBuiltinTemplates()
    expect(Object.keys(builtins).sort()).toEqual([
      'openai-chat-aliyun',
      'openai-chat-deepseek-official',
      'openai-chat-glm',
      'openai-chat-moonshot',
      'openai-chat-siliconflow',
    ])
  })

  it('every built-in declares a protocol', () => {
    const builtins = getBuiltinTemplates()
    for (const [name, tpl] of Object.entries(builtins)) {
      expect(tpl.protocol, `${name} should declare a protocol`).toBeDefined()
    }
  })

  it('protocol-to-template mapping is what M1 expects', () => {
    expect(resolveTemplate('anthropic').protocol).toBe('anthropic')
    expect(resolveTemplate('openai-responses').protocol).toBe('openai-responses')
    expect(resolveTemplate('openai-chat').protocol).toBe('openai-chat')
    expect(resolveTemplate('openai-chat-deepseek-official').protocol).toBe(
      'openai-chat',
    )
    expect(resolveTemplate('openai-chat-aliyun').protocol).toBe('openai-chat')
    expect(resolveTemplate('openai-chat-siliconflow').protocol).toBe(
      'openai-chat',
    )
    expect(resolveTemplate('openai-chat-glm').protocol).toBe('openai-chat')
  })

  it('custom relay model templates can carry custom replay shape and thinking switch', () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      modelTemplate: 'my-relay-deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://relay.example/v1',
      customModels: {
        'my-relay-deepseek': {
          matchModelRegex: '\\bdeepseek[\\s\\-_]*v?[\\s\\-_]*(\\d+)',
          matchBaseUrlRegex: 'relay\\.example',
          protocol: 'openai-chat',
          enabledPatch: { thinking: { type: 'enabled' } },
          disabledPatch: { thinking: { type: 'disabled' } },
          effort: {
            valueMap: {
              low: null,
              medium: null,
              high: 'high',
              max: 'max',
            },
          },
          autoRoundTripReasoningContent: true,
          reasoningRoundTripFormat: 'reasoning_content',
        },
      },
    })
    expect(t.enabledPatch).toEqual({ thinking: { type: 'enabled' } })
    expect(t.disabledPatch).toEqual({ thinking: { type: 'disabled' } })
    expect(t.effort?.valueMap).toEqual({
      high: 'high',
      max: 'max',
    })
    expect(t.autoRoundTripReasoningContent).toBe(true)
    expect(t.reasoningRoundTripFormat).toBe('reasoning_content')
  })

  it('official DeepSeek V4 replay shape is explicit model-template behavior', () => {
    const t = resolveStack({
      protocol: 'openai-chat',
      vendor: 'openai-chat-deepseek-official',
      modelTemplate: 'openai-chat-deepseek-v4p',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(t.autoRoundTripReasoningContent).toBe(true)
    expect(t.reasoningRoundTripFormat).toBe('reasoning_content')
  })
})

describe("applyThinkingTemplate — effort: 'none' bypasses enabledPatch/effort/budget", () => {
  it('openai-default with effort=none → empty (no disabledPatch defined; just omit reasoning fields)', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('openai-chat'),
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

  it("openai-chat-deepseek-official with effort=none → { thinking: { type: 'disabled' } }", () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('openai-chat-deepseek-official'),
      ),
    ).toEqual({ thinking: { type: 'disabled' } })
  })

  it('openai-chat-aliyun with effort=none → { enable_thinking: false }', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('openai-chat-aliyun'),
      ),
    ).toEqual({ enable_thinking: false })
  })

  it('openai-chat-siliconflow with effort=none → { enable_thinking: false }', () => {
    expect(
      applyThinkingTemplate(
        { enabled: true, effort: 'none' },
        resolveTemplate('openai-chat-siliconflow'),
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
        resolveTemplate('openai-chat-aliyun'),
      ),
    ).toEqual({ enable_thinking: false })
  })

  it('effort=none with thinking.enabled=false still emits disabledPatch (consistent shape)', () => {
    expect(
      applyThinkingTemplate(
        { enabled: false, effort: 'none' },
        resolveTemplate('openai-chat-siliconflow'),
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
    const tpl = resolveTemplate('openai-chat')
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
    const tpl = resolveTemplate('openai-chat-aliyun')
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
    const tpl = resolveTemplate('openai-chat-aliyun')
    applyThinkingTemplate({ enabled: false, effort: 'none' }, tpl)
    const effortWarnings = mockedLog.mock.calls.filter(c =>
      String(c[0]).includes("effort='"),
    )
    expect(effortWarnings).toHaveLength(0)
  })

  it('does NOT warn when enabled:false and no effort configured', () => {
    mockedLog.mockClear()
    const tpl = resolveTemplate('openai-chat-aliyun')
    applyThinkingTemplate({ enabled: false }, tpl)
    expect(mockedLog).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Moonshot (Kimi) — vendor + per-model wire shapes
//
// Validates the per-model wire encoding documented in vendorTemplates.ts:
//   - vendor `openai-chat-moonshot` provides default {type:'enabled'} /
//     {type:'disabled'} patches plus picker collapsed to None / Max only and
//     no reasoning_effort.
//   - k2.7 forces keep:'all' on enable and null-deletes disabledPatch.
//   - k2.6 forces keep:'all' on enable and inherits disabledPatch.
//   - k2.5 inherits both vendor patches verbatim (no `keep`, no auto round-
//     trip).
// ─────────────────────────────────────────────────────────────────────────────

describe('Moonshot vendor — picker tier collapse + no reasoning_effort', () => {
  it('auto-vendor by api.moonshot.cn baseUrl', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'kimi-k2.7-code',
        baseUrl: 'https://api.moonshot.cn/v1',
      }),
    ).toBe('openai-chat-moonshot')
  })

  it('auto-vendor by api.moonshot.ai baseUrl', () => {
    expect(
      inferVendor({
        protocol: 'openai-chat',
        model: 'kimi-k2.6',
        baseUrl: 'https://api.moonshot.ai/v1',
      }),
    ).toBe('openai-chat-moonshot')
  })

  it('Moonshot picker exposes only None + Max (no Low/Medium/High)', () => {
    // The vendor's effort.valueMap collapses everything except 'max' to null,
    // and resolveTemplate's deepMerge applies RFC 7396 deletion: low/medium/
    // high keys (inherited from the protocol layer) get removed entirely,
    // leaving only 'max' in the merged map. getCyclableEffortLevels therefore
    // reduces to ['none', 'max'].
    const tpl = resolveTemplate('openai-chat-moonshot')
    const valueMap = tpl.effort?.valueMap as Record<string, string | null>
    expect(valueMap).toEqual({ max: 'max' })
  })

  it('Moonshot deletes the inherited reasoning_effort patch', () => {
    // resolveTemplate merges protocol layer ({reasoning_effort:'<value>'})
    // with vendor (effort.patch=null). RFC 7396 null deletes the inherited
    // patch so Kimi requests never carry reasoning_effort.
    const tpl = resolveTemplate('openai-chat-moonshot')
    expect(tpl.effort?.patch).toBeUndefined()
  })
})

describe('kimi-k2.7 — strict enabled+keep, no disabled', () => {
  const tpl = resolveStack({
    protocol: 'openai-chat',
    vendor: 'openai-chat-moonshot',
    modelTemplate: 'openai-chat-kimi-k2.7',
    model: 'kimi-k2.7-code',
    baseUrl: 'https://api.moonshot.cn/v1',
  })

  it('Max (effort=max) → {thinking:{type:enabled, keep:all}}, no reasoning_effort', () => {
    const out = applyThinkingTemplate({ enabled: true, effort: 'max' }, tpl)
    expect(out).toEqual({ thinking: { type: 'enabled', keep: 'all' } })
  })

  it('None (effort=none) → empty patch (k2.7 always-on; never send type=disabled)', () => {
    // disabledPatch is RFC 7396 null-deleted in the model template, so the
    // 'none' branch in applyThinkingTemplate emits no patches at all.
    const out = applyThinkingTemplate({ enabled: true, effort: 'none' }, tpl)
    expect(out).toEqual({})
  })

  it('autoRoundTripReasoningContent is true (mandatory for k2.7)', () => {
    expect(tpl.autoRoundTripReasoningContent).toBe(true)
  })

  it('matchModelRegex covers both -code and -code-highspeed variants', () => {
    expect(
      getMatchingModelTemplates(
        'kimi-k2.7-code',
        'openai-chat-moonshot',
        'openai-chat',
        undefined,
        'https://api.moonshot.cn/v1',
      ),
    ).toContain('openai-chat-kimi-k2.7')
    expect(
      getMatchingModelTemplates(
        'kimi-k2.7-code-highspeed',
        'openai-chat-moonshot',
        'openai-chat',
        undefined,
        'https://api.moonshot.cn/v1',
      ),
    ).toContain('openai-chat-kimi-k2.7')
  })
})

describe('kimi-k2.6 — enabled+keep on Max, inherited disabled on None', () => {
  const tpl = resolveStack({
    protocol: 'openai-chat',
    vendor: 'openai-chat-moonshot',
    modelTemplate: 'openai-chat-kimi-k2.6',
    model: 'kimi-k2.6',
    baseUrl: 'https://api.moonshot.cn/v1',
  })

  it('Max → {thinking:{type:enabled, keep:all}} (eager Preserved Thinking)', () => {
    const out = applyThinkingTemplate({ enabled: true, effort: 'max' }, tpl)
    expect(out).toEqual({ thinking: { type: 'enabled', keep: 'all' } })
  })

  it('None → {thinking:{type:disabled}} (inherited from vendor)', () => {
    const out = applyThinkingTemplate({ enabled: true, effort: 'none' }, tpl)
    expect(out).toEqual({ thinking: { type: 'disabled' } })
  })

  it('autoRoundTripReasoningContent is true (recommended whenever keep:all)', () => {
    expect(tpl.autoRoundTripReasoningContent).toBe(true)
  })
})

describe('kimi-k2.5 — inherits vendor verbatim, no keep, no roundtrip', () => {
  const tpl = resolveStack({
    protocol: 'openai-chat',
    vendor: 'openai-chat-moonshot',
    modelTemplate: 'openai-chat-kimi-k2.5',
    model: 'kimi-k2.5',
    baseUrl: 'https://api.moonshot.cn/v1',
  })

  it('Max → {thinking:{type:enabled}} (no keep field; k2.5 errors on keep)', () => {
    const out = applyThinkingTemplate({ enabled: true, effort: 'max' }, tpl)
    expect(out).toEqual({ thinking: { type: 'enabled' } })
  })

  it('None → {thinking:{type:disabled}} (inherited from vendor)', () => {
    const out = applyThinkingTemplate({ enabled: true, effort: 'none' }, tpl)
    expect(out).toEqual({ thinking: { type: 'disabled' } })
  })

  it('autoRoundTripReasoningContent defaults false (no Preserved Thinking)', () => {
    // Per docs k2.5 has no Preserved Thinking; the model template intentionally
    // omits the field so the openai-chat default (false) wins.
    expect(tpl.autoRoundTripReasoningContent ?? false).toBe(false)
  })
})

describe('Kimi model templates are gated to the Moonshot vendor', () => {
  // matchVendorRegex='^openai-chat-moonshot$' on every Kimi model template
  // ensures that the same model name reached via OpenRouter / aliyun /
  // SiliconFlow does NOT auto-apply Moonshot-specific quirks (keep, strict
  // enabled-only, etc.). Those gateways have their own thinking shapes.
  it.each([
    ['kimi-k2.7-code', 'openai-chat-aliyun'],
    ['kimi-k2.7-code-highspeed', 'openai-chat-siliconflow'],
    ['kimi-k2.6', 'openai-chat-aliyun'],
    ['kimi-k2.5', 'openai-chat-siliconflow'],
  ])(
    '%s on %s does NOT auto-match a Moonshot model template',
    (model, vendor) => {
      const matches = getMatchingModelTemplates(
        model,
        vendor,
        'openai-chat',
        undefined,
        'https://example.invalid/v1',
      )
      expect(matches.filter(name => name.startsWith('openai-chat-kimi-'))).toEqual([])
    },
  )

  it('Kimi templates are recognized as built-ins', () => {
    expect(isBuiltinModelTemplate('openai-chat-kimi-k2.7')).toBe(true)
    expect(isBuiltinModelTemplate('openai-chat-kimi-k2.6')).toBe(true)
    expect(isBuiltinModelTemplate('openai-chat-kimi-k2.5')).toBe(true)
  })

  it('Moonshot vendor is recognized as built-in', () => {
    expect(isBuiltinVendor('openai-chat-moonshot')).toBe(true)
  })
})

describe('resolveStack — maxOutputTokensField', () => {
  // Wire field name for the output-token cap on OpenAI Chat bodies. Default
  // is 'max_tokens' (set at the openai-chat protocol layer); vendors whose
  // upstream gateway deprecated max_tokens override to 'max_completion_tokens'.

  it('vanilla openai-chat (no vendor) inherits max_tokens from protocol layer', () => {
    const resolved = resolveStack({
      protocol: 'openai-chat',
      vendor: 'none',
      model: 'gpt-4o',
    })
    expect(resolved.maxOutputTokensField).toBe('max_tokens')
  })

  it('openai-chat + auto-matched openai-chat-deepseek-official keeps max_tokens (DeepSeek docs unchanged)', () => {
    const resolved = resolveStack({
      protocol: 'openai-chat',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
    })
    expect(resolved.maxOutputTokensField).toBe('max_tokens')
  })

  it('openai-chat + auto-matched openai-chat-moonshot uses max_completion_tokens', () => {
    const resolved = resolveStack({
      protocol: 'openai-chat',
      model: 'kimi-k2.6',
      baseUrl: 'https://api.moonshot.cn/v1',
    })
    expect(resolved.maxOutputTokensField).toBe('max_completion_tokens')
  })

  it('openai-chat + auto-matched openai-chat-aliyun uses max_completion_tokens', () => {
    const resolved = resolveStack({
      protocol: 'openai-chat',
      model: 'qwen-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })
    expect(resolved.maxOutputTokensField).toBe('max_completion_tokens')
  })

  it('openai-chat + siliconflow keeps max_tokens (no override at vendor)', () => {
    const resolved = resolveStack({
      protocol: 'openai-chat',
      model: 'qwen-plus',
      baseUrl: 'https://api.siliconflow.cn/v1',
    })
    expect(resolved.maxOutputTokensField).toBe('max_tokens')
  })

  it('custom vendor extending openai-chat-moonshot can null-delete to revert max_tokens', () => {
    // RFC 7396 escape hatch: a private relay that re-exposes Kimi but only
    // accepts max_tokens can extend the built-in vendor and null-delete the
    // overridden field, falling back to the protocol-layer default.
    const customVendors = {
      'my-kimi-relay': {
        extends: 'openai-chat-moonshot',
        maxOutputTokensField: null,
      } as VendorTemplate,
    }
    const resolved = resolveStack({
      protocol: 'openai-chat',
      vendor: 'my-kimi-relay',
      model: 'kimi-k2.6',
      customVendors,
    })
    expect(resolved.maxOutputTokensField).toBe('max_tokens')
  })
})
