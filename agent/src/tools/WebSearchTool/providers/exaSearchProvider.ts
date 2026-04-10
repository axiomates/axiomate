import type { ExaSearchProviderConfig } from '../../../utils/config.js'
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

type ExaResult = {
  title?: string
  url?: string
  summary?: string
  text?: string
  highlights?: string[]
}

type ExaErrorObject = {
  message?: string
  type?: string
  code?: string
}

type ExaSearchResponse = {
  results?: ExaResult[]
  error?: string | ExaErrorObject
}

type ExaSearchRequest = {
  query: string
  type?: ExaSearchProviderConfig['searchType']
  category?: ExaSearchProviderConfig['category']
  userLocation?: string
  numResults: number
  includeDomains?: string[]
  excludeDomains?: string[]
  includeText?: string[]
  excludeText?: string[]
  moderation?: boolean
  contents: {
    highlights: {
      maxCharacters: number
    }
  }
}

const DEFAULT_BASE_URL = 'https://api.exa.ai/search'
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 100
const DEFAULT_HIGHLIGHT_MAX_CHARACTERS = 800
const MAX_HIGHLIGHT_MAX_CHARACTERS = 4_000

export class ExaSearchProvider implements SearchProvider {
  readonly type = 'exa' as const
  readonly capabilities = {
    allowedDomains: 'native',
    blockedDomains: 'native',
    snippets: 'native',
  } as const

  constructor(
    readonly name: string,
    private readonly config: ExaSearchProviderConfig,
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
  ): Promise<ExaSearchResponse> {
    let response: Response
    try {
      response = await fetch(this.config.baseUrl ?? DEFAULT_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': this.config.apiKey,
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

    const payload = await parseExaResponse(response, this.name)

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
        code: 'response',
        message:
          getErrorMessage(payload) ||
          `Search provider ${this.name} returned an unknown error.`,
      })
    }

    return payload
  }
}

function buildRequestBody(
  input: WebSearchInput,
  config: ExaSearchProviderConfig,
): ExaSearchRequest {
  const request: ExaSearchRequest = {
    query: input.query,
    numResults: clampResultCount(
      config.numResults,
      DEFAULT_NUM_RESULTS,
      MAX_NUM_RESULTS,
    ),
    contents: {
      highlights: {
        maxCharacters: clampResultCount(
          config.highlightMaxCharacters,
          DEFAULT_HIGHLIGHT_MAX_CHARACTERS,
          MAX_HIGHLIGHT_MAX_CHARACTERS,
        ),
      },
    },
  }

  if (config.searchType) {
    request.type = config.searchType
  }
  if (config.category) {
    request.category = config.category
  }
  if (config.userLocation) {
    request.userLocation = config.userLocation
  }
  if (input.allowed_domains?.length) {
    request.includeDomains = input.allowed_domains
  }
  if (input.blocked_domains?.length) {
    request.excludeDomains = input.blocked_domains
  }
  if (config.includeText?.length) {
    request.includeText = config.includeText
  }
  if (config.excludeText?.length) {
    request.excludeText = config.excludeText
  }
  if (config.moderation !== undefined) {
    request.moderation = config.moderation
  }

  return request
}

async function parseExaResponse(
  response: Response,
  providerName: string,
): Promise<ExaSearchResponse | null> {
  try {
    return (await response.json()) as ExaSearchResponse
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

function mapHits(items: ExaResult[]): SearchHitWithSnippet[] {
  return items
    .map(item => ({
      title: item.title?.trim() ?? '',
      url: item.url?.trim() ?? '',
      snippet: getSnippet(item),
    }))
    .filter(hit => hit.title.length > 0 && hit.url.length > 0)
}

function getSnippet(item: ExaResult): string | undefined {
  const highlight = item.highlights
    ?.map(value => value.trim())
    .find(value => value.length > 0)

  return (
    item.summary?.trim() ||
    highlight ||
    item.text?.trim()
  )
}

function getErrorMessage(payload: ExaSearchResponse | null): string | undefined {
  if (!payload?.error) {
    return undefined
  }

  if (typeof payload.error === 'string') {
    return payload.error
  }

  return payload.error.message || payload.error.code || payload.error.type
}

function getErrorCodeForResponse(
  status: number,
  payload: ExaSearchResponse | null,
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

  if (combined.includes('api key') || combined.includes('unauthorized')) {
    return 'auth' as const
  }
  if (combined.includes('quota') || combined.includes('rate limit')) {
    return 'rate_limit' as const
  }
  if (
    combined.includes('numresults') ||
    combined.includes('includedomains') ||
    combined.includes('excludedomains') ||
    combined.includes('category') ||
    combined.includes('userlocation') ||
    combined.includes('content')
  ) {
    return 'config' as const
  }

  return 'invalid_request' as const
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}
