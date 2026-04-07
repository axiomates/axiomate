import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock getGlobalConfig to control models configuration
const mockGlobalConfig = vi.fn()
vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => mockGlobalConfig(),
}))

// Mock transitive deps of providerRegistry (it imports AnthropicProvider)
vi.mock('../../../services/analytics/index.js', () => ({ logEvent: vi.fn() }))
vi.mock('../withRetry.js', () => ({
  withRetry: vi.fn(async function* (_getClient: any, operation: any, options: any) {
    const client = await _getClient()
    const result = await operation(client, 1, { model: options.model, thinkingConfig: options.thinkingConfig, fastMode: options.fastMode })
    return result
  }),
  CannotRetryError: class extends Error {},
}))
vi.mock('../../../utils/diagLogs.js', () => ({ logForDiagnosticsNoPII: vi.fn() }))
vi.mock('../../../utils/betas.js', () => ({ getModelBetas: vi.fn().mockReturnValue([]) }))
vi.mock('../../../utils/model/model.js', () => ({
  getSmallFastModel: vi.fn().mockReturnValue('claude-haiku-4-5-20251001'),
  normalizeModelStringForAPI: vi.fn((m: string) => m),
}))
vi.mock('../claude.js', () => ({
  getAPIMetadata: vi.fn().mockReturnValue({}),
  getExtraBodyParams: vi.fn().mockReturnValue({}),
  adjustParamsForNonStreaming: vi.fn((p: any) => p),
  MAX_NON_STREAMING_TOKENS: 64000,
}))
vi.mock('../../../utils/log.js', () => ({ logError: vi.fn() }))
vi.mock('../../../utils/modelCost.js', () => ({ calculateUSDCost: vi.fn().mockReturnValue(0) }))

import { getProviderForModel, clearProviderCache } from '../providerRegistry.js'

describe('providerRegistry', () => {
  beforeEach(() => {
    clearProviderCache()
  })

  it('throws when model is not configured', () => {
    mockGlobalConfig.mockReturnValue({ models: undefined })
    expect(() => getProviderForModel('unknown-model')).toThrow(
      /not configured/,
    )
  })

  it('throws when models exists but model is missing', () => {
    mockGlobalConfig.mockReturnValue({ models: {} })
    expect(() => getProviderForModel('missing-model')).toThrow(
      /not configured/,
    )
  })

  it('returns AnthropicProvider for protocol: anthropic', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'claude-sonnet-4-6': {
          model: 'claude-sonnet-4-6',
          protocol: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant-test',
        },
      },
    })
    const provider = getProviderForModel('claude-sonnet-4-6')
    expect(provider.name).toBe('anthropic')
  })

  it('caches providers by protocol:baseUrl', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'model-a': {
          model: 'model-a',
          protocol: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant-test',
        },
        'model-b': {
          model: 'model-b',
          protocol: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant-test',
        },
      },
    })
    const a = getProviderForModel('model-a')
    const b = getProviderForModel('model-b')
    expect(a).toBe(b) // same instance — same protocol:baseUrl
  })

  it('throws for openai protocol (not yet implemented)', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'gpt-4o': {
          model: 'gpt-4o',
          protocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
        },
      },
    })
    expect(() => getProviderForModel('gpt-4o')).toThrow(
      /not yet implemented/,
    )
  })

  it('throws for unsupported protocol', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'some-model': {
          model: 'some-model',
          protocol: 'unknown' as any,
          baseUrl: 'https://example.com',
          apiKey: 'key',
        },
      },
    })
    expect(() => getProviderForModel('some-model')).toThrow(
      /Unsupported protocol/,
    )
  })
})
