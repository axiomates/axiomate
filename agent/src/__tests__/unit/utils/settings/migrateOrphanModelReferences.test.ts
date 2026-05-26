import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mockGetGlobalConfig = vi.hoisted(() => vi.fn())
const mockSaveGlobalConfig = vi.hoisted(() => vi.fn())
const mockGetSettings = vi.hoisted(() => vi.fn())
const mockUpdateSettings = vi.hoisted(() => vi.fn())
const mockLogForDebugging = vi.hoisted(() => vi.fn())

vi.mock('../../../../utils/config.js', () => ({
  getGlobalConfig: mockGetGlobalConfig,
  saveGlobalConfig: mockSaveGlobalConfig,
}))
vi.mock('../../../../utils/settings/settings.js', () => ({
  getSettingsForSource: mockGetSettings,
  updateSettingsForSource: mockUpdateSettings,
}))
vi.mock('../../../../utils/debug.js', () => ({
  logForDebugging: mockLogForDebugging,
}))

import { migrateOrphanModelReferences } from '../../../../utils/settings/migrateOrphanModelReferences.js'

describe('migrateOrphanModelReferences', () => {
  beforeEach(() => {
    mockGetGlobalConfig.mockReset()
    mockSaveGlobalConfig.mockReset()
    mockGetSettings.mockReset()
    mockUpdateSettings.mockReset()
    mockLogForDebugging.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('heals dangling currentModel by reassigning to first valid model', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: { 'gpt-5.4': {}, 'claude-opus-4': {} },
      currentModel: 'deleted-model',
    })
    mockGetSettings.mockReturnValue({})
    migrateOrphanModelReferences()
    expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1)
    const updater = mockSaveGlobalConfig.mock.calls[0]![0]
    const next = updater({
      models: { 'gpt-5.4': {}, 'claude-opus-4': {} },
      currentModel: 'deleted-model',
    })
    expect(next.currentModel).toBe('gpt-5.4')
    expect(mockLogForDebugging).toHaveBeenCalled()
  })

  test('does not touch currentModel when it points at a valid model', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: { 'gpt-5.4': {} },
      currentModel: 'gpt-5.4',
    })
    mockGetSettings.mockReturnValue({})
    migrateOrphanModelReferences()
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled()
  })

  test("does not heal currentModel when no models exist (let original error fire)", () => {
    mockGetGlobalConfig.mockReturnValue({
      models: {},
      currentModel: 'deleted',
    })
    mockGetSettings.mockReturnValue({})
    migrateOrphanModelReferences()
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled()
    expect(mockLogForDebugging).not.toHaveBeenCalled()
  })

  test('clears fastModel and midModel when they reference deleted models', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: { 'gpt-5.4': {} },
      currentModel: 'gpt-5.4',
      fastModel: 'gone-1',
      midModel: 'gone-2',
    })
    mockGetSettings.mockReturnValue({})
    migrateOrphanModelReferences()
    expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1)
    const updater = mockSaveGlobalConfig.mock.calls[0]![0]
    const next = updater({
      models: { 'gpt-5.4': {} },
      currentModel: 'gpt-5.4',
      fastModel: 'gone-1',
      midModel: 'gone-2',
    })
    expect(next.fastModel).toBeUndefined()
    expect(next.midModel).toBeUndefined()
  })

  test('prunes orphan settings.effortByModel entries', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: { 'gpt-5.4': {} },
      currentModel: 'gpt-5.4',
    })
    mockGetSettings.mockReturnValue({
      effortByModel: {
        'gpt-5.4': 'high',
        'deleted-model': 'max',
        'another-gone': 'medium',
      },
    })
    migrateOrphanModelReferences()
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    const [, updated] = mockUpdateSettings.mock.calls[0]!
    expect(updated.effortByModel).toEqual({ 'gpt-5.4': 'high' })
  })

  test('clears settings.model when it references a deleted model', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: { 'gpt-5.4': {} },
      currentModel: 'gpt-5.4',
    })
    mockGetSettings.mockReturnValue({
      model: 'deleted-model',
    })
    migrateOrphanModelReferences()
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    const [, updated] = mockUpdateSettings.mock.calls[0]!
    expect(updated.model).toBeUndefined()
  })

  test('no-op when everything is consistent', () => {
    mockGetGlobalConfig.mockReturnValue({
      models: { 'gpt-5.4': {} },
      currentModel: 'gpt-5.4',
      fastModel: 'gpt-5.4',
    })
    mockGetSettings.mockReturnValue({
      model: 'gpt-5.4',
      effortByModel: { 'gpt-5.4': 'high' },
    })
    migrateOrphanModelReferences()
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled()
    expect(mockUpdateSettings).not.toHaveBeenCalled()
  })

  test('handles a fresh-start config (no models, no settings)', () => {
    mockGetGlobalConfig.mockReturnValue({})
    mockGetSettings.mockReturnValue(null)
    expect(() => migrateOrphanModelReferences()).not.toThrow()
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled()
    expect(mockUpdateSettings).not.toHaveBeenCalled()
  })
})
