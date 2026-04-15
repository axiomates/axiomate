/**
 * Provider-neutral rate limit tracking.
 *
 * Parses rate limit headers from any provider (OpenAI-compatible or
 * Anthropic-compatible) and stores the latest state for UI display.
 */
import { getHeader } from './headerUtils.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RateLimitInfo = {
  requestsLimit?: number
  requestsRemaining?: number
  requestsResetMs?: number
  tokensLimit?: number
  tokensRemaining?: number
  tokensResetMs?: number
  retryAfterMs?: number
  provider: string
  capturedAt: number
}

// ---------------------------------------------------------------------------
// State (module-level singleton)
// ---------------------------------------------------------------------------

let current: RateLimitInfo | null = null

export function updateRateLimitInfo(info: RateLimitInfo): void {
  current = info
}

export function getRateLimitInfo(): RateLimitInfo | null {
  return current
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Parse rate limit headers from any provider's response.
 * Returns null if no rate limit headers are found.
 *
 * Supports:
 * - OpenAI: x-ratelimit-limit-requests, x-ratelimit-remaining-requests, etc.
 * - Anthropic: anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, etc.
 * - Standard: retry-after
 */
export function parseRateLimitHeaders(
  headers: unknown,
  provider: string,
): RateLimitInfo | null {
  if (!headers || typeof headers !== 'object') return null

  // Try OpenAI-style headers first (most common for axiomate)
  const openai = parseOpenAIRateLimitHeaders(headers)
  // Then Anthropic-style
  const anthropic = parseAnthropicRateLimitHeaders(headers)
  // Standard retry-after
  const retryAfterMs = parseRetryAfterHeader(headers)

  // Merge: prefer whichever has data
  const merged: RateLimitInfo = {
    ...(openai ?? {}),
    ...(anthropic ?? {}),
    provider,
    capturedAt: Date.now(),
  }
  if (retryAfterMs != null) {
    merged.retryAfterMs = retryAfterMs
  }

  // Only return if we got at least one useful field
  if (
    merged.requestsLimit != null ||
    merged.requestsRemaining != null ||
    merged.tokensLimit != null ||
    merged.tokensRemaining != null ||
    merged.retryAfterMs != null
  ) {
    return merged
  }

  return null
}

// ---------------------------------------------------------------------------
// OpenAI-style headers
// ---------------------------------------------------------------------------

function parseOpenAIRateLimitHeaders(headers: unknown): Partial<RateLimitInfo> | null {
  const requestsLimit = parseNumHeader(headers, 'x-ratelimit-limit-requests')
  const requestsRemaining = parseNumHeader(headers, 'x-ratelimit-remaining-requests')
  const requestsResetMs = parseResetHeader(headers, 'x-ratelimit-reset-requests')
  const tokensLimit = parseNumHeader(headers, 'x-ratelimit-limit-tokens')
  const tokensRemaining = parseNumHeader(headers, 'x-ratelimit-remaining-tokens')
  const tokensResetMs = parseResetHeader(headers, 'x-ratelimit-reset-tokens')

  if (
    requestsLimit == null &&
    requestsRemaining == null &&
    tokensLimit == null &&
    tokensRemaining == null
  ) {
    return null
  }

  return {
    ...(requestsLimit != null && { requestsLimit }),
    ...(requestsRemaining != null && { requestsRemaining }),
    ...(requestsResetMs != null && { requestsResetMs }),
    ...(tokensLimit != null && { tokensLimit }),
    ...(tokensRemaining != null && { tokensRemaining }),
    ...(tokensResetMs != null && { tokensResetMs }),
  }
}

// ---------------------------------------------------------------------------
// Anthropic-style headers
// ---------------------------------------------------------------------------

function parseAnthropicRateLimitHeaders(headers: unknown): Partial<RateLimitInfo> | null {
  const requestsLimit = parseNumHeader(headers, 'anthropic-ratelimit-requests-limit')
  const requestsRemaining = parseNumHeader(headers, 'anthropic-ratelimit-requests-remaining')
  const requestsResetMs = parseResetHeader(headers, 'anthropic-ratelimit-requests-reset')
  const tokensLimit = parseNumHeader(headers, 'anthropic-ratelimit-tokens-limit')
  const tokensRemaining = parseNumHeader(headers, 'anthropic-ratelimit-tokens-remaining')
  const tokensResetMs = parseResetHeader(headers, 'anthropic-ratelimit-tokens-reset')

  if (
    requestsLimit == null &&
    requestsRemaining == null &&
    tokensLimit == null &&
    tokensRemaining == null
  ) {
    return null
  }

  return {
    ...(requestsLimit != null && { requestsLimit }),
    ...(requestsRemaining != null && { requestsRemaining }),
    ...(requestsResetMs != null && { requestsResetMs }),
    ...(tokensLimit != null && { tokensLimit }),
    ...(tokensRemaining != null && { tokensRemaining }),
    ...(tokensResetMs != null && { tokensResetMs }),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNumHeader(headers: unknown, name: string): number | undefined {
  const value = getHeader(headers, name)
  if (value == null) return undefined
  const num = parseInt(value, 10)
  return Number.isFinite(num) ? num : undefined
}

/**
 * Parse reset headers. Formats vary:
 * - OpenAI: "6m0s", "1s", "200ms" (duration string)
 * - Anthropic: "2026-04-15T10:00:00Z" (ISO timestamp)
 * - Some: plain seconds number
 */
function parseResetHeader(headers: unknown, name: string): number | undefined {
  const value = getHeader(headers, name)
  if (value == null) return undefined

  // ISO timestamp
  const asDate = Date.parse(value)
  if (!isNaN(asDate)) {
    const ms = asDate - Date.now()
    return ms > 0 ? ms : 0
  }

  // Duration string: "6m0s", "1s", "200ms"
  const durationMs = parseDurationString(value)
  if (durationMs != null) return durationMs

  // Plain seconds
  const seconds = parseFloat(value)
  if (Number.isFinite(seconds)) return seconds * 1000

  return undefined
}

function parseDurationString(value: string): number | undefined {
  let totalMs = 0
  let matched = false

  const hourMatch = value.match(/(\d+)h/)
  if (hourMatch?.[1]) { totalMs += parseInt(hourMatch[1], 10) * 3600_000; matched = true }

  const minMatch = value.match(/(\d+)m(?!s)/)
  if (minMatch?.[1]) { totalMs += parseInt(minMatch[1], 10) * 60_000; matched = true }

  const secMatch = value.match(/(\d+)s/)
  if (secMatch?.[1]) { totalMs += parseInt(secMatch[1], 10) * 1000; matched = true }

  const msMatch = value.match(/(\d+)ms/)
  if (msMatch?.[1]) { totalMs += parseInt(msMatch[1], 10); matched = true }

  return matched ? totalMs : undefined
}

function parseRetryAfterHeader(headers: unknown): number | undefined {
  const value = getHeader(headers, 'retry-after')
  if (value == null) return undefined
  const seconds = parseInt(value, 10)
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

// ---------------------------------------------------------------------------
// Convenience: utilization percentage
// ---------------------------------------------------------------------------

export function getRateLimitUtilizationPct(): number | undefined {
  if (!current) return undefined
  if (current.requestsRemaining != null && current.requestsLimit != null && current.requestsLimit > 0) {
    return Math.round((1 - current.requestsRemaining / current.requestsLimit) * 100)
  }
  if (current.tokensRemaining != null && current.tokensLimit != null && current.tokensLimit > 0) {
    return Math.round((1 - current.tokensRemaining / current.tokensLimit) * 100)
  }
  return undefined
}
