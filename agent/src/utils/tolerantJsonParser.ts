export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type JsonRepairKind =
  | 'stripped_code_fence'
  | 'stripped_leading_prose'
  | 'ignored_trailing_junk'
  | 'wrapped_root_object'
  | 'wrapped_root_array'
  | 'inserted_missing_colon'
  | 'inserted_missing_comma'
  | 'treated_semicolon_as_comma'
  | 'treated_equals_as_colon'
  | 'quoted_bare_key'
  | 'accepted_single_quoted_string'
  | 'closed_unterminated_string'
  | 'repaired_invalid_escape'
  | 'normalized_nonstandard_literal'
  | 'treated_bareword_as_string'
  | 'inserted_missing_value'
  | 'inserted_closing_brace'
  | 'inserted_closing_bracket'
  | 'ignored_mismatched_closer'
  | 'removed_trailing_comma'
  | 'skipped_extra_separator'

export type JsonRepair = {
  kind: JsonRepairKind
  position: number
  message: string
}

export type JsonAstNode =
  | { type: 'object'; properties: Array<{ key: string; value: JsonAstNode }> }
  | { type: 'array'; items: JsonAstNode[] }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number; raw: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null'; value: null }

export type JsonRepairOptions = {
  maxRepairs?: number
  maxDepth?: number
}

export type JsonRepairSuccess = {
  ok: true
  raw: string
  repairedText: string
  value: JsonValue
  ast: JsonAstNode
  repairs: JsonRepair[]
}

export type JsonRepairFailure = {
  ok: false
  raw: string
  repairedText: null
  value: null
  ast: null
  repairs: JsonRepair[]
  error: string
}

export type JsonRepairResult = JsonRepairSuccess | JsonRepairFailure

type RootMode = 'normal' | 'synthetic_object' | 'synthetic_array'

type Candidate = {
  ok: true
  ast: JsonAstNode
  repairs: JsonRepair[]
  parser: TolerantJsonParser
  score: number
}

export const DEFAULT_MAX_DEPTH = 64
const DEFAULT_MAX_REPAIRS = 128
const VALID_STRING_ESCAPES = new Set([
  '"',
  "'",
  '\\',
  '/',
  'b',
  'f',
  'n',
  'r',
  't',
])

class RepairBudgetExceededError extends Error {
  constructor() {
    super('JSON repair budget exceeded')
  }
}

export function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

export function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isNumberStart(ch: string | undefined): boolean {
  return ch === '-' || isDigit(ch)
}

function isIdentifierStart(ch: string | undefined): boolean {
  return (
    ch !== undefined &&
    ((ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      ch === '_' ||
      ch === '$')
  )
}

function isIdentifierPart(ch: string | undefined): boolean {
  return (
    isIdentifierStart(ch) ||
    isDigit(ch) ||
    ch === '-' ||
    ch === '.'
  )
}

function isValueStart(ch: string | undefined): boolean {
  return (
    ch === '{' ||
    ch === '[' ||
    ch === '"' ||
    ch === "'" ||
    isNumberStart(ch) ||
    isIdentifierStart(ch)
  )
}

function astToValue(node: JsonAstNode): JsonValue {
  switch (node.type) {
    case 'object':
      return Object.fromEntries(
        node.properties.map(property => [
          property.key,
          astToValue(property.value),
        ]),
      )
    case 'array':
      return node.items.map(item => astToValue(item))
    case 'string':
      return node.value
    case 'number':
      return node.value
    case 'boolean':
      return node.value
    case 'null':
      return null
  }
}

function valueToAst(value: JsonValue): JsonAstNode {
  if (value === null) {
    return { type: 'null', value: null }
  }

  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.map(item => valueToAst(item)),
    }
  }

  switch (typeof value) {
    case 'string':
      return { type: 'string', value }
    case 'number':
      return { type: 'number', value, raw: String(value) }
    case 'boolean':
      return { type: 'boolean', value }
    case 'object':
      return {
        type: 'object',
        properties: Object.entries(value).map(([key, propertyValue]) => ({
          key,
          value: valueToAst(propertyValue),
        })),
      }
  }
}

