import { describe, expect, it, vi } from 'vitest'
import type { SearchProvider } from '../../../../tools/WebSearchTool/searchProvider.js'
import { SearchProviderError } from '../../../../tools/WebSearchTool/searchProvider.js'
import { searchWithProviderFallback } from '../../../../tools/WebSearchTool/searchProviderExecutor.js'
import type { Output } from '../../../../tools/WebSearchTool/types.js'

function createProvider(
  name: string,
  behavior: () => Promise<Output>,
): SearchProvider {
  return {
    name,
    type: 'exa',
    capabilities: {
      allowedDomains: 'native',
      blockedDomains: 'native',
      snippets: 'native',
    },
    search: vi.fn(behavior),
  }
}

describe('searchProviderExecutor', () => {
  it('falls back to the next provider when the current provider is unavailable', async () => {
    const unavailableProvider = createProvider('exa', async () => {
      throw new SearchProviderError({
        providerName: 'exa',
        code: 'network',
        message: 'Temporary network failure',
        retryable: true,
      })
    })
    const tavilyOutput: Output = {
      query: 'axiomate',
      results: ['Search snippets for "axiomate":\n1. Axiomate: OK'],
      durationSeconds: 0.2,
    }
    const fallbackProvider = createProvider('tavily', async () => tavilyOutput)

    const result = await searchWithProviderFallback(
      [unavailableProvider, fallbackProvider],
      { query: 'axiomate' },
      { abortController: new AbortController() } as any,
    )

    expect(result).toEqual(tavilyOutput)
    expect(unavailableProvider.search).toHaveBeenCalledOnce()
    expect(fallbackProvider.search).toHaveBeenCalledOnce()
  })

  it('does not fall back on invalid_request errors', async () => {
    const invalidRequestProvider = createProvider('exa', async () => {
      throw new SearchProviderError({
        providerName: 'exa',
        code: 'invalid_request',
        message: 'Query is invalid',
      })
    })
    const fallbackProvider = createProvider('tavily', async () => ({
      query: 'axiomate',
      results: [],
      durationSeconds: 0.1,
    }))

    await expect(
      searchWithProviderFallback(
        [invalidRequestProvider, fallbackProvider],
        { query: 'axiomate' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toMatchObject({
      name: 'SearchProviderError',
      providerName: 'exa',
      code: 'invalid_request',
    })
    expect(fallbackProvider.search).not.toHaveBeenCalled()
  })

  it('throws an aggregated error when all providers fail', async () => {
    const exaProvider = createProvider('exa', async () => {
      throw new SearchProviderError({
        providerName: 'exa',
        code: 'auth',
        message: 'Invalid API key',
      })
    })
    const tavilyProvider = createProvider('tavily', async () => {
      throw new SearchProviderError({
        providerName: 'tavily',
        code: 'unavailable',
        message: 'Service temporarily unavailable',
        retryable: true,
      })
    })

    await expect(
      searchWithProviderFallback(
        [exaProvider, tavilyProvider],
        { query: 'axiomate' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toMatchObject({
      name: 'SearchProviderError',
      providerName: 'exa, tavily',
      code: 'unavailable',
      retryable: true,
    })

    await expect(
      searchWithProviderFallback(
        [exaProvider, tavilyProvider],
        { query: 'axiomate' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toThrow(/exa: Invalid API key/)
  })
})
