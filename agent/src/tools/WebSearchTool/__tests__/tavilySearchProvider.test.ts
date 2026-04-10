import { afterEach, describe, expect, it, vi } from 'vitest'
import { TavilySearchProvider } from '../providers/tavilySearchProvider.js'

describe('TavilySearchProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps a provider response into the existing WebSearch output shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        answer: 'A short synthesized answer from Tavily.',
        results: [
          {
            title: 'Axiomate Search',
            url: 'https://example.com/docs/search',
            content: 'Search providers can normalize results into the WebSearch tool.',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new TavilySearchProvider('tavily', {
      type: 'tavily',
      apiKey: 'tvly-key',
      searchDepth: 'advanced',
      chunksPerSource: 2,
      maxResults: 6,
      topic: 'news',
      includeAnswer: 'basic',
      includeRawContent: 'text',
      country: 'united states',
      autoParameters: false,
      exactMatch: true,
      includeUsage: true,
      safeSearch: true,
    })
    expect(provider.capabilities).toEqual({
      allowedDomains: 'native',
      blockedDomains: 'native',
      snippets: 'native',
    })
    const progress = vi.fn()

    const output = await provider.search(
      { query: 'axiomate search adapters' },
      { abortController: new AbortController() } as any,
      progress,
    )

    expect(output.query).toBe('axiomate search adapters')
    expect(output.results).toHaveLength(3)
    expect(output.results[0]).toContain('Tavily answer for "axiomate search adapters"')
    expect(output.results[1]).toContain('Search snippets for "axiomate search adapters"')
    expect(output.results[2]).toEqual({
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

    const requestOptions = fetchMock.mock.calls[0][1] as RequestInit
    const requestBody = JSON.parse(String(requestOptions.body))
    expect(requestBody).toMatchObject({
      query: 'axiomate search adapters',
      search_depth: 'advanced',
      chunks_per_source: 2,
      max_results: 6,
      topic: 'news',
      include_answer: 'basic',
      include_raw_content: 'text',
      country: 'united states',
      auto_parameters: false,
      exact_match: true,
      include_usage: true,
      safe_search: true,
    })
    expect((requestOptions.headers as Record<string, string>).Authorization).toBe(
      'Bearer tvly-key',
    )
  })

  it('passes native domain filters through the Tavily request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Docs',
            url: 'https://docs.example.com/guide',
            content: 'Provider adapters keep the interface stable.',
          },
          {
            title: 'Blocked',
            url: 'https://blocked.example.net/post',
            content: 'Should be filtered out.',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new TavilySearchProvider('tavily', {
      type: 'tavily',
      apiKey: 'tvly-key',
    })

    const output = await provider.search(
      {
        query: 'search provider adapter',
        allowed_domains: ['example.com', 'example.net'],
        blocked_domains: ['blocked.example.net'],
      },
      { abortController: new AbortController() } as any,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)

    const requestOptions = fetchMock.mock.calls[0][1] as RequestInit
    const requestBody = JSON.parse(String(requestOptions.body))
    expect(requestBody.include_domains).toEqual(['example.com', 'example.net'])
    expect(requestBody.exclude_domains).toEqual(['blocked.example.net'])

    expect(output.results).toHaveLength(2)
    expect(output.results[1]).toEqual({
      content: [
        {
          title: 'Docs',
          url: 'https://docs.example.com/guide',
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

    const provider = new TavilySearchProvider('tavily', {
      type: 'tavily',
      apiKey: 'bad-key',
    })

    await expect(
      provider.search(
        { query: 'axiomate search adapters' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toMatchObject({
      name: 'SearchProviderError',
      providerName: 'tavily',
      code: 'auth',
      statusCode: 401,
      retryable: false,
    })
  })
})
