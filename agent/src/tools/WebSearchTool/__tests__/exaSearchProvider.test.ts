import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExaSearchProvider } from '../providers/exaSearchProvider.js'

describe('ExaSearchProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps a provider response into the existing WebSearch output shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Axiomate Search',
            url: 'https://example.com/docs/search',
            summary: 'Search providers can normalize results into the WebSearch tool.',
            highlights: ['More detail from Exa highlights.'],
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new ExaSearchProvider('exa', {
      type: 'exa',
      apiKey: 'api-key',
      searchType: 'auto',
      userLocation: 'US',
      numResults: 5,
      highlightMaxCharacters: 1200,
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

    const requestOptions = fetchMock.mock.calls[0][1] as RequestInit
    const requestBody = JSON.parse(String(requestOptions.body))
    expect(requestBody).toMatchObject({
      query: 'axiomate search adapters',
      type: 'auto',
      userLocation: 'US',
      numResults: 5,
      contents: {
        highlights: {
          maxCharacters: 1200,
        },
      },
    })
    expect((requestOptions.headers as Record<string, string>)['x-api-key']).toBe(
      'api-key',
    )
  })

  it('passes native domain filters through the Exa request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Docs',
            url: 'https://docs.example.com/guide',
            summary: 'Provider adapters keep the interface stable.',
          },
          {
            title: 'Blocked',
            url: 'https://blocked.example.net/post',
            summary: 'Should be filtered out.',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new ExaSearchProvider('exa', {
      type: 'exa',
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

    expect(fetchMock).toHaveBeenCalledTimes(1)

    const requestOptions = fetchMock.mock.calls[0][1] as RequestInit
    const requestBody = JSON.parse(String(requestOptions.body))
    expect(requestBody.includeDomains).toEqual(['example.com', 'example.net'])
    expect(requestBody.excludeDomains).toEqual(['blocked.example.net'])

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
          error: {
            message: 'Invalid API key.',
          },
        }),
      }),
    )

    const provider = new ExaSearchProvider('exa', {
      type: 'exa',
      apiKey: 'bad-key',
    })

    await expect(
      provider.search(
        { query: 'axiomate search adapters' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toMatchObject({
      name: 'SearchProviderError',
      providerName: 'exa',
      code: 'auth',
      statusCode: 401,
      retryable: false,
    })
  })
})