function preprocessSource(raw: string): Array<{
  source: string
  repairs: JsonRepair[]
}> {
  const base = stripBom(raw).trim()
  const candidates = new Map<string, JsonRepair[]>()

  const addCandidate = (source: string, repairs: JsonRepair[]) => {
    const trimmed = source.trim()
    if (!trimmed) return
    if (!candidates.has(trimmed)) {
      candidates.set(trimmed, repairs)
    }
  }

  addCandidate(base, [])

  const fenced = extractCodeFence(base)
  if (fenced && fenced.content.trim()) {
    addCandidate(fenced.content, [
      {
        kind: 'stripped_code_fence',
        position: fenced.position,
        message: 'Removed markdown code fence wrapper',
      },
    ])
  }

  for (const source of Array.from(candidates.keys())) {
    const leadingStructural = findLeadingStructuralStart(source)
    if (leadingStructural > 0) {
      addCandidate(source.slice(leadingStructural), [
        ...(candidates.get(source) ?? []),
        {
          kind: 'stripped_leading_prose',
          position: 0,
          message: 'Skipped leading prose before likely JSON payload',
        },
      ])
    }
  }

  return Array.from(candidates.entries()).map(([source, repairs]) => ({
    source,
    repairs,
  }))
}

function extractCodeFence(source: string):
  | { content: string; position: number }
  | null {
  const fullFenceMatch =
    source.match(/^```[^\n]*\n([\s\S]*?)\n```$/)
  if (fullFenceMatch) {
    return { content: fullFenceMatch[1] ?? '', position: 0 }
  }

  const firstFence = source.indexOf('```')
  if (firstFence === -1) return null
  const afterFenceHeader = source.indexOf('\n', firstFence)
  if (afterFenceHeader === -1) return null
  const lastFence = source.lastIndexOf('```')
  if (lastFence <= afterFenceHeader) return null
  return {
    content: source.slice(afterFenceHeader + 1, lastFence),
    position: firstFence,
  }
}

function findLeadingStructuralStart(source: string): number {
  const objectOrArray = source.search(/[{\[]/)
  if (objectOrArray > 0) return objectOrArray

  const quotedObjectBody = source.search(/["'][^"'\n\r]*["']\s*:/)
  if (quotedObjectBody > 0) return quotedObjectBody

  const bareObjectBody = source.search(/[A-Za-z_$][\w$.-]*\s*:/)
  if (bareObjectBody > 0) return bareObjectBody

  return 0
}

function tryParseCandidate(
  source: string,
  preRepairs: JsonRepair[],
  options: Required<JsonRepairOptions>,
  mode: RootMode,
): Candidate | null {
  try {
    const parser = new TolerantJsonParser(source, options, preRepairs)
    const ast = parser.parseDocument(mode)
    const leftover = parser.remainingNonTriviaLength()

    if (
      mode === 'normal' &&
      parser.hadTrailingJunk &&
      (ast.type === 'string' ||
        ast.type === 'number' ||
        ast.type === 'boolean' ||
        ast.type === 'null')
    ) {
      return null
    }

    const score =
      parser.scoreIndex -
      leftover * 5 -
      parser.repairs.length * 2 -
      (mode === 'normal' ? 0 : 3)

    if (mode === 'synthetic_array' && ast.type === 'array') {
      if (
        (ast.items.length <= 1 && !parser.seenSeparator) ||
        !hasStrongArraySignal(source)
      ) {
        return null
      }
    }

    if (mode === 'synthetic_object' && ast.type === 'object') {
      if (ast.properties.length === 0) {
        return null
      }
    }

    return {
      ok: true,
      ast,
      repairs: parser.repairs,
      parser,
      score,
    }
  } catch {
    return null
  }
}

function chooseBestCandidate(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null
  return candidates.reduce((best, current) => {
    if (current.score > best.score) return current
    if (current.score < best.score) return best
    if (current.repairs.length < best.repairs.length) return current
    if (current.parser.index > best.parser.index) return current
    return best
  })
}

export function repairJsonText(
  raw: string,
  options: JsonRepairOptions = {},
): JsonRepairResult {
  const normalizedOptions: Required<JsonRepairOptions> = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxRepairs: options.maxRepairs ?? DEFAULT_MAX_REPAIRS,
  }

  if (!raw.trim()) {
    return {
      ok: false,
      raw,
      repairedText: null,
      value: null,
      ast: null,
      repairs: [],
      error: 'Input is empty',
    }
  }

  try {
    const parsed = JSON.parse(raw) as JsonValue
    return {
      ok: true,
      raw,
      repairedText: raw,
      value: parsed,
      ast: valueToAst(parsed),
      repairs: [],
    }
  } catch {
    // Fall through to tolerant repair mode.
  }

  const preparedSources = preprocessSource(raw)
  const parsedCandidates: Candidate[] = []

  for (const prepared of preparedSources) {
    const source = prepared.source
    const modes: RootMode[] = ['normal']
    const trimmed = source.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      if (looksLikeObjectBody(trimmed, 0)) {
        modes.unshift('synthetic_object')
      }
      modes.push('synthetic_array')
    }

    for (const mode of modes) {
      const parsed = tryParseCandidate(
        source,
        prepared.repairs,
        normalizedOptions,
        mode,
      )
      if (parsed) {
        parsedCandidates.push(parsed)
      }
    }
  }

  const best = chooseBestCandidate(parsedCandidates)
  if (!best) {
    return {
      ok: false,
      raw,
      repairedText: null,
      value: null,
      ast: null,
      repairs: [],
      error: 'Unable to repair JSON safely',
    }
  }

  const value = astToValue(best.ast)
  return {
    ok: true,
    raw,
    repairedText: JSON.stringify(value),
    value,
    ast: best.ast,
    repairs: best.repairs,
  }
}

