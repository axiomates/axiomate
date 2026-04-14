import { isWhitespace, looksLikeObjectBody, skipTriviaAt, stripBom } from './tolerantJsonParser.js'

export type JsonLikeToolNameCandidate = {
  name: string
  extractedName: string
  key: string
  position: number
  score: number
  confidence: 'high' | 'medium' | 'low'
  matchedKnownTool: boolean
  delimiter: ':' | '=' | 'missing'
}

export type JsonLikeToolNameExtractionOptions = {
  knownToolNames?: readonly string[]
  maxScanLength?: number
}

export type JsonLikeToolNameExtractionSuccess = {
  ok: true
  raw: string
  name: string
  candidate: JsonLikeToolNameCandidate
  candidates: JsonLikeToolNameCandidate[]
}

export type JsonLikeToolNameExtractionFailure = {
  ok: false
  raw: string
  candidates: JsonLikeToolNameCandidate[]
  error: string
}

export type JsonLikeToolNameExtractionResult =
  | JsonLikeToolNameExtractionSuccess
  | JsonLikeToolNameExtractionFailure

// ---------------------------------------------------------------------------
// Lightweight tokenizer for JSON-like text (tool name extraction)
// ---------------------------------------------------------------------------

type JsonLikeStringToken = {
  type: 'string'
  value: string
  start: number
  end: number
}

type JsonLikeBareToken = {
  type: 'bare'
  value: string
  start: number
  end: number
}

type JsonLikePunctuationToken = {
  type: 'punct'
  value: '{' | '}' | '[' | ']' | ':' | '=' | ',' | ';'
  start: number
  end: number
}

type JsonLikePunctuation = JsonLikePunctuationToken['value']

type JsonLikeToken =
  | JsonLikeStringToken
  | JsonLikeBareToken
  | JsonLikePunctuationToken

const DEFAULT_TOOL_NAME_SCAN_LENGTH = 64_000
const COMMON_NON_TOOL_NAMES = new Set([
  'function',
  'server_tool_use',
  'tool_call',
  'tool_calls',
  'tool_use',
])

function isJsonLikeQuote(ch: string | undefined): boolean {
  return (
    ch === '"' ||
    ch === "'" ||
    ch === '\u201c' ||
    ch === '\u201d' ||
    ch === '\u2018' ||
    ch === '\u2019'
  )
}

function closingQuoteFor(openingQuote: string): string {
  switch (openingQuote) {
    case '\u201c':
      return '\u201d'
    case '\u2018':
      return '\u2019'
    default:
      return openingQuote
  }
}

function isJsonLikePunctuation(
  ch: string | undefined,
): ch is JsonLikePunctuation {
  return (
    ch === '{' ||
    ch === '}' ||
    ch === '[' ||
    ch === ']' ||
    ch === ':' ||
    ch === '=' ||
    ch === ',' ||
    ch === ';'
  )
}

function tokenizeJsonLikeText(source: string): JsonLikeToken[] {
  const tokens: JsonLikeToken[] = []
  let index = 0

  while (index < source.length) {
    index = skipTriviaAt(source, index)
    if (index >= source.length) break

    const ch = source[index]
    if (isJsonLikePunctuation(ch)) {
      tokens.push({
        type: 'punct',
        value: ch,
        start: index,
        end: index + 1,
      })
      index++
      continue
    }

    if (isJsonLikeQuote(ch)) {
      const parsed = readJsonLikeStringToken(source, index)
      tokens.push(parsed.token)
      index = parsed.nextIndex
      continue
    }

    const start = index
    while (
      index < source.length &&
      !isWhitespace(source[index]) &&
      !isJsonLikePunctuation(source[index]) &&
      !isJsonLikeQuote(source[index])
    ) {
      index++
    }

    const value = source.slice(start, index).trim()
    if (value) {
      tokens.push({
        type: 'bare',
        value,
        start,
        end: index,
      })
    } else {
      index++
    }
  }

  return tokens
}

