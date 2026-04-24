/**
 * Type definitions for SessionSearchTool.
 *
 * The tool exposes a hermes-style `session_search(query, ...)` interface to
 * the LLM. See plan file (Step 1a) for the design rationale.
 */

export type RoleFilter = 'user' | 'assistant' | 'tool'

/** Inputs accepted by the tool / search algorithm. */
export interface SessionSearchInput {
  /** Empty / missing query → recent-mode (metadata listing only, no LLM). */
  query?: string
  /** Restrict matches to messages of a specific role. */
  role_filter?: RoleFilter
  /** mtime cutoff in days; default 30. 0 or negative → no time filter. */
  recent_days?: number
  /** Top-N session results to return; default 3, clamped to [1, 5]. */
  limit?: number
  /**
   * When true, additionally invoke a cheap aux LLM (fastModel) per result
   * to produce a focused 5-point recap (user ask / actions / decisions /
   * technical details / unresolved). Adds 1-3s latency and LLM cost.
   *
   * Default false → pure retrieval, raw snippets only, zero LLM cost.
   *
   * Use `true` for synthesis-class queries where you want pre-digested
   * overview across sessions ("what did I work on last week"). For
   * retrieval-class queries ("what was that exact command") prefer the
   * default — snippets preserve verbatim tokens that summary may paraphrase.
   */
  include_summary?: boolean
}

/** Per-session file info from the mtime pre-filter stage. */
export interface SessionFileInfo {
  sessionId: string
  filePath: string
  /** epoch ms */
  mtime: number
  /** epoch ms (birthtime; from stat) */
  ctime: number
  /** bytes */
  size: number
}

/** Which metadata field carried a query match. */
export type MetadataField = 'title' | 'customTitle' | 'tag' | 'summary'

/** Result of the metadata-tail scan (Stage 2). Caller pairs with sessionId. */
export interface MetadataMatch {
  fields: MetadataField[]
  /** Raw matched values for downstream snippet/scoring use. */
  matchedValues: Partial<Record<MetadataField, string>>
}

/** Per-session hit returned by the search algorithm. */
export interface SessionSearchHit {
  sessionId: string
  filePath: string
  /** epoch ms */
  mtime: number
  /** Snippet window for non-summary mode. */
  snippet?: string
  /** LLM-generated focused summary for summary mode. */
  summary?: string
  /** Total query-content matches found in the file (for ranking). */
  matchCount?: number
  /** Computed relevance score; higher = more relevant. */
  score: number
  /** Which metadata fields matched (if any). */
  metadataMatches?: MetadataField[]
}

/** Outer envelope returned by the tool. */
export interface SessionSearchResult {
  success: boolean
  query?: string
  results: SessionSearchHit[]
  count: number
  message?: string
}
