import type { ZodTypeAny } from 'zod/v4'
import { zodToJsonSchema } from './zodToJsonSchema.js'

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

export type SchemaGuidedToolDefinition = {
  name: string
  aliases?: readonly string[]
  inputSchema: ZodTypeAny
  inputJSONSchema?: Record<string, unknown>
}

export type SchemaGuidedToolInputRepairKind =
  | 'parsed_invalid_json'
  | 'extracted_tool_input'
  | 'parsed_arguments_string'
  | 'used_root_as_input'
  | 'renamed_key'
  | 'dropped_unknown_key'
  | 'wrapped_scalar_input'
  | 'coerced_string_to_number'
  | 'coerced_string_to_boolean'
  | 'coerced_primitive_to_string'
  | 'matched_enum_case'
  | 'wrapped_scalar_as_array'

export type SchemaGuidedToolInputRepair = {
  kind: SchemaGuidedToolInputRepairKind
  path: string
  message: string
}

export type SchemaGuidedToolCallRepairOptions = {
  maxScanLength?: number
  jsonRepairOptions?: JsonRepairOptions
}

export type SchemaGuidedToolCallRepairSuccess = {
  ok: true
  raw: string
  toolName: string
  extractedToolName: string
  input: Record<string, unknown>
  needsRepair: boolean
  repairs: SchemaGuidedToolInputRepair[]
  jsonRepairs: JsonRepair[]
  toolNameExtraction: JsonLikeToolNameExtractionSuccess
}

export type SchemaGuidedToolCallRepairFailure = {
  ok: false
  raw: string
  toolName?: string
  extractedToolName?: string
  needsRepair: true
  repairs: SchemaGuidedToolInputRepair[]
  jsonRepairs: JsonRepair[]
  toolNameExtraction?: JsonLikeToolNameExtractionResult
  error:
    | 'missing_tool_name'
    | 'unknown_tool_name'
    | 'unrepairable_json'
    | 'missing_tool_input'
    | 'schema_mismatch'
  message: string
}

export type SchemaGuidedToolCallRepairResult =
  | SchemaGuidedToolCallRepairSuccess
  | SchemaGuidedToolCallRepairFailure

type RootMode = 'normal' | 'synthetic_object' | 'synthetic_array'

type Candidate = {
  ok: true
  ast: JsonAstNode
  repairs: JsonRepair[]
  parser: TolerantJsonParser
  score: number
}

