import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock getGlobalConfig to control models configuration
const mockGlobalConfig = vi.fn()
vi.mock('../../../../utils/config.js', () => ({
  getGlobalConfig: () => mockGlobalConfig(),
}))

// Mock transitive deps of providerRegistry (it imports AnthropicProvider)
vi.mock('../../../../services/analytics/index.js', () => ({ logEvent: vi.fn() }))
vi.mock('../../../../services/api/withRetry.js', () => ({
  withRetry: vi.fn(async function* (_getClient: any, operation: any, options: any) {
    const client = await _getClient()
    const result = await operation(client, 1, { model: options.model, thinkingConfig: options.thinkingConfig })
    return result
  }),
  CannotRetryError: class extends Error {},
}))
vi.mock('../../../../utils/diagLogs.js', () => ({ logForDiagnosticsNoPII: vi.fn() }))
vi.mock('../../../../utils/betas.js', () => ({ getModelBetas: vi.fn().mockReturnValue([]) }))
vi.mock('../../../../utils/model/model.js', () => ({
  normalizeModelStringForAPI: vi.fn((m: string) => m),
  resolveModelStringForAPI: vi.fn((m: string) => m),
}))
vi.mock('../../../../services/api/llm.js', () => ({
  getExtraBodyParams: vi.fn().mockReturnValue({}),
  adjustParamsForNonStreaming: vi.fn((p: any) => p),
  MAX_NON_STREAMING_TOKENS: 64000,
}))
vi.mock('../../../../utils/log.js', () => ({ logError: vi.fn() }))
vi.mock('../../../../utils/modelCost.js', () => ({ calculateUSDCost: vi.fn().mockReturnValue(0) }))

import { getProviderForModel, clearProviderCache } from '../../../../services/api/providerRegistry.js'

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
        'provider-configured-model': {
          model: 'provider-configured-model',
          protocol: 'anthropic',
          baseUrl: 'https://api.example.com',
          apiKey: 'test-api-key',
        },
      },
    })
    const provider = getProviderForModel('provider-configured-model')
    expect(provider.name).toBe('anthropic')
  })

  it('does not reuse providers across model ids with distinct model config', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'model-a': {
          model: 'model-a',
          protocol: 'anthropic',
          baseUrl: 'https://api.example.com',
          apiKey: 'test-api-key',
        },
        'model-b': {
          model: 'model-b',
          protocol: 'anthropic',
          baseUrl: 'https://api.example.com',
          apiKey: 'test-api-key',
        },
      },
    })
    const a = getProviderForModel('model-a')
    const b = getProviderForModel('model-b')
    expect(a).not.toBe(b)
  })

  it('caches repeat lookups for the same model id', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'model-a': {
          model: 'model-a',
          protocol: 'anthropic',
          baseUrl: 'https://api.example.com',
          apiKey: 'test-api-key',
        },
      },
    })
    const first = getProviderForModel('model-a')
    const second = getProviderForModel('model-a')
    expect(first).toBe(second)
  })

  it('returns OpenAIProvider for protocol: openai', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'gpt-4o': {
          model: 'gpt-4o',
          protocol: 'openai-chat',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
        },
      },
    })
    const provider = getProviderForModel('gpt-4o')
    expect(provider.name).toBe('openai-chat')
  })

  it('returns OpenAIResponsesProvider for protocol: openai-responses', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'o4-mini': {
          model: 'o4-mini',
          protocol: 'openai-responses',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
        },
      },
    })
    const provider = getProviderForModel('o4-mini')
    expect(provider.name).toBe('openai-responses')
  })

  it('rejects unknown modelTemplate references', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'deepseek-v4-pro': {
          model: 'deepseek-v4-pro',
          protocol: 'openai-chat',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-test',
          modelTemplate: 'does-not-exist',
        },
      },
    })
    expect(() => getProviderForModel('deepseek-v4-pro')).toThrow(
      /references modelTemplate 'does-not-exist'/,
    )
  })

  it('rejects explicit modelTemplate pins that do not match the configured endpoint', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'deepseek-v4-pro': {
          model: 'deepseek-v4-pro',
          protocol: 'openai-chat',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-test',
          modelTemplate: 'openai-chat-micu-deepseek',
        },
      },
    })
    expect(() => getProviderForModel('deepseek-v4-pro')).toThrow(
      /does not match this model\/vendor\/protocol\/baseUrl/,
    )
  })

  it('accepts a compatible explicit modelTemplate pin', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'micu-0.2-deepseek-v4-pro': {
          model: 'deepseek-v4-pro',
          protocol: 'openai-chat',
          baseUrl: 'https://www.micuapi.ai/v1',
          apiKey: 'sk-test',
          modelTemplate: 'openai-chat-micu-deepseek',
        },
      },
    })
    const provider = getProviderForModel('micu-0.2-deepseek-v4-pro')
    expect(provider.name).toBe('openai-chat')
  })

  it('rejects unsupported protocol at config validation', () => {
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
      /Invalid model configuration/,
    )
  })
})