class TolerantJsonParser {
  readonly source: string
  readonly maxDepth: number
  readonly maxRepairs: number
  readonly repairs: JsonRepair[]
  index = 0
  scoreIndex = 0
  seenSeparator = false
  hadTrailingJunk = false

  constructor(
    source: string,
    options: Required<JsonRepairOptions>,
    preRepairs: JsonRepair[],
  ) {
    this.source = source
    this.maxDepth = options.maxDepth
    this.maxRepairs = options.maxRepairs
    this.repairs = [...preRepairs]
  }

  parseDocument(mode: RootMode): JsonAstNode {
    this.skipTrivia()
    const ast =
      mode === 'synthetic_object'
        ? (() => {
            this.repair(
              'wrapped_root_object',
              this.index,
              'Wrapped root payload in an object',
            )
            return this.parseObject(true, 0)
          })()
        : mode === 'synthetic_array'
          ? (() => {
              this.repair(
                'wrapped_root_array',
                this.index,
                'Wrapped root payload in an array',
              )
              return this.parseArray(true, 0)
            })()
          : this.parseValue(0)

    this.skipTrivia()
    while (this.peek() === '}' || this.peek() === ']') {
      const closer = this.peek()!
      this.repair(
        'ignored_mismatched_closer',
        this.index,
        `Ignored extra closing token '${closer}' at root`,
      )
      this.index++
      this.skipTrivia()
    }

    this.scoreIndex = this.index

    if (!this.eof()) {
      this.hadTrailingJunk = true
      this.repair(
        'ignored_trailing_junk',
        this.index,
        'Ignored trailing non-JSON content after parsed value',
      )
      this.index = this.source.length
    }

    return ast
  }

  remainingNonTriviaLength(): number {
    let i = this.index
    while (i < this.source.length) {
      if (isWhitespace(this.source[i])) {
        i++
        continue
      }
      if (this.source[i] === '/' && this.source[i + 1] === '/') {
        i += 2
        while (i < this.source.length && this.source[i] !== '\n') i++
        continue
      }
      if (this.source[i] === '/' && this.source[i + 1] === '*') {
        i += 2
        while (i + 1 < this.source.length) {
          if (this.source[i] === '*' && this.source[i + 1] === '/') {
            i += 2
            break
          }
          i++
        }
        continue
      }
      break
    }
    return this.source.length - i
  }

