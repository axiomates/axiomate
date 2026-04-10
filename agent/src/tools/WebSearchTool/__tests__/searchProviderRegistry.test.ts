import { beforeEach, describe, expect, it, vi } from 'vitest'

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
        exa: {
          type: 'exa',
          apiKey: 'api-key',
          searchType: 'auto',
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
    expect(provider.name).toBe('exa')
    expect(provider.type).toBe('exa')
    expect(provider.capabilities).toEqual({
      allowedDomains: 'native',
      blockedDomains: 'native',
      snippets: 'native',
    })
    expect(hasSearchProviderForModel('qwen/qwen3')).toBe(true)
  })

  it('falls back to configured order when multiple providers are configured and no preferred provider is set', () => {
    mockGlobalConfig.mockReturnValue({
      searchProviders: {
        brave: {
          type: 'brave-web-search',
          apiKey: 'brave-key',
        },
        exa: {
          type: 'exa',
          apiKey: 'exa-key',
        },
        tavily: {
          type: 'tavily',
          apiKey: 'tvly-key',
        },
        serpapi: {
          type: 'serpapi',
          apiKey: 'serp-key',
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
    expect(provider.name).toBe('brave')
    expect(providers.map(candidate => candidate.name)).toEqual([
      'brave',
      'exa',
      'tavily',
      'serpapi',
    ])
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
        exa: {
          type: 'exa',
          apiKey: 'api-key',
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
    expect(provider.name).toBe('exa')
    expect(provider.type).toBe('exa')
  })
})
