/**
 * Unit tests for SessionSearchTool registration & gating (Step 3).
 *
 * Verifies:
 * - isSessionSearchEnabled() respects env override + settings fallback
 * - getAllBaseTools() includes/excludes SessionSearchTool by flag
 * - ALL_AGENT_DISALLOWED_TOOLS contains SessionSearch (sub-agent recursion guard)
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { SESSION_SEARCH_TOOL_NAME } from '../prompt.js'

// Mock settings/config to avoid file I/O during these unit tests.
vi.mock('../../../utils/settings/settings.js', () => ({
  getInitialSettings: vi.fn(() => ({})),
}))

import { getInitialSettings } from '../../../utils/settings/settings.js'
import { isSessionSearchEnabled } from '../featureFlag.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
} from '../../../constants/tools.js'

// Note on wiring coverage:
// We do NOT import or call `getAllBaseTools()` from src/tools.ts here.
// That function uses lazy CJS `require('./tools/.../*.js')` calls at
// runtime, which vitest's TS-resolver cannot reach (`.js` doesn't fall
// through to `.ts` source for runtime require). No other test calls it
// either. The wiring is structurally a one-line conditional spread
//   ...(isSessionSearchEnabled() ? [SessionSearchTool] : [])
// — gate correctness is covered by isSessionSearchEnabled tests below;
// the import statement is verified by tsc.

const mockSettings = vi.mocked(getInitialSettings)

const ENV_KEY = 'AXIOMATE_CODE_ENABLE_SESSION_SEARCH'
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  vi.clearAllMocks()
  mockSettings.mockReturnValue({})
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

// ---------------------------------------------------------------------------
// isSessionSearchEnabled
// ---------------------------------------------------------------------------

describe('isSessionSearchEnabled', () => {
  test('default: false (no env, no settings)', () => {
    expect(isSessionSearchEnabled()).toBe(false)
  })

  test('settings.sessionSearchEnabled=true → true', () => {
    mockSettings.mockReturnValue({ sessionSearchEnabled: true })
    expect(isSessionSearchEnabled()).toBe(true)
  })

  test('settings.sessionSearchEnabled=false → false', () => {
    mockSettings.mockReturnValue({ sessionSearchEnabled: false })
    expect(isSessionSearchEnabled()).toBe(false)
  })

  test('env var "1" → true (overrides settings)', () => {
    mockSettings.mockReturnValue({ sessionSearchEnabled: false })
    process.env[ENV_KEY] = '1'
    expect(isSessionSearchEnabled()).toBe(true)
  })

  test('env var "true" → true', () => {
    process.env[ENV_KEY] = 'true'
    expect(isSessionSearchEnabled()).toBe(true)
  })

  test('env var "0" → falls through to settings', () => {
    process.env[ENV_KEY] = '0'
    mockSettings.mockReturnValue({ sessionSearchEnabled: true })
    expect(isSessionSearchEnabled()).toBe(true)
    mockSettings.mockReturnValue({ sessionSearchEnabled: false })
    expect(isSessionSearchEnabled()).toBe(false)
  })

  test('env var unset, settings undefined → false', () => {
    mockSettings.mockReturnValue(undefined as any)
    expect(isSessionSearchEnabled()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ALL_AGENT_DISALLOWED_TOOLS membership
// ---------------------------------------------------------------------------

describe('Subagent gating', () => {
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