function readJsonLikeStringToken(
  source: string,
  start: number,
): {
  token: JsonLikeStringToken
  nextIndex: number
} {
  const openingQuote = source[start]
  const closingQuote = closingQuoteFor(openingQuote)
  let index = start + 1
  let value = ''

  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      const next = source[index + 1]
      if (next === undefined) {
        value += '\\'
        index++
        break
      }
      value += next
      index += 2
      continue
    }

    if (ch === closingQuote) {
      return {
        token: {
          type: 'string',
          value,
          start,
          end: index + 1,
        },
        nextIndex: index + 1,
      }
    }

    if (
      (ch === ',' && looksLikeObjectBody(source, index + 1)) ||
      ch === '}' ||
      ch === ']' ||
      ch === '\n' ||
      ch === '\r'
    ) {
      return {
        token: {
          type: 'string',
          value: value.trimEnd(),
          start,
          end: index,
        },
        nextIndex: index,
      }
    }

    value += ch
    index++
  }

  return {
    token: {
      type: 'string',
      value: value.trimEnd(),
      start,
      end: index,
    },
    nextIndex: index,
  }
}

// ---------------------------------------------------------------------------
// Tool name key/value detection
// ---------------------------------------------------------------------------

function normalizeToolNameKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

export function isLikelyToolNameKey(key: string): boolean {
  const normalized = normalizeToolNameKey(key)
  return (
    normalized === 'name' ||
    normalized === 'tool' ||
    normalized === 'toolname' ||
    normalized === 'functionname' ||
    normalized === 'recipientname'
  )
}

