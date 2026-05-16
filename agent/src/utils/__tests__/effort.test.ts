import { afterEach, describe, expect, test, vi } from 'vitest'

const mockGetGlobalConfig = vi.hoisted(() =>
  vi.fn(() => ({ models: undefined })),
)

vi.mock('../config.js', () => ({
  getGlobalConfig: mockGetGlobalConfig,
}))

import {
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  resolveAppliedEffort,
} from '../effort.js'
import { getModelCapabilityOverride } from '../model/modelSupportOverrides.js'

const originalCapabilityOverrides =
  process.env.AXIOMATE_MODEL_CAPABILITY_OVERRIDES
const originalAlwaysEnableEffort =
  process.env.AXIOMATE_CODE_ALWAYS_ENABLE_EFFORT

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
          thinking: { enabled: true, effort: 'max' },
        },
      },
    })

    expect(modelSupportsEffort('custom')).toBe(true)
    expect(modelSupportsMaxEffort('custom')).toBe(true)
    expect(resolveAppliedEffort('custom', 'max')).toBe('max')
  })

  test('unconfigured models need an explicit capability override', () => {
    expect(modelSupportsEffort('provider-model')).toBe(false)
    expect(modelSupportsMaxEffort('provider-model')).toBe(false)
    expect(resolveAppliedEffort('provider-model', 'max')).toBe('high')
  })

  test('model capability override enables effort and max effort', () => {
    process.env.AXIOMATE_MODEL_CAPABILITY_OVERRIDES = JSON.stringify({
      'provider-model': ['effort', 'max_effort'],
    })
    getModelCapabilityOverride.cache?.clear?.()

    expect(modelSupportsEffort('provider-model')).toBe(true)
    expect(modelSupportsMaxEffort('provider-model')).toBe(true)
    expect(resolveAppliedEffort('provider-model', 'max')).toBe('max')
  })
})
