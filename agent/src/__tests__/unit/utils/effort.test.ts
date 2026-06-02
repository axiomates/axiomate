import { afterEach, describe, expect, test, vi } from 'vitest'

const mockGetGlobalConfig = vi.hoisted(() =>
  vi.fn(
    (): { models?: any; templates?: any } => ({ models: undefined }),
  ),
)

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: mockGetGlobalConfig,
}))

import {
  EFFORT_LEVELS,
  getCyclableEffortLevels,
  getDefaultEffortForModel,
  isEffortLevel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  resolveAppliedEffort,
  toPersistableEffort,
} from '../../../utils/effort.js'
import { getModelCapabilityOverride } from '../../../utils/model/modelSupportOverrides.js'

const originalCapabilityOverrides =
  process.env.AXIOMATE_MODEL_CAPABILITY_OVERRIDES
const originalAlwaysEnableEffort =
  process.env.AXIOMATE_CODE_ALWAYS_ENABLE_EFFORT

describe('effort levels', () => {
  test("EFFORT_LEVELS includes 'none' as the first entry", () => {
    expect(EFFORT_LEVELS).toEqual(['none', 'low', 'medium', 'high', 'max'])
  })

  test("isEffortLevel accepts 'none' alongside the other 4 levels", () => {
    for (const level of ['none', 'low', 'medium', 'high', 'max']) {
      expect(isEffortLevel(level)).toBe(true)
    }
    expect(isEffortLevel('extreme')).toBe(false)
    expect(isEffortLevel('off')).toBe(false)
    expect(isEffortLevel(undefined)).toBe(false)
  })

  test('toPersistableEffort filters none and unknown values', () => {
    expect(toPersistableEffort('low')).toBe('low')
    expect(toPersistableEffort('medium')).toBe('medium')
    expect(toPersistableEffort('high')).toBe('high')
    expect(toPersistableEffort('max')).toBe('max')
    expect(toPersistableEffort('none')).toBeUndefined()
    expect(toPersistableEffort(undefined)).toBeUndefined()
  })
})

afterEach(() => {
  mockGetGlobalConfig.mockReturnValue({ models: undefined })
  getModelCapabilityOverride.cache?.clear?.()

  if (originalCapabilityOverrides === undefined) {
    delete process.env.AXIOMATE_MODEL_CAPABILITY_OVERRIDES
  } else {
    process.env.AXIOMATE_MODEL_CAPABILITY_OVERRIDES =
      originalCapabilityOverrides
  }

  if (originalAlwaysEnableEffort === undefined) {
    delete process.env.AXIOMATE_CODE_ALWAYS_ENABLE_EFFORT
  } else {
    process.env.AXIOMATE_CODE_ALWAYS_ENABLE_EFFORT =
      originalAlwaysEnableEffort
  }
})

describe('effort capability support', () => {
  test('configured effort enables effort support and supplies the default', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        custom: {
          protocol: 'openai-chat',
          thinking: { enabled: true, effort: 'medium' },
        },
      },
    })

    expect(modelSupportsEffort('custom')).toBe(true)
    // Any effort-capable model can be cranked to max — the vendor template's
    // valueMap remaps if the wire format doesn't accept literal 'max'.
    expect(modelSupportsMaxEffort('custom')).toBe(true)
    expect(getDefaultEffortForModel('custom')).toBe('medium')
  })

  test('configured max effort opts the model into max effort', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        custom: {
          protocol: 'openai-chat',
          thinking: { enabled: true, effort: 'max' },
        },
      },
    })

    expect(modelSupportsEffort('custom')).toBe(true)
    expect(modelSupportsMaxEffort('custom')).toBe(true)
    expect(resolveAppliedEffort('custom', { custom: 'max' })).toBe('max')
  })

  test('unconfigured models need an explicit capability override', () => {
    expect(modelSupportsEffort('provider-model')).toBe(false)
    expect(modelSupportsMaxEffort('provider-model')).toBe(false)
    expect(resolveAppliedEffort('provider-model', { 'provider-model': 'max' })).toBe('high')
  })

  test('model capability override enables effort and max effort', () => {
    process.env.AXIOMATE_MODEL_CAPABILITY_OVERRIDES = JSON.stringify({
      'provider-model': ['effort', 'max_effort'],
    })
    getModelCapabilityOverride.cache?.clear?.()

    expect(modelSupportsEffort('provider-model')).toBe(true)
    expect(modelSupportsMaxEffort('provider-model')).toBe(true)
    expect(resolveAppliedEffort('provider-model', { 'provider-model': 'max' })).toBe('max')
  })

  test("resolveAppliedEffort reads the focused model's entry from the dict", () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m1: {
          protocol: 'openai-chat',
          thinking: { enabled: true, effort: 'low' },
        },
        m2: {
          protocol: 'openai-chat',
          thinking: { enabled: true, effort: 'medium' },
        },
      },
    })
    expect(
      resolveAppliedEffort('m1', { m1: 'high', m2: 'max' }),
    ).toBe('high')
    expect(
      resolveAppliedEffort('m2', { m1: 'high', m2: 'max' }),
    ).toBe('max')
  })

  test('resolveAppliedEffort falls back to model default when dict has no entry', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m1: { thinking: { enabled: true, effort: 'low' } },
      },
    })
    expect(resolveAppliedEffort('m1', { m2: 'max' })).toBe('low')
    expect(resolveAppliedEffort('m1', undefined)).toBe('low')
  })
})

