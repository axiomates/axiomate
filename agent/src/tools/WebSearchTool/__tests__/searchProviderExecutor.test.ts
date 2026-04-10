import { describe, expect, it, vi } from 'vitest'
import type { SearchProvider } from '../searchProvider.js'
import { SearchProviderError } from '../searchProvider.js'
import { searchWithProviderFallback } from '../searchProviderExecutor.js'
import type { Output } from '../types.js'

function createProvider(
  name: string,
  behavior: () => Promise<Output>,
): SearchProvider {
  return {
    name,
    type: 'google-cse',
    capabilities: {
      allowedDomains: 'adapter',
      blockedDomains: 'adapter',
      snippets: 'native',
    },
    search: vi.fn(behavior),
  }
}

describe('searchProviderExecutor', () => {
  it('falls back to the next provider when the current provider is unavailable', async () => {
    const unavailableProvider = createProvider('google', async () => {
      throw new SearchProviderError({
        providerName: 'google',
        code: 'network',
        message: 'Temporary network failure',
        retryable: true,
      })
    })
    const bingOutput: Output = {
      query: 'axiomate',
      results: ['Search snippets for "axiomate":\n1. Axiomate: OK'],
      durationSeconds: 0.2,
    }
    const fallbackProvider = createProvider('bing', async () => bingOutput)

    const result = await searchWithProviderFallback(
      [unavailableProvider, fallbackProvider],
      { query: 'axiomate' },
      { abortController: new AbortController() } as any,
    )

    expect(result).toEqual(bingOutput)
    expect(unavailableProvider.search).toHaveBeenCalledOnce()
    expect(fallbackProvider.search).toHaveBeenCalledOnce()
  })

  it('does not fall back on invalid_request errors', async () => {
    const invalidRequestProvider = createProvider('google', async () => {
      throw new SearchProviderError({
        providerName: 'google',
        code: 'invalid_request',
        message: 'Query is invalid',
      })
    })
    const fallbackProvider = createProvider('bing', async () => ({
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
      providerName: 'google',
      code: 'invalid_request',
    })
    expect(fallbackProvider.search).not.toHaveBeenCalled()
  })

  it('throws an aggregated error when all providers fail', async () => {
    const googleProvider = createProvider('google', async () => {
      throw new SearchProviderError({
        providerName: 'google',
        code: 'auth',
        message: 'Invalid API key',
      })
    })
    const bingProvider = createProvider('bing', async () => {
      throw new SearchProviderError({
        providerName: 'bing',
        code: 'unavailable',
        message: 'Service temporarily unavailable',
        retryable: true,
      })
    })

    await expect(
      searchWithProviderFallback(
        [googleProvider, bingProvider],
        { query: 'axiomate' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toMatchObject({
      name: 'SearchProviderError',
      providerName: 'google, bing',
      code: 'unavailable',
      retryable: true,
    })

    await expect(
      searchWithProviderFallback(
        [googleProvider, bingProvider],
        { query: 'axiomate' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toThrow(/google: Invalid API key/)
  })
})
