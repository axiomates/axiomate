import type { BingWebSearchProviderConfig } from '../../../utils/config.js'
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

type BingError = {
  code?: string
  message?: string
}

type BingWebPage = {
  name?: string
  url?: string
  snippet?: string
}

type BingSearchResponse = {
  webPages?: {
    value?: BingWebPage[]
  }
  errors?: BingError[]
  message?: string
}

const DEFAULT_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search'
const DEFAULT_COUNT = 10
const MAX_COUNT = 50

export class BingWebSearchProvider implements SearchProvider {
  readonly type = 'bing-web-search' as const
  readonly capabilities = {
    allowedDomains: 'adapter',
    blockedDomains: 'adapter',
    snippets: 'native',
  } as const

  constructor(
    readonly name: string,
    private readonly config: BingWebSearchProviderConfig,
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
        mapHits(response.webPages?.value ?? []),
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
  ): Promise<BingSearchResponse> {
    const url = new URL(this.config.endpoint ?? DEFAULT_ENDPOINT)
    url.searchParams.set('q', query)
    url.searchParams.set(
      'count',
      String(clampResultCount(this.config.count, DEFAULT_COUNT, MAX_COUNT)),
    )

    if (this.config.market) {
      url.searchParams.set('mkt', this.config.market)
    }

    if (this.config.setLang) {
      url.searchParams.set('setLang', this.config.setLang)
    }

    if (this.config.safeSearch) {
      url.searchParams.set('safeSearch', this.config.safeSearch)
    }

    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          'Ocp-Apim-Subscription-Key': this.config.apiKey,
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

    let payload: BingSearchResponse | null = null
    try {
      payload = (await response.json()) as BingSearchResponse
    } catch (error) {
      if (!response.ok) {
        payload = null
      } else {
        throw new SearchProviderError({
          providerName: this.name,
          code: 'response',
          message: `Search provider ${this.name} returned an invalid JSON response.`,
          cause: error,
        })
      }
    }

    if (!response.ok) {
      throw new SearchProviderError({
        providerName: this.name,
        code: getErrorCodeForStatus(response.status),
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

    return payload
  }
}

function mapHits(items: BingWebPage[]): SearchHitWithSnippet[] {
  return items
    .map(item => ({
      title: item.name?.trim() ?? '',
      url: item.url?.trim() ?? '',
      snippet: item.snippet?.trim(),
    }))
    .filter(hit => hit.title.length > 0 && hit.url.length > 0)
}

function getErrorMessage(payload: BingSearchResponse | null): string | undefined {
  if (!payload) {
    return undefined
  }

  return (
    payload.errors?.find(error => error.message)?.message ??
    payload.message
  )
}

function getErrorCodeForStatus(status: number) {
  if (status === 401 || status === 403) {
    return 'auth' as const
  }
  if (status === 429) {
    return 'rate_limit' as const
  }
  if (status >= 500) {
    return 'unavailable' as const
  }
  return 'invalid_request' as const
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}
