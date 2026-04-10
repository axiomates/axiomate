import type { SearchHit, WebSearchInput } from '../types.js'

export type SearchRun = {
  query: string
  summaryLabel: string
}

export type SearchHitWithSnippet = SearchHit & {
  snippet?: string
}

const MAX_SUMMARY_RESULTS = 5
const MAX_SNIPPET_LENGTH = 280

export function buildSearchRuns(input: WebSearchInput): SearchRun[] {
  const blockedDomains = normalizeDomains(input.blocked_domains)
  const allowedDomains = normalizeDomains(input.allowed_domains)

  if (allowedDomains.length > 0) {
    return allowedDomains.map(domain => {
      const query = buildProviderQuery(input.query, domain, blockedDomains)
      return {
        query,
        summaryLabel: query,
      }
    })
  }

  return [
    {
      query: buildProviderQuery(input.query, undefined, blockedDomains),
      summaryLabel: input.query,
    },
  ]
}

export function buildProviderQuery(
  query: string,
  allowedDomain: string | undefined,
  blockedDomains: string[],
): string {
  const parts = [query.trim()]

  if (allowedDomain) {
    parts.push(`site:${allowedDomain}`)
  }

  for (const blockedDomain of blockedDomains) {
    parts.push(`-site:${blockedDomain}`)
  }

  return parts.join(' ').trim()
}

export function filterHits<T extends SearchHit>(
  hits: T[],
  allowedDomains?: string[],
  blockedDomains?: string[],
): T[] {
  const allowed = normalizeDomains(allowedDomains)
  const blocked = normalizeDomains(blockedDomains)

  return hits.filter(hit => {
    const hostname = extractHostname(hit.url)
    if (!hostname) {
      return false
    }

    if (allowed.length > 0 && !allowed.some(domain => hostMatches(hostname, domain))) {
      return false
    }

    if (blocked.some(domain => hostMatches(hostname, domain))) {
      return false
    }

    return true
  })
}

export function buildSummary(
  label: string,
  hits: SearchHitWithSnippet[],
): string {
  if (hits.length === 0) {
    return `No results found for "${label}".`
  }

  const summaryLines = hits
    .slice(0, MAX_SUMMARY_RESULTS)
    .map((hit, index) => {
      const snippet = truncateSnippet(hit.snippet ?? 'No snippet available.')
      return `${index + 1}. ${hit.title}: ${snippet}`
    })

  return `Search snippets for "${label}":\n${summaryLines.join('\n')}`
}

export function clampResultCount(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (!value || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(1, Math.min(max, Math.trunc(value)))
}

function truncateSnippet(snippet: string): string {
  const collapsed = snippet.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_SNIPPET_LENGTH) {
    return collapsed
  }
  return collapsed.slice(0, MAX_SNIPPET_LENGTH - 3).trimEnd() + '...'
}

function normalizeDomains(domains?: string[]): string[] {
  return (domains ?? [])
    .map(normalizeDomain)
    .filter((domain, index, all) => domain.length > 0 && all.indexOf(domain) === index)
}

function normalizeDomain(domain: string): string {
  const value = domain.trim().toLowerCase()
  if (!value) {
    return ''
  }

  try {
    const normalizedUrl = value.includes('://') ? value : `https://${value}`
    return new URL(normalizedUrl).hostname.toLowerCase()
  } catch {
    return value
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .trim()
  }
}

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}
