import { afterEach, describe, expect, it, vi } from 'vitest'
import { BingWebSearchProvider } from '../providers/bingWebSearchProvider.js'

describe('BingWebSearchProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps a provider response into the existing WebSearch output shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        webPages: {
          value: [
            {
              name: 'Axiomate Search',
              url: 'https://example.com/docs/search',
              snippet: 'Search providers can normalize results into the WebSearch tool.',
            },
          ],
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BingWebSearchProvider('bing', {
      type: 'bing-web-search',
      apiKey: 'api-key',
      count: 5,
      market: 'en-US',
      safeSearch: 'Moderate',
    })
    expect(provider.capabilities).toEqual({
      allowedDomains: 'adapter',
      blockedDomains: 'adapter',
      snippets: 'native',
    })
    const progress = vi.fn()

    const output = await provider.search(
      { query: 'axiomate search adapters' },
      { abortController: new AbortController() } as any,
      progress,
    )

    expect(output.query).toBe('axiomate search adapters')
    expect(output.results).toHaveLength(2)
    expect(output.results[0]).toContain('Search snippets for "axiomate search adapters"')
    expect(output.results[1]).toEqual({
      content: [
        {
          title: 'Axiomate Search',
          url: 'https://example.com/docs/search',
        },
      ],
    })

    expect(progress).toHaveBeenCalledWith({
      toolUseID: expect.any(String),
      data: {
        type: 'query_update',
        query: 'axiomate search adapters',
      },
    })
    expect(progress).toHaveBeenCalledWith({
      toolUseID: expect.any(String),
      data: {
        type: 'search_results_received',
        query: 'axiomate search adapters',
        resultCount: 1,
      },
    })

    const requestUrl = new URL(fetchMock.mock.calls[0][0] as URL)
    const requestOptions = fetchMock.mock.calls[0][1] as RequestInit
    expect(requestUrl.searchParams.get('q')).toBe('axiomate search adapters')
    expect(requestUrl.searchParams.get('count')).toBe('5')
    expect(requestUrl.searchParams.get('mkt')).toBe('en-US')
    expect(requestUrl.searchParams.get('safeSearch')).toBe('Moderate')
    expect((requestOptions.headers as Record<string, string>)[
      'Ocp-Apim-Subscription-Key'
    ]).toBe('api-key')
  })

  it('runs one search per allowed domain and filters blocked hosts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          webPages: {
            value: [
              {
                name: 'Docs',
                url: 'https://docs.example.com/guide',
                snippet: 'Provider adapters keep the interface stable.',
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          webPages: {
            value: [
              {
                name: 'Blocked',
                url: 'https://blocked.example.net/post',
                snippet: 'Should be filtered out.',
              },
              {
                name: 'Blog',
                url: 'https://blog.example.net/post',
                snippet: 'This result should stay.',
              },
            ],
          },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BingWebSearchProvider('bing', {
      type: 'bing-web-search',
      apiKey: 'api-key',
    })

    const output = await provider.search(
      {
        query: 'search provider adapter',
        allowed_domains: ['example.com', 'example.net'],
        blocked_domains: ['blocked.example.net'],
      },
      { abortController: new AbortController() } as any,
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstRequestUrl = new URL(fetchMock.mock.calls[0][0] as URL)
    const secondRequestUrl = new URL(fetchMock.mock.calls[1][0] as URL)
    expect(firstRequestUrl.searchParams.get('q')).toBe(
      'search provider adapter site:example.com -site:blocked.example.net',
    )
    expect(secondRequestUrl.searchParams.get('q')).toBe(
      'search provider adapter site:example.net -site:blocked.example.net',
    )

    expect(output.results).toHaveLength(4)
    expect(output.results[1]).toEqual({
      content: [
        {
          title: 'Docs',
          url: 'https://docs.example.com/guide',
        },
      ],
    })
    expect(output.results[3]).toEqual({
      content: [
        {
          title: 'Blog',
          url: 'https://blog.example.net/post',
        },
      ],
    })
  })

  it('wraps HTTP failures into a SearchProviderError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: vi.fn().mockResolvedValue({
          errors: [
            {
              message: 'Access denied due to invalid subscription key.',
            },
          ],
        }),
      }),
    )

    const provider = new BingWebSearchProvider('bing', {
      type: 'bing-web-search',
      apiKey: 'bad-key',
    })

    await expect(
      provider.search(
        { query: 'axiomate search adapters' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toMatchObject({
      name: 'SearchProviderError',
      providerName: 'bing',
      code: 'auth',
      statusCode: 401,
      retryable: false,
    })
  })
})
