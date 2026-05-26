/**
 * Unit tests for SessionSearchTool registration & gating.
 *
 * Verifies sub-agent deny-list membership.
 *
 * Note on wiring coverage:
 * We do NOT call `getAllBaseTools()` from src/tools.ts here. That function
 * uses lazy CJS `require('./tools/.../*.js')` calls at runtime, which
 * vitest's TS-resolver cannot reach (`.js` doesn't fall through to `.ts`
 * source for runtime require). No other axiomate test calls it either.
 * SessionSearchTool is registered as a plain (non-conditional) entry in
 * `getAllBaseTools()` — same shape as WebSearchTool / FileReadTool. The
 * import statement is verified by tsc.
 */
import { describe, expect, test } from 'vitest'

import { SESSION_SEARCH_TOOL_NAME } from '../../../../tools/SessionSearchTool/prompt.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
} from '../../../../constants/tools.js'

describe('SessionSearchTool subagent gating', () => {
  test('SESSION_SEARCH_TOOL_NAME is in ALL_AGENT_DISALLOWED_TOOLS', () => {
    expect(ALL_AGENT_DISALLOWED_TOOLS.has(SESSION_SEARCH_TOOL_NAME)).toBe(true)
  })

  test('CUSTOM_AGENT_DISALLOWED_TOOLS inherits the block', () => {
    expect(CUSTOM_AGENT_DISALLOWED_TOOLS.has(SESSION_SEARCH_TOOL_NAME)).toBe(
      true,
    )
  })

  test('SESSION_SEARCH_TOOL_NAME is NOT in ASYNC_AGENT_ALLOWED_TOOLS', () => {
    // Async agents whitelist; absence = blocked
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has(SESSION_SEARCH_TOOL_NAME)).toBe(false)
  })
})