const DEFAULT_MAX_DEPTH = 64
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

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function isWhitespace(ch: string | undefined): boolean {
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

function skipTriviaAt(source: string, start: number): number {
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

function looksLikeObjectBody(source: string, start: number): boolean {
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
    ch === '“' ||
    ch === '”' ||
    ch === '‘' ||
    ch === '’'
  )
}

function closingQuoteFor(openingQuote: string): string {
  switch (openingQuote) {
    case '“':
      return '”'
    case '‘':
      return '’'
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

function normalizeToolNameKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function isLikelyToolNameKey(key: string): boolean {
  const normalized = normalizeToolNameKey(key)
  return (
    normalized === 'name' ||
    normalized === 'tool' ||
    normalized === 'toolname' ||
    normalized === 'functionname' ||
    normalized === 'recipientname'
  )
}

function normalizeToolNameForFuzzyMatch(name: string): string {
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

type ToolInputCandidate = {
  value: unknown
  score: number
  repairs: SchemaGuidedToolInputRepair[]
  jsonRepairs: JsonRepair[]
}

type JsonObjectSchemaShape = {
  properties: Record<string, Record<string, unknown>>
  required: Set<string>
  additionalProperties: unknown
}

type ValueRepairAttempt = {
  value: unknown
  cost: number
  repairs: SchemaGuidedToolInputRepair[]
}

const TOOL_INPUT_FIELD_NAMES = [
  'input',
  'arguments',
  'args',
  'parameters',
  'params',
] as const

const TOOL_CALL_METADATA_KEYS = new Set([
  'id',
  'type',
  'name',
  'tool',
  'tool_name',
  'toolName',
  'function',
  'recipient_name',
  'recipientName',
])

const PROPERTY_ALIASES: Record<string, readonly string[]> = {
  command: ['cmd', 'shell', 'script'],
  file_path: ['file', 'filePath', 'filepath', 'filename', 'fileName', 'path'],
  new_string: [
    'new',
    'newString',
    'newText',
    'replacement',
    'replaceWith',
  ],
  old_string: ['old', 'oldString', 'oldText', 'search', 'target'],
  pattern: ['regex', 'regexp'],
  query: ['q', 'search'],
  replace_all: ['all', 'replaceAll'],
  url: ['link', 'uri'],
}

function knownToolNamesForSchemaRepair(
  tools: readonly SchemaGuidedToolDefinition[],
): string[] {
  return tools.flatMap(tool => [tool.name, ...(tool.aliases ?? [])])
}

function findSchemaGuidedToolByName(
  tools: readonly SchemaGuidedToolDefinition[],
  name: string,
): SchemaGuidedToolDefinition | undefined {
  return tools.find(tool => tool.name === name || tool.aliases?.includes(name))
}

function toolNameMatchesCandidate(
  value: unknown,
  tool: SchemaGuidedToolDefinition,
): boolean {
  return (
    typeof value === 'string' &&
    (value === tool.name || tool.aliases?.includes(value) === true)
  )
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function stableJsonText(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function valuesDeepEqual(a: unknown, b: unknown): boolean {
  return stableJsonText(a) === stableJsonText(b)
}

function getToolInputJsonSchema(
  tool: SchemaGuidedToolDefinition,
): Record<string, unknown> {
  return tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema)
}

function getJsonSchemaObjectShape(
  schema: Record<string, unknown>,
): JsonObjectSchemaShape {
  const properties =
    isRecordValue(schema.properties)
      ? Object.fromEntries(
          Object.entries(schema.properties).filter(
            (entry): entry is [string, Record<string, unknown>] =>
              isRecordValue(entry[1]),
          ),
        )
      : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  )
  return {
    properties,
    required,
    additionalProperties: schema.additionalProperties,
  }
}

function schemaHasObjectShape(schema: Record<string, unknown>): boolean {
  return schema.type === 'object' || isRecordValue(schema.properties)
}

function inputLooksLikeSchema(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  if (!isRecordValue(value)) return false
  const shape = getJsonSchemaObjectShape(schema)
  return Object.keys(value).some(key =>
    bestSchemaPropertyMatch(key, Object.keys(shape.properties)) !== null,
  )
}

function extractToolInputCandidates(
  root: JsonValue,
  tool: SchemaGuidedToolDefinition,
  schema: Record<string, unknown>,
): ToolInputCandidate[] {
  const candidates: ToolInputCandidate[] = []
  const seen = new Set<string>()

  const addCandidate = (candidate: ToolInputCandidate) => {
    const key = stableJsonText(candidate.value)
    if (key && seen.has(key)) return
    if (key) seen.add(key)
    candidates.push(candidate)
  }

  const addInputFieldCandidate = (
    fieldName: string,
    fieldValue: unknown,
    score: number,
    path: string,
  ) => {
    if (typeof fieldValue === 'string') {
      const repaired = repairJsonText(fieldValue)
      if (repaired.ok) {
        addCandidate({
          value: repaired.value,
          score: score + 12,
          repairs: [
            {
              kind: 'parsed_arguments_string',
              path,
              message: `Parsed string ${fieldName} payload as JSON`,
            },
          ],
          jsonRepairs: repaired.repairs,
        })
      }

      addCandidate({
        value: fieldValue,
        score: score - 6,
        repairs: [
          {
            kind: 'extracted_tool_input',
            path,
            message: `Used string ${fieldName} payload as raw tool input`,
          },
        ],
        jsonRepairs: [],
      })
      return
    }

    addCandidate({
      value: fieldValue,
      score,
      repairs: [
        {
          kind: 'extracted_tool_input',
          path,
          message: `Extracted tool input from ${fieldName}`,
        },
      ],
      jsonRepairs: [],
    })
  }

  const addObjectBodyCandidate = (
    value: Record<string, unknown>,
    score: number,
    path: string,
  ) => {
    const stripped = Object.fromEntries(
      Object.entries(value).filter(
        ([key]) => !TOOL_CALL_METADATA_KEYS.has(key),
      ),
    )
    if (!inputLooksLikeSchema(stripped, schema)) return
    addCandidate({
      value: stripped,
      score,
      repairs: [
        {
          kind: 'used_root_as_input',
          path,
          message: 'Used the tool-call object body as tool input',
        },
      ],
      jsonRepairs: [],
    })
  }

  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > DEFAULT_MAX_DEPTH) return
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1))
      return
    }
    if (!isRecordValue(value)) return

    const entries = Object.entries(value)
    const nameEntry = entries.find(([key]) => isLikelyToolNameKey(key))
    const hasMatchingName =
      nameEntry !== undefined && toolNameMatchesCandidate(nameEntry[1], tool)

    if (hasMatchingName) {
      for (const fieldName of TOOL_INPUT_FIELD_NAMES) {
        if (Object.hasOwn(value, fieldName)) {
          addInputFieldCandidate(
            fieldName,
            value[fieldName],
            120,
            `${path}.${fieldName}`,
          )
        }
      }
      addObjectBodyCandidate(value, 70, path)
    }

    for (const [key, child] of entries) {
      walk(child, `${path}.${key}`, depth + 1)
    }
  }

  walk(root, '$', 0)

  if (schemaHasObjectShape(schema) && inputLooksLikeSchema(root, schema)) {
    addCandidate({
      value: root,
      score: 20,
      repairs: [
        {
          kind: 'used_root_as_input',
          path: '$',
          message: 'Used the root JSON value as tool input',
        },
      ],
      jsonRepairs: [],
    })
  }

  return candidates.sort((a, b) => b.score - a.score)
}

