/**
 * SessionSearchTool — snippet window picker (Stage 4 helper).
 *
 * Pure function. Selects an excerpt of `text` of at most `maxChars` chars
 * that maximizes coverage of query match positions. Ported from hermes
 * `_truncate_around_matches` (tools/session_search_tool.py:111-193) with
 * the same 4-strategy fallback ordering:
 *
 *   1. full-phrase match
 *   2. proximity co-occurrence (all terms within PROXIMITY_RANGE chars)
 *   3. individual term positions
 *   4. from start (no match found)
 *
 * Window bias: ~25% before the picked anchor, ~75% after — matches what
 * users typically want (pre-context for orientation, post-context for the
 * resolution / answer).
 *
 * Plan: see C:\Users\kiro\.claude\plans\ai-agent-harness-enginneering-hermes-ag-lucky-cloud.md
 */

const PROXIMITY_RANGE = 200

export interface SnippetWindow {
  /** The selected substring (no truncation markers prefixed/suffixed). */
  window: string
  /** True if window does not start at index 0. Caller may prefix marker. */
  earlierTruncated: boolean
  /** True if window does not end at text.length. Caller may suffix marker. */
  laterTruncated: boolean
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return []
  const positions: number[] = []
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    positions.push(idx)
    idx = haystack.indexOf(needle, idx + 1)
  }
  return positions
}

export function pickWindow(
  text: string,
  query: string,
  maxChars = 100_000,
): SnippetWindow {
  if (text.length <= maxChars) {
    return { window: text, earlierTruncated: false, laterTruncated: false }
  }

  const textLower = text.toLowerCase()
  const queryLower = query.toLowerCase().trim()
  let matchPositions: number[] = []

  // Strategy 1: full-phrase search
  if (queryLower) {
    matchPositions = findAllOccurrences(textLower, queryLower)
  }

  // Strategy 2: proximity co-occurrence of all terms
  if (matchPositions.length === 0) {
    const terms = queryLower.split(/\s+/).filter(Boolean)
    if (terms.length > 1) {
      const termPositions = new Map<string, number[]>()
      for (const t of terms) {
        termPositions.set(t, findAllOccurrences(textLower, t))
      }
      // Iterate positions of the rarest term and require all other terms
      // appear within PROXIMITY_RANGE chars.
      const rarest = [...termPositions.entries()].reduce((a, b) =>
        a[1].length <= b[1].length ? a : b,
      )
      for (const pos of rarest[1]) {
        const allClose = terms
          .filter(t => t !== rarest[0])
          .every(t =>
            (termPositions.get(t) ?? []).some(
              p => Math.abs(p - pos) < PROXIMITY_RANGE,
            ),
          )
        if (allClose) matchPositions.push(pos)
      }
    }
  }

  // Strategy 3: individual term positions
  if (matchPositions.length === 0) {
    const terms = queryLower.split(/\s+/).filter(Boolean)
    for (const t of terms) {
      for (const p of findAllOccurrences(textLower, t)) {
        matchPositions.push(p)
      }
    }
  }

  // Strategy 4: from start (no anchor at all)
  if (matchPositions.length === 0) {
    return {
      window: text.slice(0, maxChars),
      earlierTruncated: false,
      laterTruncated: maxChars < text.length,
    }
  }

  matchPositions.sort((a, b) => a - b)

  // Pick the window placement that covers the most match positions.
  // Bias: 25% of window before anchor, 75% after — caller-friendly default.
  const beforeBudget = Math.floor(maxChars / 4)
  let bestStart = 0
  let bestCount = 0
  for (const candidate of matchPositions) {
    let ws = Math.max(0, candidate - beforeBudget)
    let we = ws + maxChars
    if (we > text.length) {
      ws = Math.max(0, text.length - maxChars)
      we = text.length
    }
    const count = matchPositions.filter(p => p >= ws && p < we).length
    if (count > bestCount) {
      bestCount = count
      bestStart = ws
    }
  }

  const start = bestStart
  const end = Math.min(text.length, start + maxChars)

  return {
    window: text.slice(start, end),
    earlierTruncated: start > 0,
    laterTruncated: end < text.length,
  }
}
