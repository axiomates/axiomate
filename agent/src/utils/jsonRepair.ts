// Barrel re-export — the implementation is split across three files:
// - tolerantJsonParser.ts: JSON repair engine (TolerantJsonParser + repairJsonText)
// - toolNameExtraction.ts: tool name extraction from malformed JSON-like text
// - schemaGuidedRepair.ts: schema-guided tool input repair

export {
  repairJsonText,
  type JsonPrimitive,
  type JsonValue,
  type JsonRepairKind,
  type JsonRepair,
  type JsonAstNode,
  type JsonRepairOptions,
  type JsonRepairSuccess,
  type JsonRepairFailure,
  type JsonRepairResult,
} from './tolerantJsonParser.js'

export {
  extractToolNameFromJsonLikeText,
  type JsonLikeToolNameCandidate,
  type JsonLikeToolNameExtractionOptions,
  type JsonLikeToolNameExtractionSuccess,
  type JsonLikeToolNameExtractionFailure,
  type JsonLikeToolNameExtractionResult,
} from './toolNameExtraction.js'

export {
  repairToolCallJsonAgainstSchemas,
  repairToolInputAgainstSchema,
  type SchemaGuidedToolDefinition,
  type SchemaGuidedToolInputRepairKind,
  type SchemaGuidedToolInputRepair,
  type SchemaGuidedToolCallRepairOptions,
  type SchemaGuidedToolCallRepairSuccess,
  type SchemaGuidedToolCallRepairFailure,
  type SchemaGuidedToolCallRepairResult,
} from './schemaGuidedRepair.js'