function schemaTypes(schema: Record<string, unknown>): string[] {
  if (typeof schema.type === 'string') return [schema.type]
  if (Array.isArray(schema.type)) {
    return schema.type.filter((item): item is string => typeof item === 'string')
  }
  if (schemaHasObjectShape(schema)) return ['object']
  if (isRecordValue(schema.items)) return ['array']
  return []
}

function getSchemaAlternatives(
  schema: Record<string, unknown>,
): Record<string, unknown>[] {
  for (const key of ['oneOf', 'anyOf']) {
    const alternatives = schema[key]
    if (Array.isArray(alternatives)) {
      return alternatives.filter(isRecordValue)
    }
  }
  return []
}

function repairValueAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): ValueRepairAttempt {
  const alternatives = getSchemaAlternatives(schema)
  if (alternatives.length > 0) {
    const attempts = alternatives.map(alternative =>
      repairValueAgainstSchema(value, alternative, path),
    )
    return chooseLowestCostAttempt(attempts)
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : []
  if (enumValues.length > 0) {
    const enumAttempt = repairEnumValue(value, enumValues, path)
    if (enumAttempt) return enumAttempt
  }

  const types = schemaTypes(schema)
  if (types.includes('object')) {
    return repairObjectAgainstSchema(value, schema, path)
  }
  if (types.includes('array')) {
    return repairArrayAgainstSchema(value, schema, path)
  }
  if (types.includes('integer') || types.includes('number')) {
    return repairNumberAgainstSchema(value, types.includes('integer'), path)
  }
  if (types.includes('boolean')) {
    return repairBooleanAgainstSchema(value, path)
  }
  if (types.includes('string')) {
    return repairStringAgainstSchema(value, path)
  }

  return { value, cost: 0, repairs: [] }
}

function chooseLowestCostAttempt(
  attempts: ValueRepairAttempt[],
): ValueRepairAttempt {
  return attempts.reduce((best, current) =>
    current.cost < best.cost ? current : best,
  )
}

function repairEnumValue(
  value: unknown,
  enumValues: unknown[],
  path: string,
): ValueRepairAttempt | null {
  if (enumValues.some(enumValue => Object.is(enumValue, value))) {
    return { value, cost: 0, repairs: [] }
  }
  if (typeof value !== 'string') return null

  const match = enumValues.find(
    enumValue =>
      typeof enumValue === 'string' &&
      enumValue.toLowerCase() === value.toLowerCase(),
  )
  if (typeof match !== 'string') return null

  return {
    value: match,
    cost: 4,
    repairs: [
      {
        kind: 'matched_enum_case',
        path,
        message: `Matched enum value '${value}' to '${match}'`,
      },
    ],
  }
}

function repairStringAgainstSchema(
  value: unknown,
  path: string,
): ValueRepairAttempt {
  if (typeof value === 'string') {
    return { value, cost: 0, repairs: [] }
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return {
      value: String(value),
      cost: 8,
      repairs: [
        {
          kind: 'coerced_primitive_to_string',
          path,
          message: 'Converted primitive value to string',
        },
      ],
    }
  }
  return { value, cost: 1000, repairs: [] }
}

function repairNumberAgainstSchema(
  value: unknown,
  integer: boolean,
  path: string,
): ValueRepairAttempt {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { value, cost: 0, repairs: [] }
  }
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && (!integer || Number.isInteger(parsed))) {
      return {
        value: parsed,
        cost: 4,
        repairs: [
          {
            kind: 'coerced_string_to_number',
            path,
            message: `Converted string '${value}' to number`,
          },
        ],
      }
    }
  }
  return { value, cost: 1000, repairs: [] }
}

