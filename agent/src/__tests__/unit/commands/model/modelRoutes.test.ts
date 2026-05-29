import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockGetGlobalConfig = vi.hoisted(() => vi.fn())
const mockSaveGlobalConfig = vi.hoisted(() => vi.fn())

vi.mock('../../../../utils/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../utils/config.js')>()
  return {
    ...actual,
    getGlobalConfig: mockGetGlobalConfig,
    saveGlobalConfig: mockSaveGlobalConfig,
  }
})

import type { GlobalConfig, ModelProviderConfig } from '../../../../utils/config.js'
import { handleModelRouteCommand } from '../../../../commands/model/modelRoutes.js'

const model = (id: string): ModelProviderConfig => ({
  model: id,
  protocol: 'openai-chat',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
})

const baseConfig = (): GlobalConfig =>
  ({
    models: {
      main: model('main'),
      backup: model('backup'),
      fast: model('fast'),
    },
    model: {
      defaultRoute: 'default',
      routes: {
        default: {
          primary: 'main',
          fallbackChain: ['backup'],
        },
        cheap: {
          primary: 'fast',
          fallbackChain: [],
        },
      },
    },
    auxiliary: {
      goalJudge: {
        primary: 'backup',
        fallbackChain: ['main'],
      },
    },
  }) as unknown as GlobalConfig

function savedConfig(): GlobalConfig {
  expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1)
  return mockSaveGlobalConfig.mock.calls[0]![0](mockGetGlobalConfig())
}

function savedConfigAt(index: number): GlobalConfig {
  return mockSaveGlobalConfig.mock.calls[index]![0](mockGetGlobalConfig())
}

describe('model route commands', () => {
  beforeEach(() => {
    mockGetGlobalConfig.mockReset()
    mockSaveGlobalConfig.mockReset()
    mockGetGlobalConfig.mockReturnValue(baseConfig())
  })

  test('lists routes', () => {
    const result = handleModelRouteCommand('route list')
    expect(result).toMatchObject({ handled: true })
    expect(result.handled && result.message).toContain(
      'Model routes (* = default):',
    )
    expect(result.handled && result.message).toContain('* default')
    expect(result.handled && result.message).toContain('    primary: main')
    expect(result.handled && result.message).toContain('    fallback 1: backup')
    expect(result.handled && result.message).toContain('  cheap')
    expect(result.handled && result.message).toContain('    primary: fast')
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled()
  })

  test('switches active route and reports its primary as active model', () => {
    const result = handleModelRouteCommand('route cheap')
    expect(result).toMatchObject({
      handled: true,
      activeModel: 'fast',
    })
    expect(savedConfig().model?.defaultRoute).toBe('cheap')
  })

  test('shows a single route with policy fields', () => {
    const result = handleModelRouteCommand('route show default')
    expect(result).toMatchObject({ handled: true })
    expect(result.handled && result.message).toContain('Route default:')
    expect(result.handled && result.message).toContain('chain: main -> backup')
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled()
  })

  test('creates, renames, deletes, and edits route policy', () => {
    let result = handleModelRouteCommand('route create burst fast')
    expect(result).toMatchObject({
      handled: true,
      message: 'Created route burst with primary fast',
    })
    const withBurst = savedConfig()
    expect(withBurst.model?.routes?.burst.primary).toBe('fast')

    mockSaveGlobalConfig.mockReset()
    mockGetGlobalConfig.mockReturnValue(withBurst)
    result = handleModelRouteCommand('route rename burst cheaper')
    expect(result).toMatchObject({
      handled: true,
      message: 'Renamed route burst to cheaper',
    })
    const renamed = savedConfig()
    expect(renamed.model?.routes?.burst).toBeUndefined()
    expect(renamed.model?.routes?.cheaper.primary).toBe('fast')

    mockSaveGlobalConfig.mockReset()
    mockGetGlobalConfig.mockReturnValue(renamed)
    result = handleModelRouteCommand(
      'route policy cheaper switchModelOn rate_limit,timeout',
    )
    expect(result).toMatchObject({
      handled: true,
      activeModel: 'fast',
    })
    const policyEdited = savedConfig()
    expect(policyEdited.model?.routes?.cheaper.switchModelOn).toEqual([
      'rate_limit',
      'timeout',
    ])

    mockSaveGlobalConfig.mockReset()
    mockGetGlobalConfig.mockReturnValue(policyEdited)
    result = handleModelRouteCommand('route delete cheaper')
    expect(result).toMatchObject({
      handled: true,
      message: 'Deleted route cheaper',
    })
    expect(savedConfig().model?.routes?.cheaper).toBeUndefined()
  })

  test('sets current default route primary via /model use', () => {
    const result = handleModelRouteCommand('use fast')
    expect(result).toMatchObject({
      handled: true,
      activeModel: 'fast',
    })
    expect(savedConfig().model?.routes?.default.primary).toBe('fast')
  })

  test('adds and removes fallback entries on the active route', () => {
    let result = handleModelRouteCommand('fallback add fast')
    expect(result).toMatchObject({ handled: true, activeModel: 'main' })
    const withFast = savedConfig()
    expect(withFast.model?.routes?.default.fallbackChain).toEqual([
      'backup',
      'fast',
    ])

    mockSaveGlobalConfig.mockReset()
    mockGetGlobalConfig.mockReturnValue(withFast)
    result = handleModelRouteCommand('fallback remove backup')
    expect(result).toMatchObject({ handled: true, activeModel: 'main' })
    expect(savedConfigAt(0).model?.routes?.default.fallbackChain).toEqual([
      'fast',
    ])
  })

  test('sets auxiliary task primary', () => {
    const result = handleModelRouteCommand('aux set goalJudge fast')
    expect(result).toMatchObject({
      handled: true,
      message: 'Set auxiliary goalJudge primary to fast',
    })
    expect(savedConfig().auxiliary?.goalJudge.primary).toBe('fast')
  })

  test('edits auxiliary fallback and policy fields', () => {
    let result = handleModelRouteCommand('aux fallback add goalJudge fast')
    expect(result).toMatchObject({
      handled: true,
      message: 'Added fast to auxiliary goalJudge fallback chain',
    })
    const withFallback = savedConfig()
    expect(withFallback.auxiliary?.goalJudge.fallbackChain).toEqual([
      'main',
      'fast',
    ])

    mockSaveGlobalConfig.mockReset()
    mockGetGlobalConfig.mockReturnValue(withFallback)
    result = handleModelRouteCommand('aux policy goalJudge timeoutMs 45000')
    expect(result).toMatchObject({
      handled: true,
      message: 'Set auxiliary goalJudge timeoutMs to 45000',
    })
    const timeoutEdited = savedConfig()
    expect(timeoutEdited.auxiliary?.goalJudge.timeoutMs).toBe(45000)

    mockSaveGlobalConfig.mockReset()
    mockGetGlobalConfig.mockReturnValue(timeoutEdited)
    result = handleModelRouteCommand('aux fallback remove goalJudge main')
    expect(result).toMatchObject({
      handled: true,
      message: 'Removed main from auxiliary goalJudge fallback chain',
    })
    expect(savedConfig().auxiliary?.goalJudge.fallbackChain).toEqual(['fast'])
  })

  test('rejects invalid route policy values through final config validation', () => {
    const result = handleModelRouteCommand(
      'route policy default switchModelOn retry_anything',
    )
    expect(result).toMatchObject({ handled: true })
    expect(result.handled && result.message).toContain(
      'Invalid model routing config',
    )
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled()
  })

  test('returns handled false for bare model arguments', () => {
    expect(handleModelRouteCommand('main')).toEqual({ handled: false })
  })
})
