import { describe, expect, it } from 'vitest'

import { DEFAULT_GLOBAL_CONFIG, getGlobalConfig, saveGlobalConfig } from '../utils/config.js'

describe('visionLocateEnabled global config', () => {
  it('defaults to disabled', () => {
    expect(DEFAULT_GLOBAL_CONFIG.visionLocateEnabled).toBe(false)
    expect(getGlobalConfig().visionLocateEnabled).toBe(false)
  })

  it('persists through saveGlobalConfig in test mode', () => {
    saveGlobalConfig(current => ({ ...current, visionLocateEnabled: true }))
    expect(getGlobalConfig().visionLocateEnabled).toBe(true)

    saveGlobalConfig(current => ({ ...current, visionLocateEnabled: false }))
    expect(getGlobalConfig().visionLocateEnabled).toBe(false)
  })
})
