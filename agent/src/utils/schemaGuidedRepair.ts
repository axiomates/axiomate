import type { ZodTypeAny } from 'zod/v4'

import {
  DEFAULT_MAX_DEPTH,
  repairJsonText,
  type JsonRepair,
  type JsonRepairOptions,
  type JsonValue,
} from './tolerantJsonParser.js'
import {
  extractToolNameFromJsonLikeText,
  isLikelyToolNameKey,
  normalizeToolNameForFuzzyMatch,
  type JsonLikeToolNameExtractionResult,
  type JsonLikeToolNameExtractionSuccess,
} from './toolNameExtraction.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchemaGuidedToolDefinition = {
  name: string
  aliases?: readonly string[]
  inputSchema: ZodTypeAny
  inputJSONSchema?: Record<string, unknown>
  propertyAliases?: Record<string, readonly string[]>
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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool lookup helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// JSON Schema introspection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool input candidate extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schema-guided value repair
// ---------------------------------------------------------------------------

function repairValueAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  propertyAliases?: Record<string, readonly string[]>,
): ValueRepairAttempt {
  const alternatives = getSchemaAlternatives(schema)
  if (alternatives.length > 0) {
    const attempts = alternatives.map(alternative =>
      repairValueAgainstSchema(value, alternative, path, propertyAliases),
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
    return repairObjectAgainstSchema(value, schema, path, propertyAliases)
  }
  if (types.includes('array')) {
    return repairArrayAgainstSchema(value, schema, path, propertyAliases)
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
  propertyAliases?: Record<string, readonly string[]>,
): ValueRepairAttempt {
  const itemSchema = isRecordValue(schema.items) ? schema.items : null
  if (Array.isArray(value)) {
    if (!itemSchema) return { value, cost: 0, repairs: [] }
    const items = value.map((item, index) =>
      repairValueAgainstSchema(item, itemSchema, `${path}[${index}]`, propertyAliases),
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

  const item = repairValueAgainstSchema(value, itemSchema, `${path}[0]`, propertyAliases)
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

// ---------------------------------------------------------------------------
// Object key → schema property matching
// ---------------------------------------------------------------------------

function repairObjectAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  propertyAliases?: Record<string, readonly string[]>,
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
      propertyAliases,
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
    propertyAliases,
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
      propertyAliases,
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
  propertyAliases?: Record<string, readonly string[]>,
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

    const match = bestSchemaPropertyMatch(inputKey, propertyNames, propertyAliases)
    // 0.72: matches camelCase↔snake_case variants and close Levenshtein neighbors
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
      const score = propertyNameSimilarity(inputKey, requiredKey, propertyAliases?.[requiredKey])
      // 0.45: relaxed threshold for required fields — allows more aggressive matching
      // to avoid failing on fields the model clearly intended to provide
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
  propertyAliases?: Record<string, readonly string[]>,
): { propertyName: string; score: number } | null {
  let best: { propertyName: string; score: number } | null = null
  for (const propertyName of propertyNames) {
    const score = propertyNameSimilarity(inputKey, propertyName, propertyAliases?.[propertyName])
    if (!best || score > best.score) {
      best = { propertyName, score }
    }
  }
  return best
}

function propertyNameSimilarity(
  inputKey: string,
  propertyName: string,
  aliases?: readonly string[],
): number {
  const normalizedInput = normalizeToolNameForFuzzyMatch(inputKey)
  const normalizedProperty = normalizeToolNameForFuzzyMatch(propertyName)
  if (normalizedInput === normalizedProperty) return 1

  // Check tool-declared property aliases (e.g., "cmd" → "command")
  if (aliases) {
    if (
      aliases.some(
        alias => normalizeToolNameForFuzzyMatch(alias) === normalizedInput,
      )
    ) {
      return 0.95
    }
  }

  // Token-overlap matching (handles camelCase ↔ snake_case variants)
  const inputTokens = splitPropertyNameIntoTokens(inputKey)
  const propertyTokens = splitPropertyNameIntoTokens(propertyName)
  if (
    inputTokens.length > 0 &&
    inputTokens.every(token => propertyTokens.includes(token))
  ) {
    // 0.82: all input tokens present in property, and last tokens match (strong signal)
    // 0.74: all input tokens present but last tokens differ (weaker)
    return propertyTokens.at(-1) === inputTokens.at(-1) ? 0.82 : 0.74
  }
  if (
    propertyTokens.length > 0 &&
    propertyTokens.every(token => inputTokens.includes(token))
  ) {
    // 0.78: all property tokens present in input (input is more specific)
    return 0.78
  }

  // Levenshtein fallback
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

// ---------------------------------------------------------------------------
// Public API: full tool-call repair (JSON text → tool name → schema fit)
// ---------------------------------------------------------------------------

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

  return repairToolInputCore(raw, tool, options.jsonRepairOptions, toolNameExtraction)
}

// ---------------------------------------------------------------------------
// Public API: direct tool input repair (tool already known)
// ---------------------------------------------------------------------------

export function repairToolInputAgainstSchema(
  input: unknown,
  unparsedInput: string | undefined,
  tool: SchemaGuidedToolDefinition,
): SchemaGuidedToolCallRepairResult {
  // If we have unparsed raw text, try to repair-parse it first
  if (unparsedInput && unparsedInput.trim().length > 0) {
    const repaired = repairJsonText(unparsedInput)
    if (repaired.ok) {
      return repairToolInputFromParsedValue(
        unparsedInput,
        repaired.value,
        tool,
        repaired.repairs.length > 0
          ? [{ kind: 'parsed_invalid_json', path: '$', message: 'Repaired malformed tool-call JSON' }]
          : [],
        repaired.repairs,
      )
    }
  }

  // Fall back to repairing the already-parsed input directly
  return repairToolInputFromParsedValue(
    JSON.stringify(input),
    input as JsonValue,
    tool,
    [],
    [],
  )
}

// ---------------------------------------------------------------------------
// Shared core: repair parsed value against a known tool's schema
// ---------------------------------------------------------------------------

function repairToolInputCore(
  raw: string,
  tool: SchemaGuidedToolDefinition,
  jsonRepairOptions: JsonRepairOptions | undefined,
  toolNameExtraction: JsonLikeToolNameExtractionSuccess,
): SchemaGuidedToolCallRepairResult {
  const parsedToolCall = repairJsonText(raw, jsonRepairOptions)
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

    const repaired = repairValueAgainstSchema(candidate.value, schema, '$', tool.propertyAliases)
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

function repairToolInputFromParsedValue(
  raw: string,
  parsedValue: JsonValue,
  tool: SchemaGuidedToolDefinition,
  preRepairs: SchemaGuidedToolInputRepair[],
  preJsonRepairs: JsonRepair[],
): SchemaGuidedToolCallRepairResult {
  const schema = getToolInputJsonSchema(tool)

  // Try direct parse first
  const directParse = tool.inputSchema.safeParse(parsedValue)
  if (directParse.success) {
    const input = parsedInputAsRecord(directParse.data)
    if (input) {
      return {
        ok: true,
        raw,
        toolName: tool.name,
        extractedToolName: tool.name,
        input,
        needsRepair: preRepairs.length > 0 || preJsonRepairs.length > 0,
        repairs: [
          ...preRepairs,
          { kind: 'extracted_tool_input', path: '$', message: 'Used parsed input directly' },
        ],
        jsonRepairs: preJsonRepairs,
        toolNameExtraction: {
          ok: true,
          raw,
          name: tool.name,
          candidate: {
            name: tool.name,
            extractedName: tool.name,
            key: 'name',
            position: 0,
            score: 200,
            confidence: 'high',
            matchedKnownTool: true,
            delimiter: ':',
          },
          candidates: [],
        },
      }
    }
  }

  // Try schema-guided repair
  if (isRecordValue(parsedValue)) {
    const repaired = repairValueAgainstSchema(parsedValue, schema, '$', tool.propertyAliases)
    const repairedParse = tool.inputSchema.safeParse(repaired.value)
    if (repairedParse.success) {
      const input = parsedInputAsRecord(repairedParse.data)
      if (input) {
        return {
          ok: true,
          raw,
          toolName: tool.name,
          extractedToolName: tool.name,
          input,
          needsRepair: true,
          repairs: [...preRepairs, ...repaired.repairs],
          jsonRepairs: preJsonRepairs,
          toolNameExtraction: {
            ok: true,
            raw,
            name: tool.name,
            candidate: {
              name: tool.name,
              extractedName: tool.name,
              key: 'name',
              position: 0,
              score: 200,
              confidence: 'high',
              matchedKnownTool: true,
              delimiter: ':',
            },
            candidates: [],
          },
        }
      }
    }
  }

  return {
    ok: false,
    raw,
    toolName: tool.name,
    extractedToolName: tool.name,
    needsRepair: true,
    repairs: preRepairs,
    jsonRepairs: preJsonRepairs,
    error: 'schema_mismatch',
    message: `Unable to repair '${tool.name}' input so it satisfies the selected tool schema`,
  }
}
