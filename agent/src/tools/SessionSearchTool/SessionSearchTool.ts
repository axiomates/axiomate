/**
 * SessionSearchTool — built-in Tool exposing session_search to the LLM.
 *
 * The LLM autonomously calls this tool to recall past conversation content
 * (cross-session, project-scoped). Goes through axiomate's standard
 * deferred-tool discovery: ToolSearchTool surfaces the name; LLM fetches
 * the full schema on demand; tool call routes here.
 *
 * Two response modes:
 *   - 'recent' (no query): metadata-only listing of recent sessions, no LLM
 *   - search (with query): runSearch + optional summarizer
 *
 * Plan: see C:\Users\kiro\.claude\plans\ai-agent-harness-enginneering-hermes-ag-lucky-cloud.md
 */
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getOriginalCwd,
  getSessionId,
} from '../../bootstrap/state.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

import {
  SESSION_SEARCH_TOOL_NAME,
  getSessionSearchPrompt,
} from './prompt.js'
import { filterByMtime } from './preFilter.js'
import { runSearch } from './searchAlgorithm.js'
import { summarizeAll } from './summarizer.js'
import type { SessionSearchHit } from './types.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .optional()
      .describe(
        'Keyword(s) or short phrase to search for. Empty/missing → recent-mode (metadata listing only).',
      ),
    role_filter: z
      .enum(['user', 'assistant', 'tool'])
      .optional()
      .describe('Restrict matches to messages of a specific role.'),
    recent_days: z
      .number()
      .int()
      .optional()
      .describe(
        'How far back to search in days. Default 30. Set to 0 for no time filter.',
      ),
    limit: z
      .number()
      .int()
      .optional()
      .describe('Top-N results to return. Default 3, max 5.'),
    mode: z
      .enum(['summary', 'snippets'])
      .optional()
      .describe(
        "'summary' (default) invokes a cheap LLM to produce per-session focused summaries; 'snippets' returns raw windows with no LLM cost.",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

// Output is a freeform structured object; we don't enforce a strict schema
// here because the LLM consumes a JSON-stringified version.
type RecentResultEntry = {
  session_id: string
  mtime: string
  size_bytes: number
}

type SearchResultEntry = {
  session_id: string
  mtime: string
  score: number
  match_count?: number
  metadata_matches?: SessionSearchHit['metadataMatches']
  snippet?: string
  summary?: string
}

export type SessionSearchToolOutput =
  | {
      success: true
      mode: 'recent'
      results: RecentResultEntry[]
      count: number
      message: string
    }
  | {
      success: true
      mode: 'search'
      query: string
      results: SearchResultEntry[]
      count: number
    }
  | {
      success: false
      error: string
    }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_RECENT_DAYS = 30
const DEFAULT_LIMIT = 3
const MIN_LIMIT = 1
const MAX_LIMIT = 5

function clampLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(raw)))
}

function hitToEntry(h: SessionSearchHit): SearchResultEntry {
  return {
    session_id: h.sessionId,
    mtime: new Date(h.mtime).toISOString(),
    score: Number(h.score.toFixed(4)),
    match_count: h.matchCount,
    metadata_matches: h.metadataMatches,
    snippet: h.snippet,
    summary: h.summary,
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const SessionSearchTool = buildTool({
  name: SESSION_SEARCH_TOOL_NAME,
  searchHint: 'search past conversation sessions for content or metadata',
  shouldDefer: true,
  // Cap returned text to keep summary results from blowing tool result quota.
  // Each session summary is targeted ~800 tokens (~3KB); 5 sessions × 3KB
  // = 15KB; +snippets in 'snippets' mode pushes higher. 50K is comfortable.
  maxResultSizeChars: 50_000,

  // Minimal inline renderToolUseMessage — no React component file needed.
  // Keeps the tool self-contained.
  renderToolUseMessage(input, _options) {
    const i = input as Partial<Input>
    if (!i.query) return 'recent sessions'
    return `"${i.query}"${i.role_filter ? ` (role=${i.role_filter})` : ''}`
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description(input, _options) {
    return input.query
      ? `Searching past sessions for: ${input.query}`
      : 'Listing recent sessions'
  },

  userFacingName() {
    return 'Session Search'
  },

  async prompt() {
    return getSessionSearchPrompt()
  },

  isEnabled() {
    // Step 3 will gate via features.sessionSearchEnabled flag in the
    // tools.ts registry. This tool itself is always structurally available.
    return true
  },

  isReadOnly() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  async checkPermissions(input, _ctx?): Promise<PermissionResult> {
    return { behavior: 'allow', updatedInput: input }
  },

  async call(input: Input, _context, _canUseTool, _parentMessage) {
    let projectDir: string
    try {
      projectDir = getProjectDir(getOriginalCwd())
    } catch (err) {
      return {
        data: {
          success: false as const,
          error: `Failed to resolve project directory: ${(err as Error).message}`,
        } satisfies SessionSearchToolOutput,
      }
    }

    const limit = clampLimit(input.limit)
    const recentDays = input.recent_days ?? DEFAULT_RECENT_DAYS
    const query = input.query?.trim() ?? ''

    // Recent mode (no query): metadata-only listing, zero LLM cost
    if (!query) {
      const sessions = await filterByMtime(projectDir, recentDays)
      const results: RecentResultEntry[] = sessions.slice(0, limit).map(s => ({
        session_id: s.sessionId,
        mtime: new Date(s.mtime).toISOString(),
        size_bytes: s.size,
      }))
      return {
        data: {
          success: true as const,
          mode: 'recent' as const,
          results,
          count: results.length,
          message:
            results.length > 0
              ? `Showing ${results.length} most recent sessions. Pass a query to search content.`
              : 'No sessions found in the recent window. Pass recent_days=0 to search all history.',
        } satisfies SessionSearchToolOutput,
      }
    }

    // Search mode
    const hits = await runSearch(input, {
      projectDir,
      // Default INCLUDES current session (axiomate-specific divergence — see plan).
      // Caller can opt-out by setting AXIOMATE_SESSION_SEARCH_EXCLUDE_CURRENT=1
      // in the future if we add that flag; for Phase 1 we always include.
    })

    if (input.mode === 'snippets') {
      return {
        data: {
          success: true as const,
          mode: 'search' as const,
          query,
          results: hits.slice(0, limit).map(hitToEntry),
          count: Math.min(hits.length, limit),
        } satisfies SessionSearchToolOutput,
      }
    }

    // Default mode: summary
    const summarized = await summarizeAll(hits.slice(0, limit), { query })
    return {
      data: {
        success: true as const,
        mode: 'search' as const,
        query,
        results: summarized.map(hitToEntry),
        count: summarized.length,
      } satisfies SessionSearchToolOutput,
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output, null, 2),
    }
  },

  // Identifies a deferred current-session-id so subsequent invocations of the
  // same tool with the same args are deduped. Treat all session_search calls
  // as cacheable when input is identical.
  inputsEquivalent(a, b) {
    return JSON.stringify(a) === JSON.stringify(b)
  },
} satisfies ToolDef<InputSchema, SessionSearchToolOutput>)
