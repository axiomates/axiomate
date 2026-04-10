import type { TavilySearchProviderConfig } from '../../../utils/config.js'
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
  buildSummary,
  clampResultCount,
  filterHits,
  type SearchHitWithSnippet,
} from './providerUtils.js'

type TavilySearchResult = {
  title?: string
  url?: string
  content?: string
  raw_content?: string | null
}

type TavilySearchResponse = {
  answer?: string
  results?: TavilySearchResult[]
  request_id?: string
  detail?: string
  error?: string
  message?: string
}

type TavilySearchRequest = {
  query: string
  search_depth?: TavilySearchProviderConfig['searchDepth']
  chunks_per_source?: number
  max_results: number
  topic?: TavilySearchProviderConfig['topic']
  time_range?: TavilySearchProviderConfig['timeRange']
  start_date?: string
  end_date?: string
  include_answer?: TavilySearchProviderConfig['includeAnswer']
  include_raw_content?: TavilySearchProviderConfig['includeRawContent']
  include_domains?: string[]
  exclude_domains?: string[]
  country?: string
  auto_parameters?: boolean
  exact_match?: boolean
  include_usage?: boolean
  safe_search?: boolean
}

const DEFAULT_BASE_URL = 'https://api.tavily.com/search'
const DEFAULT_MAX_RESULTS = 5
const MAX_RESULTS = 20

export class TavilySearchProvider implements SearchProvider {
  readonly type = 'tavily' as const
  readonly capabilities = {
    allowedDomains: 'native',
    blockedDomains: 'native',
    snippets: 'native',
  } as const

  constructor(
    readonly name: string,
    private readonly config: TavilySearchProviderConfig,
  ) {}

  async search(
    input: WebSearchInput,
    context: ToolUseContext,
    onProgress?: ToolCallProgress<WebSearchProgress>,
  ): Promise<Output> {
    const startTime = performance.now()
    const toolUseId = createProgressId('web-search', input.query)
    emitQueryUpdate(onProgress, toolUseId, input.query)

    const response = await this.fetchResults(input, context)
    const hits = filterHits(
      mapHits(response.results ?? []),
      input.allowed_domains,
      input.blocked_domains,
    )

    emitResultsReceived(onProgress, toolUseId, input.query, hits.length)

    const results: Output['results'] = []
    const answerSummary = buildAnswerSummary(input.query, response.answer)
    if (answerSummary) {
      results.push(answerSummary)
    }

    const summary = buildSummary(input.query, hits)
    if (summary) {
      results.push(summary)
    }
    results.push({
      content: hits.map(({ title, url }) => ({ title, url })),
    })

    return {
      query: input.query,
      results,
      durationSeconds: (performance.now() - startTime) / 1000,
    }
  }

  private async fetchResults(
    input: WebSearchInput,
    context: ToolUseContext,
  ): Promise<TavilySearchResponse> {
    let response: Response
    try {
      response = await fetch(this.config.baseUrl ?? DEFAULT_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(input, this.config)),
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

    const payload = await parseTavilyResponse(response, this.name)

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

    return payload
  }
}

function buildRequestBody(
  input: WebSearchInput,
  config: TavilySearchProviderConfig,
): TavilySearchRequest {
  const request: TavilySearchRequest = {
    query: input.query,
    max_results: clampResultCount(
      config.maxResults,
      DEFAULT_MAX_RESULTS,
      MAX_RESULTS,
    ),
  }

  if (config.searchDepth) {
    request.search_depth = config.searchDepth
  }
  if (
    config.chunksPerSource !== undefined &&
    config.searchDepth === 'advanced'
  ) {
    request.chunks_per_source = clampResultCount(config.chunksPerSource, 3, 3)
  }
  if (config.topic) {
    request.topic = config.topic
  }
  if (config.timeRange) {
    request.time_range = config.timeRange
  }
  if (config.startDate) {
    request.start_date = config.startDate
  }
  if (config.endDate) {
    request.end_date = config.endDate
  }
  if (config.includeAnswer !== undefined) {
    request.include_answer = config.includeAnswer
  }
  if (config.includeRawContent !== undefined) {
    request.include_raw_content = config.includeRawContent
  }
  if (input.allowed_domains?.length) {
    request.include_domains = input.allowed_domains
  }
  if (input.blocked_domains?.length) {
    request.exclude_domains = input.blocked_domains
  }
  if (config.country) {
    request.country = config.country
  }
  if (config.autoParameters !== undefined) {
    request.auto_parameters = config.autoParameters
  }
  if (config.exactMatch !== undefined) {
    request.exact_match = config.exactMatch
  }
  if (config.includeUsage !== undefined) {
    request.include_usage = config.includeUsage
  }
  if (config.safeSearch !== undefined) {
    request.safe_search = config.safeSearch
  }

  return request
}

async function parseTavilyResponse(
  response: Response,
  providerName: string,
): Promise<TavilySearchResponse | null> {
  try {
    return (await response.json()) as TavilySearchResponse
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

function mapHits(items: TavilySearchResult[]): SearchHitWithSnippet[] {
  return items
    .map(item => ({
      title: item.title?.trim() ?? '',
      url: item.url?.trim() ?? '',
      snippet: item.content?.trim() || item.raw_content?.trim() || undefined,
    }))
    .filter(hit => hit.title.length > 0 && hit.url.length > 0)
}

function buildAnswerSummary(query: string, answer: string | undefined): string | null {
  const normalized = answer?.trim()
  if (!normalized) {
    return null
  }

  return `Tavily answer for "${query}": ${normalized}`
}

function getErrorMessage(
  payload: TavilySearchResponse | null,
): string | undefined {
  return payload?.detail || payload?.error || payload?.message
}

function getErrorCodeForResponse(
  status: number,
  payload: TavilySearchResponse | null,
) {
  const combined = getErrorMessage(payload)?.toLowerCase() ?? ''

  if (status === 401 || status === 403) {
    return 'auth' as const
  }
  if (status === 429 || status === 432) {
    return 'rate_limit' as const
  }
  if (status >= 500) {
    return 'unavailable' as const
  }

  if (combined.includes('api key') || combined.includes('bearer')) {
    return 'auth' as const
  }
  if (
    combined.includes('credit') ||
    combined.includes('quota') ||
    combined.includes('rate limit')
  ) {
    return 'rate_limit' as const
  }
  if (
    combined.includes('enterprise') ||
    combined.includes('plan') ||
    combined.includes('subscription')
  ) {
    return 'config' as const
  }

  return 'invalid_request' as const
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 432 || status >= 500
}