  private parseValue(depth: number): JsonAstNode {
    if (depth > this.maxDepth) {
      throw new Error('Maximum JSON nesting depth exceeded')
    }

    this.skipTrivia()

    if (this.eof()) {
      return this.insertMissingValue()
    }

    const ch = this.peek()
    if (ch === '{') return this.parseObject(false, depth + 1)
    if (ch === '[') return this.parseArray(false, depth + 1)
    if (ch === '"' || ch === "'") return this.parseString()

    if (ch === ',' || ch === ';' || ch === '}' || ch === ']') {
      return this.insertMissingValue()
    }

    if (isNumberStart(ch)) {
      const numberNode = this.tryParseNumber()
      if (numberNode) return numberNode
    }

    return this.parseBareToken()
  }

  private parseObject(
    synthetic: boolean,
    depth: number,
  ): JsonAstNode {
    if (!synthetic) {
      this.expect('{')
    }

    const properties: Array<{ key: string; value: JsonAstNode }> = []
    this.skipTrivia()

    while (!this.eof()) {
      this.skipTrivia()

      const current = this.peek()
      if (current === '}') {
        this.index++
        return { type: 'object', properties }
      }
      if (current === ']') {
        this.repair(
          'ignored_mismatched_closer',
          this.index,
          "Closed object after mismatched ']'",
        )
        this.index++
        return { type: 'object', properties }
      }
      if (current === ',' || current === ';') {
        this.repair(
          current === ';' ? 'treated_semicolon_as_comma' : 'skipped_extra_separator',
          this.index,
          `Skipped unexpected separator '${current}' in object`,
        )
        this.index++
        this.seenSeparator = true
        continue
      }

      const key = this.parseObjectKey()
      this.skipTrivia()

      if (this.peek() === ':') {
        this.index++
      } else if (this.peek() === '=') {
        this.repair(
          'treated_equals_as_colon',
          this.index,
          "Treated '=' as ':' between key and value",
        )
        this.index++
      } else {
        this.repair(
          'inserted_missing_colon',
          this.index,
          'Inserted missing colon between object key and value',
        )
      }

      const value = this.parseValue(depth + 1)
      properties.push({ key, value })
      this.skipTrivia()

      const separator = this.peek()
      if (separator === ',') {
        this.index++
        this.seenSeparator = true
        this.skipTrivia()
        if (this.peek() === '}' || this.peek() === ']' || this.eof()) {
          this.repair(
            'removed_trailing_comma',
            this.index - 1,
            'Removed trailing comma in object',
          )
        }
        continue
      }
      if (separator === ';') {
        this.repair(
          'treated_semicolon_as_comma',
          this.index,
          "Treated ';' as ',' between object properties",
        )
        this.index++
        this.seenSeparator = true
        this.skipTrivia()
        if (this.peek() === '}' || this.peek() === ']' || this.eof()) {
          this.repair(
            'removed_trailing_comma',
            this.index - 1,
            'Removed trailing separator in object',
          )
        }
        continue
      }
      if (separator === '}') {
        this.index++
        return { type: 'object', properties }
      }
      if (separator === ']') {
        this.repair(
          'ignored_mismatched_closer',
          this.index,
          "Closed object after mismatched ']'",
        )
        this.index++
        return { type: 'object', properties }
      }
      if (this.eof()) {
        if (!synthetic) {
          this.repair(
            'inserted_closing_brace',
            this.index,
            "Inserted missing closing '}'",
          )
        }
        return { type: 'object', properties }
      }
      if (looksLikeObjectBody(this.source, this.index)) {
        this.repair(
          'inserted_missing_comma',
          this.index,
          'Inserted missing comma between object properties',
        )
        continue
      }

      this.repair(
        'ignored_trailing_junk',
        this.index,
        'Stopped object parsing at unexpected token',
      )
      return { type: 'object', properties }
    }

    if (!synthetic) {
      this.repair(
        'inserted_closing_brace',
        this.index,
        "Inserted missing closing '}'",
      )
    }
    return { type: 'object', properties }
  }