describe('getCyclableEffortLevels', () => {
  test('unconfigured model with no thinking → []', () => {
    expect(getCyclableEffortLevels('whatever')).toEqual([])
  })

  test('anthropic protocol → none/low/medium/high (no max — anthropic valueMap omits it)', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m: {
          protocol: 'anthropic',
          model: 'claude-opus-4',
          thinking: { enabled: true, effort: 'high' },
        },
      },
    })
    expect(getCyclableEffortLevels('m')).toEqual(['none', 'low', 'medium', 'high'])
    // modelSupportsMaxEffort agrees.
    expect(modelSupportsMaxEffort('m')).toBe(false)
  })

  test('deepseek-v4 model on unknown gateway → all 5 tiers (model name no longer infers vendor)', () => {
    // Vendor inference is gateway-only in the 3-layer DSL — DeepSeek V4
    // quirks (autoRoundTripReasoningContent) live in the model template
    // layer instead. Without an explicit baseUrl matching deepseek's
    // host, we resolve to the openai-chat protocol layer, which keeps all
    // four effort tiers plus the runtime "none" off-switch.
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m: {
          protocol: 'openai-chat',
          model: 'deepseek-v4-pro',
          baseUrl: 'https://relay.example.com/v1',
          thinking: { enabled: true, effort: 'high' },
        },
      },
    })
    expect(getCyclableEffortLevels('m')).toEqual(['none', 'low', 'medium', 'high', 'max'])
    expect(modelSupportsMaxEffort('m')).toBe(true)
  })

  test('SiliconFlow gateway → none/high/max', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m: {
          protocol: 'openai-chat',
          model: 'Qwen/Qwen3-235B',
          baseUrl: 'https://api.siliconflow.cn/v1',
          thinking: { enabled: true, effort: 'high' },
        },
      },
    })
    expect(getCyclableEffortLevels('m')).toEqual(['none', 'high', 'max'])
  })

  test('aliyun DashScope gateway → none/high/max', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m: {
          protocol: 'openai-chat',
          model: 'qwen-max',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          thinking: { enabled: true, effort: 'high' },
        },
      },
    })
    expect(getCyclableEffortLevels('m')).toEqual(['none', 'high', 'max'])
  })

  test('openai-default fallback (unknown gateway, plain model) → all 5 tiers', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m: {
          protocol: 'openai-chat',
          model: 'gpt-4o',
          baseUrl: 'https://openrouter.ai/api/v1',
          thinking: { enabled: true, effort: 'high' },
        },
      },
    })
    expect(getCyclableEffortLevels('m')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  test('custom template extending built-in with partial valueMap is honored', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m: {
          protocol: 'openai-chat',
          model: 'custom-model',
          vendor: 'my-vendor',
          thinking: { enabled: true, effort: 'high' },
        },
      },
      templates: {
        'my-vendor': {
          protocol: 'openai-chat',
          effort: {
            // RFC 7396: null entries delete tiers inherited from the
            // openai-chat protocol layer (which provides all 4).
            valueMap: { low: null, medium: 'medium', high: 'high', max: null },
          },
        },
      },
    })
    expect(getCyclableEffortLevels('m')).toEqual(['none', 'medium', 'high'])
  })

  test('custom template with valueMap omitted → all 5 tiers (back-compat)', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {
        m: {
          protocol: 'openai-chat',
          model: 'custom-model',
          vendor: 'my-bare-vendor',
          thinking: { enabled: true, effort: 'high' },
        },
      },
      templates: {
        'my-bare-vendor': {
          protocol: 'openai-chat',
          effort: { patch: { reasoning_effort: '<value>' } },
        },
      },
    })
    expect(getCyclableEffortLevels('m')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  test('capability-override-only model (no ModelProviderConfig) → legacy fallback', () => {
    process.env.AXIOMATE_MODEL_CAPABILITY_OVERRIDES = JSON.stringify({
      'override-only': ['effort', 'max_effort'],
    })
    getModelCapabilityOverride.cache?.clear?.()
    expect(getCyclableEffortLevels('override-only')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'max',
    ])
  })
})