function repairBooleanAgainstSchema(
  value: unknown,
  path: string,
): ValueRepairAttempt {
  if (typeof value === 'boolean') {
    return { value, cost: 0, repairs: [] }
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'false') {
      return {
        value: normalized === 'true',
        cost: 4,
        repairs: [
          {
            kind: 'coerced_string_to_boolean',
            path,
            message: `Converted string '${value}' to boolean`,
          },
        ],
      }
    }
  }
  return { value, cost: 1000, repairs: [] }
}

function repairArrayAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): ValueRepairAttempt {
  const itemSchema = isRecordValue(schema.items) ? schema.items : null
  if (Array.isArray(value)) {
    if (!itemSchema) return { value, cost: 0, repairs: [] }
    const items = value.map((item, index) =>
      repairValueAgainstSchema(item, itemSchema, `${path}[${index}]`),
    )
    return {
      value: items.map(item => item.value),
      cost: items.reduce((sum, item) => sum + item.cost, 0),
      repairs: items.flatMap(item => item.repairs),
    }
  }

  if (!itemSchema) {
    return {
      value: [value],
      cost: 12,
      repairs: [
        {
          kind: 'wrapped_scalar_as_array',
          path,
          message: 'Wrapped scalar value in an array',
        },
      ],
    }
  }

  const item = repairValueAgainstSchema(value, itemSchema, `${path}[0]`)
  return {
    value: [item.value],
    cost: item.cost + 12,
    repairs: [
      {
        kind: 'wrapped_scalar_as_array',
        path,
        message: 'Wrapped scalar value in an array',
      },
      ...item.repairs,
    ],
  }
}

function repairObjectAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): ValueRepairAttempt {
  const shape = getJsonSchemaObjectShape(schema)
  const propertyNames = Object.keys(shape.properties)

  if (!isRecordValue(value)) {
    const wrapKey = chooseScalarWrapProperty(shape)
    if (!wrapKey) {
      return { value, cost: 1000, repairs: [] }
    }
    const propertyAttempt = repairValueAgainstSchema(
      value,
      shape.properties[wrapKey] ?? {},
      `${path}.${wrapKey}`,
    )
    return {
      value: { [wrapKey]: propertyAttempt.value },
      cost: propertyAttempt.cost + 24,
      repairs: [
        {
          kind: 'wrapped_scalar_input',
          path,
          message: `Wrapped scalar input as '${wrapKey}'`,
        },
        ...propertyAttempt.repairs,
      ],
    }
  }

  const keyAssignments = assignObjectKeysToSchemaProperties(
    value,
    propertyNames,
    shape,
  )
  const repairedObject: Record<string, unknown> = {}
  const repairs: SchemaGuidedToolInputRepair[] = []
  let cost = 0

  for (const [propertyName, assignment] of keyAssignments.assigned) {
    const propertySchema = shape.properties[propertyName] ?? {}
    const propertyPath = `${path}.${propertyName}`
    const propertyAttempt = repairValueAgainstSchema(
      assignment.value,
      propertySchema,
      propertyPath,
    )
    repairedObject[propertyName] = propertyAttempt.value
    cost += propertyAttempt.cost
    repairs.push(...propertyAttempt.repairs)

    if (assignment.inputKey !== propertyName) {
      cost += assignment.cost
      repairs.push({
        kind: 'renamed_key',
        path: `${path}.${assignment.inputKey}`,
        message: `Mapped '${assignment.inputKey}' to schema key '${propertyName}'`,
      })
    }
  }

  for (const [unknownKey, unknownValue] of keyAssignments.unknown) {
    if (shape.additionalProperties === false) {
      cost += 6
      repairs.push({
        kind: 'dropped_unknown_key',
        path: `${path}.${unknownKey}`,
        message: `Dropped unknown key '${unknownKey}' for strict schema`,
      })
    } else {
      repairedObject[unknownKey] = unknownValue
    }
  }

  return {
    value: repairedObject,
    cost,
    repairs,
  }
}

function chooseScalarWrapProperty(
  shape: JsonObjectSchemaShape,
): string | null {
  if (shape.required.size === 1) {
    return Array.from(shape.required)[0] ?? null
  }
  const propertyNames = Object.keys(shape.properties)
  if (propertyNames.length === 1) {
    return propertyNames[0] ?? null
  }
  return null
}

type SchemaKeyAssignment = {
  inputKey: string
  value: unknown
  cost: number
}

function assignObjectKeysToSchemaProperties(
  value: Record<string, unknown>,
  propertyNames: string[],
  shape: JsonObjectSchemaShape,
): {
  assigned: Map<string, SchemaKeyAssignment>
  unknown: Map<string, unknown>
} {
  const assigned = new Map<string, SchemaKeyAssignment>()
  const unknown = new Map(Object.entries(value))

  const assign = (
    inputKey: string,
    propertyName: string,
    score: number,
  ): boolean => {
    const existing = assigned.get(propertyName)
    const cost = Math.max(1, Math.round((1 - score) * 20))
    if (existing && existing.cost <= cost) return false
    if (existing) unknown.set(existing.inputKey, existing.value)
    assigned.set(propertyName, {
      inputKey,
      value: value[inputKey],
      cost,
    })
    unknown.delete(inputKey)
    return true
  }

  for (const inputKey of Object.keys(value)) {
    if (propertyNames.includes(inputKey)) {
      assign(inputKey, inputKey, 1)
      continue
    }

    const match = bestSchemaPropertyMatch(inputKey, propertyNames)
    if (match && match.score >= 0.72) {
      assign(inputKey, match.propertyName, match.score)
    }
  }

  const missingRequired = () =>
    Array.from(shape.required).filter(key => !assigned.has(key))

  for (const requiredKey of missingRequired()) {
    let bestUnknown:
      | {
          inputKey: string
          value: unknown
          score: number
        }
      | null = null
    for (const [inputKey, unknownValue] of unknown) {
      const score = propertyNameSimilarity(inputKey, requiredKey)
      if (
        score >= 0.45 &&
        canValuePossiblyMatchSchema(
          unknownValue,
          shape.properties[requiredKey] ?? {},
        ) &&
        (!bestUnknown || score > bestUnknown.score)
      ) {
        bestUnknown = {
          inputKey,
          value: unknownValue,
          score,
        }
      }
    }
    if (bestUnknown) {
      assign(bestUnknown.inputKey, requiredKey, bestUnknown.score)
    }
  }

  return { assigned, unknown }
}