  private parseArray(
    synthetic: boolean,
    depth: number,
  ): JsonAstNode {
    if (!synthetic) {
      this.expect('[')
    }

    const items: JsonAstNode[] = []
    this.skipTrivia()

    while (!this.eof()) {
      this.skipTrivia()

      const current = this.peek()
      if (current === ']') {
        this.index++
        return { type: 'array', items }
      }
      if (current === '}') {
        this.repair(
          'ignored_mismatched_closer',
          this.index,
          "Closed array after mismatched '}'",
        )
        this.index++
        return { type: 'array', items }
      }
      if (current === ',' || current === ';') {
        this.repair(
          current === ';' ? 'treated_semicolon_as_comma' : 'skipped_extra_separator',
          this.index,
          `Skipped unexpected separator '${current}' in array`,
        )
        this.index++
        this.seenSeparator = true
        continue
      }

      const value = this.parseValue(depth + 1)
      items.push(value)
      this.skipTrivia()

      const separator = this.peek()
      if (separator === ',') {
        this.index++
        this.seenSeparator = true
        this.skipTrivia()
        if (this.peek() === ']' || this.peek() === '}' || this.eof()) {
          this.repair(
            'removed_trailing_comma',
            this.index - 1,
            'Removed trailing comma in array',
          )
        }
        continue
      }
      if (separator === ';') {
        this.repair(
          'treated_semicolon_as_comma',
          this.index,
          "Treated ';' as ',' between array items",
        )
        this.index++
        this.seenSeparator = true
        this.skipTrivia()
        if (this.peek() === ']' || this.peek() === '}' || this.eof()) {
          this.repair(
            'removed_trailing_comma',
            this.index - 1,
            'Removed trailing separator in array',
          )
        }
        continue
      }
      if (separator === ']') {
        this.index++
        return { type: 'array', items }
      }
      if (separator === '}') {
        this.repair(
          'ignored_mismatched_closer',
          this.index,
          "Closed array after mismatched '}'",
        )
        this.index++
        return { type: 'array', items }
      }
      if (this.eof()) {
        if (!synthetic) {
          this.repair(
            'inserted_closing_bracket',
            this.index,
            "Inserted missing closing ']'",
          )
        }
        return { type: 'array', items }
      }
      if (isValueStartAt(this.source, this.index)) {
        this.repair(
          'inserted_missing_comma',
          this.index,
          'Inserted missing comma between array items',
        )
        continue
      }

      this.repair(
        'ignored_trailing_junk',
        this.index,
        'Stopped array parsing at unexpected token',
      )
      return { type: 'array', items }
    }

    if (!synthetic) {
      this.repair(
        'inserted_closing_bracket',
        this.index,
        "Inserted missing closing ']'",
      )
    }
    return { type: 'array', items }
  }

  private parseObjectKey(): string {
    this.skipTrivia()
    const ch = this.peek()

    if (ch === '"' || ch === "'") {
      const stringNode = this.parseString()
      return stringNode.value
    }

    const start = this.index
    while (
      !this.eof() &&
      !isWhitespace(this.peek()) &&
      this.peek() !== ':' &&
      this.peek() !== '=' &&
      this.peek() !== ',' &&
      this.peek() !== ';' &&
      this.peek() !== '}' &&
      this.peek() !== ']' &&
      this.peek() !== '{' &&
      this.peek() !== '['
    ) {
      this.index++
    }

    const token = this.source.slice(start, this.index).trim()
    if (!token) {
      this.repair(
        'quoted_bare_key',
        start,
        'Inserted placeholder key for missing object key',
      )
      return ''
    }

    this.repair(
      'quoted_bare_key',
      start,
      `Quoted bare object key '${token}'`,
    )
    return token
  }

