import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchProviderError } from '../searchProvider.js'

const mockGlobalConfig = vi.fn()

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => mockGlobalConfig(),
}))

import {
  getSearchProvidersForModel,
  getSearchProviderForModel,
  hasSearchProviderForModel,
} from '../searchProviderRegistry.js'

describe('searchProviderRegistry', () => {
  beforeEach(() => {
    mockGlobalConfig.mockReset()
  })

  it('auto-selects the only configured provider for a model', () => {
    mockGlobalConfig.mockReturnValue({
      searchProviders: {
        google: {
          type: 'google-cse',
          apiKey: 'api-key',
          cx: 'search-engine-id',
        },
      },
      models: {
        'qwen/qwen3': {
          model: 'qwen/qwen3',
          protocol: 'openai',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
        },
      },
    })

    const provider = getSearchProviderForModel('qwen/qwen3')
    expect(provider.name).toBe('google')
    expect(provider.type).toBe('google-cse')
    expect(provider.capabilities).toEqual({
      allowedDomains: 'adapter',
      blockedDomains: 'adapter',
      snippets: 'native',
    })
    expect(hasSearchProviderForModel('qwen/qwen3')).toBe(true)
  })

  it('falls back to configured order when multiple providers are configured and no preferred provider is set', () => {
    mockGlobalConfig.mockReturnValue({
      searchProviders: {
        google: {
          type: 'google-cse',
          apiKey: 'api-key',
          cx: 'search-engine-id',
        },
        bing: {
          type: 'bing-web-search',
          apiKey: 'bing-key',
        },
      },
      models: {
        'qwen/qwen3': {
          model: 'qwen/qwen3',
          protocol: 'openai',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
        },
      },
    })

    const provider = getSearchProviderForModel('qwen/qwen3')
    const providers = getSearchProvidersForModel('qwen/qwen3')
    expect(provider.name).toBe('google')
    expect(providers.map(candidate => candidate.name)).toEqual(['google', 'bing'])
    expect(hasSearchProviderForModel('qwen/qwen3')).toBe(true)
  })

  it('throws when no search providers are configured', () => {
    mockGlobalConfig.mockReturnValue({
      models: {
        'qwen/qwen3': {
          model: 'qwen/qwen3',
          protocol: 'openai',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
        },
      },
    })

    expect(() => getSearchProviderForModel('qwen/qwen3')).toThrow(
      /No search providers are configured/,
    )
  })

  it('skips unusable providers and keeps later configured providers available', () => {
    mockGlobalConfig.mockReturnValue({
      searchProviders: {
        broken: {
          type: 'unsupported-provider',
          apiKey: 'bad',
        },
        google: {
          type: 'google-cse',
          apiKey: 'api-key',
          cx: 'search-engine-id',
        },
      },
      models: {
        'qwen/qwen3': {
          model: 'qwen/qwen3',
          protocol: 'openai',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
        },
      },
    })

    const provider = getSearchProviderForModel('qwen/qwen3')
    expect(provider.name).toBe('google')
    expect(provider.type).toBe('google-cse')
  })
})