function bestSchemaPropertyMatch(
  inputKey: string,
  propertyNames: readonly string[],
): { propertyName: string; score: number } | null {
  let best: { propertyName: string; score: number } | null = null
  for (const propertyName of propertyNames) {
    const score = propertyNameSimilarity(inputKey, propertyName)
    if (!best || score > best.score) {
      best = { propertyName, score }
    }
  }
  return best
}

function propertyNameSimilarity(inputKey: string, propertyName: string): number {
  const normalizedInput = normalizeToolNameForFuzzyMatch(inputKey)
  const normalizedProperty = normalizeToolNameForFuzzyMatch(propertyName)
  if (normalizedInput === normalizedProperty) return 1

  const aliases = PROPERTY_ALIASES[propertyName] ?? []
  if (
    aliases.some(
      alias => normalizeToolNameForFuzzyMatch(alias) === normalizedInput,
    )
  ) {
    return 0.95
  }

  const inputTokens = splitPropertyNameIntoTokens(inputKey)
  const propertyTokens = splitPropertyNameIntoTokens(propertyName)
  if (
    inputTokens.length > 0 &&
    inputTokens.every(token => propertyTokens.includes(token))
  ) {
    return propertyTokens.at(-1) === inputTokens.at(-1) ? 0.82 : 0.74
  }
  if (
    propertyTokens.length > 0 &&
    propertyTokens.every(token => inputTokens.includes(token))
  ) {
    return 0.78
  }

  const distance = levenshteinDistance(normalizedInput, normalizedProperty)
  const maxLength = Math.max(normalizedInput.length, normalizedProperty.length)
  if (maxLength === 0) return 0
  return 1 - distance / maxLength
}

function splitPropertyNameIntoTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(token => token.toLowerCase())
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    for (let j = 1; j <= b.length; j++) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1]!
          : Math.min(previous[j - 1]!, previous[j]!, current[j - 1]!) + 1
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j]!
    }
  }

  return previous[b.length] ?? 0
}

function canValuePossiblyMatchSchema(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  const types = schemaTypes(schema)
  if (types.length === 0) return true
  if (types.includes('string')) {
    return (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    )
  }
  if (types.includes('number') || types.includes('integer')) {
    return (
      typeof value === 'number' ||
      (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()))
    )
  }
  if (types.includes('boolean')) {
    return (
      typeof value === 'boolean' ||
      (typeof value === 'string' &&
        ['true', 'false'].includes(value.trim().toLowerCase()))
    )
  }
  if (types.includes('array')) return Array.isArray(value)
  if (types.includes('object')) return isRecordValue(value)
  return true
}

function parsedInputAsRecord(value: unknown): Record<string, unknown> | null {
  return isRecordValue(value) ? value : null
}