  private parseString(): Extract<JsonAstNode, { type: 'string' }> {
    const quote = this.peek() as '"' | "'"
    const start = this.index
    if (quote === "'") {
      this.repair(
        'accepted_single_quoted_string',
        this.index,
        'Accepted single-quoted string',
      )
    }
    this.index++

    let value = ''
    while (!this.eof()) {
      const ch = this.peek()

      if (ch === quote) {
        this.index++
        return { type: 'string', value }
      }

      if (ch === '\\') {
        const escaped = this.consumeEscapeSequence()
        value += escaped
        continue
      }

      if (ch === '\n' || ch === '\r') {
        if (this.shouldAutoCloseStringAt(this.index, quote!)) {
          this.repair(
            'closed_unterminated_string',
            start,
            'Closed unterminated string before newline',
          )
          return { type: 'string', value }
        }
        value += ch
        this.index++
        continue
      }

      if (this.shouldAutoCloseStringAt(this.index, quote!)) {
        this.repair(
          'closed_unterminated_string',
          start,
          'Closed unterminated string before structural token',
        )
        return { type: 'string', value }
      }

      value += ch
      this.index++
    }

    this.repair(
      'closed_unterminated_string',
      start,
      'Closed unterminated string at end of input',
    )
    return { type: 'string', value }
  }

  private consumeEscapeSequence(): string {
    const start = this.index
    this.expect('\\')

    if (this.eof()) {
      this.repair(
        'repaired_invalid_escape',
        start,
        'Dropped dangling backslash at end of string',
      )
      return '\\'
    }

    const next = this.peek()!
    this.index++

    if (VALID_STRING_ESCAPES.has(next)) {
      switch (next) {
        case '"':
        case "'":
        case '\\':
        case '/':
          return next
        case 'b':
          return '\b'
        case 'f':
          return '\f'
        case 'n':
          return '\n'
        case 'r':
          return '\r'
        case 't':
          return '\t'
      }
    }

    if (next === 'u') {
      const hex = this.source.slice(this.index, this.index + 4)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        this.index += 4
        return String.fromCharCode(parseInt(hex, 16))
      }
      this.repair(
        'repaired_invalid_escape',
        start,
        'Repaired incomplete unicode escape in string',
      )
      return 'u'
    }

    this.repair(
      'repaired_invalid_escape',
      start,
      `Recovered invalid escape sequence '\\${next}'`,
    )
    return next
  }

  private tryParseNumber(): Extract<JsonAstNode, { type: 'number' }> | null {
    const remaining = this.source.slice(this.index)
    const match = remaining.match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
    )
    if (!match || !match[0]) return null

    const raw = match[0]
    const value = Number(raw)
    if (!Number.isFinite(value)) return null

    this.index += raw.length
    return { type: 'number', value, raw }
  }

  private parseBareToken(): JsonAstNode {
    const start = this.index
    while (
      !this.eof() &&
      !isWhitespace(this.peek()) &&
      this.peek() !== ',' &&
      this.peek() !== ';' &&
      this.peek() !== '}' &&
      this.peek() !== ']' &&
      this.peek() !== ':' &&
      this.peek() !== '='
    ) {
      this.index++
    }

    const token = this.source.slice(start, this.index)
    const lower = token.toLowerCase()
    if (lower === 'true' || lower === 'false') {
      if (token !== lower) {
        this.repair(
          'normalized_nonstandard_literal',
          start,
          `Normalized non-standard boolean literal '${token}'`,
        )
      }
      return { type: 'boolean', value: lower === 'true' }
    }
    if (lower === 'null' || lower === 'none' || lower === 'nil') {
      if (token !== 'null') {
        this.repair(
          'normalized_nonstandard_literal',
          start,
          `Normalized non-standard null literal '${token}'`,
        )
      }
      return { type: 'null', value: null }
    }

    const maybeNumber = token.match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/,
    )
    if (maybeNumber) {
      return {
        type: 'number',
        value: Number(token),
        raw: token,
      }
    }

    this.repair(
      'treated_bareword_as_string',
      start,
      `Treated bare token '${token}' as a string`,
    )
    return { type: 'string', value: token }
  }

  private insertMissingValue(): Extract<JsonAstNode, { type: 'null' }> {
    this.repair(
      'inserted_missing_value',
      this.index,
      'Inserted null for missing value',
    )
    return { type: 'null', value: null }
  }

  private shouldAutoCloseStringAt(
    position: number,
    quote: '"' | "'",
  ): boolean {
    const current = this.source[position]
    if (current === '}' || current === ']') {
      return !hasClosingQuoteAhead(this.source, position, quote)
    }

    if (current === ',') {
      return looksLikeObjectBody(this.source, position + 1)
    }

    return false
  }

  private skipTrivia(): void {
    while (!this.eof()) {
      const ch = this.peek()
      if (isWhitespace(ch)) {
        this.index++
        continue
      }
      if (ch === '/' && this.peek(1) === '/') {
        this.index += 2
        while (!this.eof() && this.peek() !== '\n') {
          this.index++
        }
        continue
      }
      if (ch === '/' && this.peek(1) === '*') {
        this.index += 2
        while (!this.eof()) {
          if (this.peek() === '*' && this.peek(1) === '/') {
            this.index += 2
            break
          }
          this.index++
        }
        continue
      }
      break
    }
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) {
      throw new Error(`Expected '${ch}'`)
    }
    this.index++
  }

  private peek(offset = 0): string | undefined {
    return this.source[this.index + offset]
  }

  private eof(): boolean {
    return this.index >= this.source.length
  }

  private repair(
    kind: JsonRepairKind,
    position: number,
    message: string,
  ): void {
    this.repairs.push({ kind, position, message })
    if (this.repairs.length > this.maxRepairs) {
      throw new RepairBudgetExceededError()
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (used by tolerant parser, tool name extraction, and schema repair)
// ---------------------------------------------------------------------------

export function skipTriviaAt(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    if (isWhitespace(source[index])) {
      index++
      continue
    }
    if (source[index] === '/' && source[index + 1] === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index++
      continue
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      index += 2
      while (index + 1 < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          index += 2
          break
        }
        index++
      }
      continue
    }
    break
  }
  return index
}