export function normalizeToolNameForFuzzyMatch(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function buildKnownToolNameMatcher(
  knownToolNames: readonly string[],
): (name: string) => string | null {
  const exact = new Map<string, string>()
  const lower = new Map<string, string | null>()
  const fuzzy = new Map<string, string | null>()

  for (const name of knownToolNames) {
    exact.set(name, name)

    const lowerName = name.toLowerCase()
    lower.set(lowerName, lower.has(lowerName) ? null : name)

    const fuzzyName = normalizeToolNameForFuzzyMatch(name)
    fuzzy.set(fuzzyName, fuzzy.has(fuzzyName) ? null : name)
  }

  return (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return null

    const exactMatch = exact.get(trimmed)
    if (exactMatch) return exactMatch

    const lowerMatch = lower.get(trimmed.toLowerCase())
    if (lowerMatch) return lowerMatch

    const fuzzyMatch = fuzzy.get(normalizeToolNameForFuzzyMatch(trimmed))
    return fuzzyMatch ?? null
  }
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

function scoreToolNameCandidate(
  source: string,
  key: string,
  extractedName: string,
  position: number,
  delimiter: JsonLikeToolNameCandidate['delimiter'],
  matchedKnownTool: boolean,
): number {
  const normalizedKey = normalizeToolNameKey(key)
  let score = matchedKnownTool ? 100 : 0

  switch (normalizedKey) {
    case 'toolname':
    case 'functionname':
    case 'recipientname':
      score += 60
      break
    case 'name':
      score += 45
      break
    case 'tool':
      score += 30
      break
    default:
      score += 0
  }

  if (delimiter === ':') {
    score += 12
  } else if (delimiter === '=') {
    score += 8
  } else {
    score -= 8
  }

  const window = source
    .slice(Math.max(0, position - 120), Math.min(source.length, position + 120))
    .toLowerCase()

  if (
    window.includes('tool_use') ||
    window.includes('server_tool_use') ||
    window.includes('tool_calls') ||
    window.includes('tool_call')
  ) {
    score += 30
  }

  if (window.includes('function')) {
    score += 18
  }

  if (window.includes('input') || window.includes('arguments')) {
    score += 8
  }

  const lowerName = extractedName.toLowerCase()
  if (COMMON_NON_TOOL_NAMES.has(lowerName)) {
    score -= 80
  }

  if (!matchedKnownTool && /\s/.test(extractedName.trim())) {
    score -= 25
  }

  if (extractedName.length > 120) {
    score -= 50
  }

  return score
}

// Confidence thresholds calibrated against common model output patterns:
// >= 130: known tool + strong key ("name") + structural context ("tool_use")
// >= 70:  known tool OR strong key with structural context
// < 70:   low confidence, unlikely to be a real tool name
function confidenceForToolNameScore(
  score: number,
): JsonLikeToolNameCandidate['confidence'] {
  if (score >= 130) return 'high'
  if (score >= 70) return 'medium'
  return 'low'
}

function compareToolNameCandidates(
  a: JsonLikeToolNameCandidate,
  b: JsonLikeToolNameCandidate,
): number {
  if (a.matchedKnownTool !== b.matchedKnownTool) {
    return a.matchedKnownTool ? -1 : 1
  }
  if (a.score !== b.score) return b.score - a.score
  if (a.delimiter !== b.delimiter) {
    if (a.delimiter === ':') return -1
    if (b.delimiter === ':') return 1
    if (a.delimiter === '=') return -1
    if (b.delimiter === '=') return 1
  }
  return a.position - b.position
}

function collectToolNameCandidatesFromTokens(
  source: string,
  tokens: JsonLikeToken[],
  knownToolNames: readonly string[],
): JsonLikeToolNameCandidate[] {
  const matchKnownToolName = buildKnownToolNameMatcher(knownToolNames)
  const candidates: JsonLikeToolNameCandidate[] = []

  for (let i = 0; i < tokens.length - 1; i++) {
    const keyToken = tokens[i]
    if (
      (keyToken.type !== 'string' && keyToken.type !== 'bare') ||
      !isLikelyToolNameKey(keyToken.value)
    ) {
      continue
    }

    const next = tokens[i + 1]
    let delimiter: JsonLikeToolNameCandidate['delimiter'] = 'missing'
    let valueToken = next

    if (
      next?.type === 'punct' &&
      (next.value === ':' || next.value === '=')
    ) {
      delimiter = next.value
      valueToken = tokens[i + 2]
    }

    if (!valueToken || valueToken.type === 'punct') {
      continue
    }

    const extractedName = valueToken.value.trim()
    if (!extractedName) {
      continue
    }

    const canonicalName = matchKnownToolName(extractedName)
    const matchedKnownTool = canonicalName !== null
    const score = scoreToolNameCandidate(
      source,
      keyToken.value,
      extractedName,
      keyToken.start,
      delimiter,
      matchedKnownTool,
    )

    candidates.push({
      name: canonicalName ?? extractedName,
      extractedName,
      key: keyToken.value,
      position: keyToken.start,
      score,
      confidence: confidenceForToolNameScore(score),
      matchedKnownTool,
      delimiter,
    })
  }

  return candidates.sort(compareToolNameCandidates)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractToolNameFromJsonLikeText(
  raw: string,
  options: JsonLikeToolNameExtractionOptions = {},
): JsonLikeToolNameExtractionResult {
  const scanLimit = options.maxScanLength ?? DEFAULT_TOOL_NAME_SCAN_LENGTH
  const source = stripBom(raw).slice(0, scanLimit)
  const knownToolNames = options.knownToolNames ?? []
  const tokens = tokenizeJsonLikeText(source)
  const candidates = collectToolNameCandidatesFromTokens(
    source,
    tokens,
    knownToolNames,
  )

  const viableCandidates =
    knownToolNames.length > 0
      ? candidates.filter(candidate => candidate.matchedKnownTool)
      : candidates.filter(candidate => candidate.score >= 70)

  const candidate = viableCandidates[0]
  if (!candidate) {
    return {
      ok: false,
      raw,
      candidates,
      error:
        knownToolNames.length > 0
          ? 'No tool name matched the known tool list'
          : 'No high-confidence tool name found',
    }
  }

  return {
    ok: true,
    raw,
    name: candidate.name,
    candidate,
    candidates,
  }
}
