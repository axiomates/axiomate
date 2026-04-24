/**
 * SessionSearchTool — LLM-facing prompts.
 *
 * Two prompts live here:
 *   1. getSessionSearchPrompt() — describes the tool to the main agent so
 *      it knows when to invoke this tool (returned by the Tool's prompt()).
 *   2. getSummaryPrompt(query) — system prompt for the per-session
 *      summarization LLM call (Step 4 of the algorithm; called by
 *      summarizer.ts via sideQuery).
 *
 * Tone: terse, declarative, action-focused. Mirrors hermes
 * session_search_tool.py:1-16 docstring style.
 */
export const SESSION_SEARCH_TOOL_NAME = 'SessionSearch'

export function getSessionSearchPrompt(): string {
  return `Search past conversation sessions in this project for relevant content.

When to use:
- User references something from a prior conversation ("last time we...", "remember when...", "the script we wrote on Monday")
- You need to recall a specific command, file path, or solution from earlier work
- You need to recover context that was lost to compact (axiomate compresses old messages but preserves originals on disk; this tool retrieves them)

How it works:
- Searches all session JSONL files for the same project
- Stage 1: filters by mtime (default last 30 days)
- Stage 2: scans session metadata (title / tag / summary) for the query
- Stage 3: streams full message content looking for case-insensitive substring match
- Stage 4: ranks by relevance (BM25-like + tag/title boost + recency decay)

Inputs:
- query: keyword(s) or short phrase. Empty/missing → recent-mode (metadata listing only, no search)
- role_filter: optional 'user' | 'assistant' | 'tool' to restrict matches
- recent_days: how far back to search (default 30; set to 0 for no time filter)
- limit: top-N results (default 3, max 5)
- include_summary: default false. When true, additionally calls a cheap aux LLM to produce a focused 5-point recap per result (adds 1-3s + LLM cost)

Returns: JSON envelope with results[]. Each result always has session_id, mtime, snippet, score, optional metadata_matches. summary is added only when include_summary=true.

Choosing include_summary:
- Default (false) — RETRIEVAL: you want verbatim text. Examples:
  * "what was that exact docker command"
  * "what was the auth error stack trace"
  * "did we discuss kubernetes" (yes/no via metadata + first lines)
  * "find the session where we changed nginx.conf"
  Use the raw snippet — summary may paraphrase critical tokens.

- include_summary=true — SYNTHESIS: you want pre-digested overview. Examples:
  * "what did I work on last week" (multi-session digest)
  * "have I made the same mistake before" (cross-session pattern)
  * "summarize the React refactor sessions"
  The 5-point recap (asked / actions / decisions / technical details / unresolved) is structured for cross-session comparison.

Mixed strategy: start with default (snippet only). If snippets are too noisy or you need a per-session digest, retry with include_summary=true.

The current session IS included in the search by default — useful for recalling content lost to compact.`
}

/**
 * System prompt for the per-session summarizer LLM call.
 *
 * Asks the cheap aux model (fastModel) to produce a focused recap of one
 * session's relevant content given the original query. The LLM sees the
 * snippet window (already truncated to ~100KB by snippet.ts) and writes
 * a tight factual recap.
 *
 * Modeled on hermes _summarize_session prompt (tools/session_search_tool.py:200-210).
 */
export function getSummaryPrompt(query: string): string {
  return `You are reviewing a past conversation transcript to help the user/agent recall what happened.

Search topic: "${query}"

Summarize this excerpt with focus on the search topic. Include:
1. What the user asked or wanted to accomplish
2. What actions were taken and what the outcomes were
3. Key decisions, solutions, or conclusions
4. Any specific commands, file paths, URLs, or technical details worth recalling
5. Anything left unresolved or notable

Be thorough but concise. Preserve specific details (commands, paths, error messages). Write in past tense as a factual recap. Do not invent facts — if the excerpt is too short or off-topic, say so plainly.`
}
