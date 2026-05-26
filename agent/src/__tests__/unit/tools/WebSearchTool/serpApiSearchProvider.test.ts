import { afterEach, describe, expect, it, vi } from 'vitest'
import { SerpApiSearchProvider } from '../../../../tools/WebSearchTool/providers/serpApiSearchProvider.js'

describe('SerpApiSearchProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps a provider response into the existing WebSearch output shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        organic_results: [
          {
            title: 'Axiomate Search',
            link: 'https://example.com/docs/search',
            snippet: 'Search providers can normalize results into the WebSearch tool.',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new SerpApiSearchProvider('serpapi', {
      type: 'serpapi',
      apiKey: 'serp-key',
      engine: 'google',
      googleDomain: 'google.com',
      hl: 'en',
      gl: 'us',
      location: 'Austin, Texas, United States',
      device: 'desktop',
      safe: 'active',
      num: 5,
      noCache: true,
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
    expect(requestUrl.searchParams.get('api_key')).toBe('serp-key')
    expect(requestUrl.searchParams.get('engine')).toBe('google')
    expect(requestUrl.searchParams.get('q')).toBe('axiomate search adapters')
    expect(requestUrl.searchParams.get('google_domain')).toBe('google.com')
    expect(requestUrl.searchParams.get('hl')).toBe('en')
    expect(requestUrl.searchParams.get('gl')).toBe('us')
    expect(requestUrl.searchParams.get('location')).toBe(
      'Austin, Texas, United States',
    )
    expect(requestUrl.searchParams.get('device')).toBe('desktop')
    expect(requestUrl.searchParams.get('safe')).toBe('active')
    expect(requestUrl.searchParams.get('num')).toBe('5')
    expect(requestUrl.searchParams.get('no_cache')).toBe('true')
  })

  it('runs one search per allowed domain and filters blocked hosts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          organic_results: [
            {
              title: 'Docs',
              link: 'https://docs.example.com/guide',
              snippet: 'Provider adapters keep the interface stable.',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          organic_results: [
            {
              title: 'Blocked',
              link: 'https://blocked.example.net/post',
              snippet: 'Should be filtered out.',
            },
            {
              title: 'Blog',
              link: 'https://blog.example.net/post',
              snippet: 'This result should stay.',
            },
          ],
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new SerpApiSearchProvider('serpapi', {
      type: 'serpapi',
      apiKey: 'serp-key',
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
          error: 'Invalid API key.',
        }),
      }),
    )

    const provider = new SerpApiSearchProvider('serpapi', {
      type: 'serpapi',
      apiKey: 'bad-key',
    })

    await expect(
      provider.search(
        { query: 'axiomate search adapters' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toMatchObject({
      name: 'SearchProviderError',
      providerName: 'serpapi',
      code: 'auth',
      statusCode: 401,
      retryable: false,
    })
  })
})
