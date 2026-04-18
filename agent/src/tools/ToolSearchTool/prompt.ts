import type { Tool } from '../../Tool.js'

export { TOOL_SEARCH_TOOL_NAME } from './constants.js'

import { TOOL_SEARCH_TOOL_NAME } from './constants.js'

const PROMPT_HEAD = `Fetches full schema definitions for deferred tools so they can be called.

`

// Matches isDeferredToolsDeltaEnabled in toolSearch.ts (not imported —
// toolSearch.ts imports from this file). When enabled: tools announced
// via system-reminder attachments. When disabled: prepended
// <available-deferred-tools> block (pre-gate behavior).
function getToolLocationHint(): string {
  const deltaEnabled =
    false
  return deltaEnabled
    ? 'Deferred tools appear by name in <system-reminder> messages.'
    : 'Deferred tools appear by name in <available-deferred-tools> messages.'
}

const PROMPT_TAIL = ` Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 * A tool is deferred if:
 * - It's an MCP tool (always deferred - workflow-specific)
 * - It has shouldDefer: true
 *
 * A tool is NEVER deferred if it has alwaysLoad: true (MCP tools set this via
 * _meta['anthropic/alwaysLoad']). This check runs first, before any other rule.
 */
export function isDeferredTool(tool: Tool): boolean {
  // Explicit opt-out via _meta['anthropic/alwaysLoad'] — tool appears in the
  // initial prompt with full schema. Checked first so MCP tools can opt out.
  if (tool.alwaysLoad === true) return false

  // MCP tools are always deferred (workflow-specific)
  if (tool.isMcp === true) return true

  // Never defer ToolSearch itself — the model needs it to load everything else
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  return tool.shouldDefer === true
}

/**
 * Format one deferred-tool line for the <available-deferred-tools> user
 * message. Search hints (tool.searchHint) are not rendered — the
 * hints A/B (exp_xenhnnmn0smrx4, stopped Mar 21) showed no benefit.
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}
