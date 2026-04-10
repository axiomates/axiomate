import type { SerpApiSearchProviderConfig } from '../../../utils/config.js'
import type { ToolCallProgress, ToolUseContext } from '../../../Tool.js'
import type { WebSearchProgress } from '../../../types/tools.js'
import {
  createProgressId,
  emitQueryUpdate,
  emitResultsReceived,
  SearchProviderError,
  type SearchProvider,
} from '../searchProvider.js'
import type { Output, WebSearchInput } from '../types.js'
import {
  buildSearchRuns,
  buildSummary,
  clampResultCount,
  filterHits,
  type SearchHitWithSnippet,
} from './providerUtils.js'

type SerpApiResult = {
  title?: string
  link?: string
  snippet?: string
}

type SerpApiSearchResponse = {
  organic_results?: SerpApiResult[]
  news_results?: SerpApiResult[]
  error?: string
  search_metadata?: {
    status?: string
  }
}

const DEFAULT_BASE_URL = 'https://serpapi.com/search.json'
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 100

export class SerpApiSearchProvider implements SearchProvider {
  readonly type = 'serpapi' as const
  readonly capabilities = {
    allowedDomains: 'adapter',
    blockedDomains: 'adapter',
    snippets: 'native',
  } as const

  constructor(
    readonly name: string,
    private readonly config: SerpApiSearchProviderConfig,
  ) {}

  async search(
    input: WebSearchInput,
    context: ToolUseContext,
    onProgress?: ToolCallProgress<WebSearchProgress>,
  ): Promise<Output> {
    const startTime = performance.now()
    const runs = buildSearchRuns(input)
    const results: Output['results'] = []

    for (const run of runs) {
      const toolUseId = createProgressId('web-search', run.query)
      emitQueryUpdate(onProgress, toolUseId, run.query)

      const response = await this.fetchResults(run.query, context)
      const hits = filterHits(
        mapHits(getResponseItems(response)),
        input.allowed_domains,
        input.blocked_domains,
      )

      emitResultsReceived(onProgress, toolUseId, run.query, hits.length)

      const summary = buildSummary(run.summaryLabel, hits)
      if (summary) {
        results.push(summary)
      }
      results.push({
        content: hits.map(({ title, url }) => ({ title, url })),
      })
    }

    return {
      query: input.query,
      results,
      durationSeconds: (performance.now() - startTime) / 1000,
    }
  }

  private async fetchResults(
    query: string,
    context: ToolUseContext,
  ): Promise<SerpApiSearchResponse> {
    const url = new URL(this.config.baseUrl ?? DEFAULT_BASE_URL)
    url.searchParams.set('api_key', this.config.apiKey)
    url.searchParams.set('engine', this.config.engine ?? 'google')
    url.searchParams.set('q', query)
    url.searchParams.set(
      'num',
      String(clampResultCount(this.config.num, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS)),
    )

    if (this.config.googleDomain) {
      url.searchParams.set('google_domain', this.config.googleDomain)
    }
    if (this.config.hl) {
      url.searchParams.set('hl', this.config.hl)
    }
    if (this.config.gl) {
      url.searchParams.set('gl', this.config.gl)
    }
    if (this.config.location) {
      url.searchParams.set('location', this.config.location)
    }
    if (this.config.device) {
      url.searchParams.set('device', this.config.device)
    }
    if (this.config.safe) {
      url.searchParams.set('safe', this.config.safe)
    }
    if (this.config.noCache) {
      url.searchParams.set('no_cache', 'true')
    }

    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
        signal: context.abortController.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
      throw new SearchProviderError({
        providerName: this.name,
        code: 'network',
        message: `Search provider ${this.name} request failed.`,
        retryable: true,
        cause: error,
      })
    }

    const payload = await parseSerpApiResponse(response, this.name)

    if (!response.ok) {
      throw new SearchProviderError({
        providerName: this.name,
        code: getErrorCodeForResponse(response.status, payload),
        message:
          getErrorMessage(payload) ||
          `Search provider ${this.name} returned HTTP ${response.status}`,
        retryable: isRetryableStatus(response.status),
        statusCode: response.status,
      })
    }

    if (!payload) {
      throw new SearchProviderError({
        providerName: this.name,
        code: 'response',
        message: `Search provider ${this.name} returned an empty response.`,
      })
    }

    if (payload.error) {
      throw new SearchProviderError({
        providerName: this.name,
        code: getErrorCodeForResponse(response.status, payload),
        message: payload.error,
      })
    }

    return payload
  }
}

async function parseSerpApiResponse(
  response: Response,
  providerName: string,
): Promise<SerpApiSearchResponse | null> {
  try {
    return (await response.json()) as SerpApiSearchResponse
  } catch (error) {
    if (!response.ok) {
      return null
    }

    throw new SearchProviderError({
      providerName,
      code: 'response',
      message: `Search provider ${providerName} returned an invalid JSON response.`,
      cause: error,
    })
  }
}

function getResponseItems(response: SerpApiSearchResponse): SerpApiResult[] {
  return response.organic_results ?? response.news_results ?? []
}

function mapHits(items: SerpApiResult[]): SearchHitWithSnippet[] {
  return items
    .map(item => ({
      title: item.title?.trim() ?? '',
      url: item.link?.trim() ?? '',
      snippet: item.snippet?.trim(),
    }))
    .filter(hit => hit.title.length > 0 && hit.url.length > 0)
}

function getErrorMessage(
  payload: SerpApiSearchResponse | null,
): string | undefined {
  return payload?.error
}

function getErrorCodeForResponse(
  status: number,
  payload: SerpApiSearchResponse | null,
) {
  const combined = getErrorMessage(payload)?.toLowerCase() ?? ''

  if (status === 401 || status === 403) {
    return 'auth' as const
  }
  if (status === 429) {
    return 'rate_limit' as const
  }
  if (status >= 500) {
    return 'unavailable' as const
  }

  if (combined.includes('api key') || combined.includes('account')) {
    return 'auth' as const
  }
  if (
    combined.includes('searches left') ||
    combined.includes('rate limit') ||
    combined.includes('quota')
  ) {
    return 'rate_limit' as const
  }
  if (
    combined.includes('engine') ||
    combined.includes('parameter') ||
    combined.includes('google_domain')
  ) {
    return 'config' as const
  }

  return 'invalid_request' as const
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}