export function repairToolCallJsonAgainstSchemas(
  raw: string,
  tools: readonly SchemaGuidedToolDefinition[],
  options: SchemaGuidedToolCallRepairOptions = {},
): SchemaGuidedToolCallRepairResult {
  const knownToolNames = knownToolNamesForSchemaRepair(tools)
  const toolNameExtraction = extractToolNameFromJsonLikeText(raw, {
    knownToolNames,
    maxScanLength: options.maxScanLength,
  })

  if (toolNameExtraction.ok === false) {
    return {
      ok: false,
      raw,
      needsRepair: true,
      repairs: [],
      jsonRepairs: [],
      toolNameExtraction,
      error:
        toolNameExtraction.candidates.length > 0
          ? 'unknown_tool_name'
          : 'missing_tool_name',
      message: toolNameExtraction.error,
    }
  }

  const tool = findSchemaGuidedToolByName(tools, toolNameExtraction.name)
  if (!tool) {
    return {
      ok: false,
      raw,
      toolName: toolNameExtraction.name,
      extractedToolName: toolNameExtraction.candidate.extractedName,
      needsRepair: true,
      repairs: [],
      jsonRepairs: [],
      toolNameExtraction,
      error: 'unknown_tool_name',
      message: `No known tool matched '${toolNameExtraction.name}'`,
    }
  }

  const parsedToolCall = repairJsonText(raw, options.jsonRepairOptions)
  if (parsedToolCall.ok === false) {
    return {
      ok: false,
      raw,
      toolName: tool.name,
      extractedToolName: toolNameExtraction.candidate.extractedName,
      needsRepair: true,
      repairs: [],
      jsonRepairs: parsedToolCall.repairs,
      toolNameExtraction,
      error: 'unrepairable_json',
      message: parsedToolCall.error,
    }
  }

  const schema = getToolInputJsonSchema(tool)
  const candidates = extractToolInputCandidates(
    parsedToolCall.value,
    tool,
    schema,
  )

  if (candidates.length === 0) {
    return {
      ok: false,
      raw,
      toolName: tool.name,
      extractedToolName: toolNameExtraction.candidate.extractedName,
      needsRepair: true,
      repairs:
        parsedToolCall.repairs.length > 0
          ? [
              {
                kind: 'parsed_invalid_json',
                path: '$',
                message: 'Repaired malformed tool-call JSON',
              },
            ]
          : [],
      jsonRepairs: parsedToolCall.repairs,
      toolNameExtraction,
      error: 'missing_tool_input',
      message: 'Unable to locate tool input or arguments for selected tool',
    }
  }

  const jsonRepairMarkers: SchemaGuidedToolInputRepair[] =
    parsedToolCall.repairs.length > 0
      ? [
          {
            kind: 'parsed_invalid_json',
            path: '$',
            message: 'Repaired malformed tool-call JSON',
          },
        ]
      : []

  for (const candidate of candidates) {
    const directParse = tool.inputSchema.safeParse(candidate.value)
    if (directParse.success) {
      const input = parsedInputAsRecord(directParse.data)
      if (!input) continue
      return {
        ok: true,
        raw,
        toolName: tool.name,
        extractedToolName: toolNameExtraction.candidate.extractedName,
        input,
        needsRepair:
          jsonRepairMarkers.length > 0 ||
          candidate.jsonRepairs.length > 0 ||
          !valuesDeepEqual(candidate.value, directParse.data),
        repairs: [...jsonRepairMarkers, ...candidate.repairs],
        jsonRepairs: [...parsedToolCall.repairs, ...candidate.jsonRepairs],
        toolNameExtraction,
      }
    }

    const repaired = repairValueAgainstSchema(candidate.value, schema, '$')
    const repairedParse = tool.inputSchema.safeParse(repaired.value)
    if (!repairedParse.success) continue
    const input = parsedInputAsRecord(repairedParse.data)
    if (!input) continue

    return {
      ok: true,
      raw,
      toolName: tool.name,
      extractedToolName: toolNameExtraction.candidate.extractedName,
      input,
      needsRepair: true,
      repairs: [
        ...jsonRepairMarkers,
        ...candidate.repairs,
        ...repaired.repairs,
      ],
      jsonRepairs: [...parsedToolCall.repairs, ...candidate.jsonRepairs],
      toolNameExtraction,
    }
  }

  return {
    ok: false,
    raw,
    toolName: tool.name,
    extractedToolName: toolNameExtraction.candidate.extractedName,
    needsRepair: true,
    repairs: [...jsonRepairMarkers, ...candidates[0]!.repairs],
    jsonRepairs: [
      ...parsedToolCall.repairs,
      ...candidates.flatMap(candidate => candidate.jsonRepairs),
    ],
    toolNameExtraction,
    error: 'schema_mismatch',
    message: `Unable to repair '${tool.name}' input so it satisfies the selected tool schema`,
  }
}