function findQuotedStringEnd(
  source: string,
  start: number,
  quote: '"' | "'",
): number {
  let index = start + 1
  while (index < source.length) {
    const ch = source[index]
    if (ch === '\\') {
      index += 2
      continue
    }
    if (ch === quote) return index
    if (ch === '\n' || ch === '\r') return -1
    index++
  }
  return -1
}

function hasClosingQuoteAhead(
  source: string,
  start: number,
  quote: '"' | "'",
): boolean {
  for (let index = start; index < source.length; index++) {
    const ch = source[index]
    if (ch === '\\') {
      index++
      continue
    }
    if (ch === quote) return true
    if (ch === '\n' || ch === '\r') return false
  }
  return false
}

export function looksLikeObjectBody(source: string, start: number): boolean {
  let index = skipTriviaAt(source, start)
  const ch = source[index]
  if (ch === '"' || ch === "'") {
    const end = findQuotedStringEnd(source, index, ch)
    if (end === -1) return false
    index = skipTriviaAt(source, end + 1)
    return source[index] === ':' || source[index] === '='
  }

  if (!isIdentifierStart(ch)) return false
  index++
  while (index < source.length && isIdentifierPart(source[index])) index++
  index = skipTriviaAt(source, index)
  return source[index] === ':' || source[index] === '='
}

function isValueStartAt(source: string, start: number): boolean {
  const index = skipTriviaAt(source, start)
  return isValueStart(source[index])
}

function hasStrongArraySignal(source: string): boolean {
  const index = skipTriviaAt(source, 0)
  const ch = source[index]
  if (ch === '"' || ch === "'" || ch === '{' || ch === '[' || isNumberStart(ch)) {
    return true
  }

  const lower = source.slice(index).toLowerCase()
  if (
    lower.startsWith('true') ||
    lower.startsWith('false') ||
    lower.startsWith('null') ||
    lower.startsWith('none') ||
    lower.startsWith('nil')
  ) {
    return true
  }

  let depth = 0
  let quote: '"' | "'" | null = null
  for (let i = index; i < source.length; i++) {
    const current = source[i]
    if (quote) {
      if (current === '\\') {
        i++
        continue
      }
      if (current === quote) {
        quote = null
      }
      continue
    }
    if (current === '"' || current === "'") {
      quote = current
      continue
    }
    if (current === '{' || current === '[') {
      depth++
      continue
    }
    if (current === '}' || current === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && (current === ',' || current === ';')) {
      return true
    }
  }

  return false
}
