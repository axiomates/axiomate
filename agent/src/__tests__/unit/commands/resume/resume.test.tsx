/**
 * Characterization tests for /resume command routing logic (Step 0a-C).
 *
 * Focus: the `call()` function in resume.tsx — anchors arg-parsing and
 * dispatch behavior (UUID lookup, custom-title match, picker fallback,
 * error reporting). The interactive ResumeCommand React component is
 * NOT tested at the UI level — characterization is on the routing
 * decision tree.
 *
 * Plan: see C:\Users\kiro\.claude\plans\ai-agent-harness-enginneering-hermes-ag-lucky-cloud.md
 */
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LogOption } from '../../../../types/logs.js'

// ---------------------------------------------------------------------------
// Mocks: all heavy imports stubbed before the unit under test loads.
// ---------------------------------------------------------------------------

vi.mock('../../../../utils/sessionStorage.js', () => ({
  getLastSessionLog: vi.fn(),
  getSessionIdFromLog: vi.fn((log: LogOption) =>
    log.sessionId ?? (log.messages[0] as any)?.sessionId,
  ),
  isCustomTitleEnabled: vi.fn(() => true),
  isLiteLog: vi.fn((log: LogOption) => Boolean(log.isLite)),
  loadAllProjectsMessageLogs: vi.fn(),
  loadFullLog: vi.fn(async (log: LogOption) => log),
  loadSameRepoMessageLogs: vi.fn(),
  searchSessionsByCustomTitle: vi.fn(),
}))

vi.mock('../../../../utils/agenticSessionSearch.js', () => ({
  agenticSessionSearch: vi.fn(),
}))

vi.mock('../../../../utils/crossProjectResume.js', () => ({
  checkCrossProjectResume: vi.fn(() => ({ isCrossProject: false })),
}))

vi.mock('../../../../utils/getWorktreePaths.js', () => ({
  getWorktreePaths: vi.fn(async () => []),
}))

vi.mock('../../../../utils/log.js', () => ({
  logError: vi.fn(),
}))

// Partial mock — keep all original exports, only override the two we need.
// resume.tsx → LogSelector → keybindings/defaultBindings indirectly needs
// getAllowedSettingSources etc., so a full replacement breaks the import.
vi.mock('../../../../bootstrap/state.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../bootstrap/state.js')>()
  return {
    ...actual,
    getOriginalCwd: vi.fn(() => '/tmp'),
    getSessionId: vi.fn(() => 'current-session-id'),
  }
})

// validateUuid is real — it's pure logic, no need to mock
import {
  loadSameRepoMessageLogs,
  searchSessionsByCustomTitle,
  isCustomTitleEnabled,
  getLastSessionLog,
  loadFullLog,
} from '../../../../utils/sessionStorage.js'
// Import call AFTER mocks are set up
import { call, filterResumableSessions } from '../../../../commands/resume/resume.js'

const mockLoadSameRepo = vi.mocked(loadSameRepoMessageLogs)
const mockSearchByTitle = vi.mocked(searchSessionsByCustomTitle)
const mockIsCustomTitleEnabled = vi.mocked(isCustomTitleEnabled)
const mockGetLastSessionLog = vi.mocked(getLastSessionLog)
const mockLoadFullLog = vi.mocked(loadFullLog)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '11111111-1111-4111-8111-111111111111'
const VALID_UUID_2 = '22222222-2222-4222-8222-222222222222'

function makeLog(overrides: Partial<LogOption> = {}): LogOption {
  return {
    date: '2026-04-24',
    messages: [],
    value: 0,
    created: new Date('2026-04-24T00:00:00Z'),
    modified: new Date('2026-04-24T00:00:00Z'),
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    sessionId: VALID_UUID,
    ...overrides,
  }
}

function makeContext() {
  return {
    resume: vi.fn(async () => {}),
    options: {} as any,
    setForkConvoWithMessagesOnTheNextRender: vi.fn(),
    abortController: new AbortController(),
    setShouldExit: vi.fn(),
    setExitMessage: vi.fn(),
    forkContextMessages: null,
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsCustomTitleEnabled.mockReturnValue(true)
  mockLoadFullLog.mockImplementation(async (log: LogOption) => log)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/resume call() — empty arg shows picker', () => {
  test('returns ResumeCommand element when arg is empty string', async () => {
    const onDone = vi.fn()
    const result = await call(onDone, makeContext(), '')
    expect(result).toBeTruthy()
    expect(React.isValidElement(result)).toBe(true)
    // Empty arg never touches loadSameRepoMessageLogs
    expect(mockLoadSameRepo).not.toHaveBeenCalled()
  })

  test('returns ResumeCommand element when arg is whitespace only', async () => {
    const onDone = vi.fn()
    const result = await call(onDone, makeContext(), '   \t  ')
    expect(React.isValidElement(result)).toBe(true)
    expect(mockLoadSameRepo).not.toHaveBeenCalled()
  })

  test('returns ResumeCommand element when arg is undefined', async () => {
    const onDone = vi.fn()
    const result = await call(onDone, makeContext(), undefined as any)
    expect(React.isValidElement(result)).toBe(true)
  })
})

describe('/resume call() — no logs at all', () => {
  test('returns ResumeError "No conversations found" when no logs', async () => {
    mockLoadSameRepo.mockResolvedValueOnce([])
    const onDone = vi.fn()
    const result = await call(onDone, makeContext(), 'anything')
    expect(React.isValidElement(result)).toBe(true)
    expect((result as any).props.message).toBe('No conversations found to resume.')
  })
})

describe('/resume call() — UUID arg', () => {
  test('UUID match found in enriched logs → onResume is called via context.resume', async () => {
    const matchingLog = makeLog({ sessionId: VALID_UUID })
    mockLoadSameRepo.mockResolvedValueOnce([matchingLog])

    const ctx = makeContext()
    const onDone = vi.fn()
    const result = await call(onDone, ctx, VALID_UUID)

    // Returns null when resume is invoked
    expect(result).toBeNull()
    // Wait for async resume callback
    await new Promise(r => setImmediate(r))
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect(ctx.resume).toHaveBeenCalledWith(
      VALID_UUID,
      matchingLog,
      'slash_command_session_id',
    )
  })

  test('UUID not in enriched logs → falls back to getLastSessionLog', async () => {
    mockLoadSameRepo.mockResolvedValueOnce([
      makeLog({ sessionId: VALID_UUID_2 }), // different UUID
    ])
    const directLog = makeLog({ sessionId: VALID_UUID })
    mockGetLastSessionLog.mockResolvedValueOnce(directLog)

    const ctx = makeContext()
    const onDone = vi.fn()
    const result = await call(onDone, ctx, VALID_UUID)
    expect(result).toBeNull()
    await new Promise(r => setImmediate(r))
    expect(mockGetLastSessionLog).toHaveBeenCalledWith(VALID_UUID)
    expect(ctx.resume).toHaveBeenCalledWith(
      VALID_UUID,
      directLog,
      'slash_command_session_id',
    )
  })

  test('UUID with multiple log entries → most recent (by modified) wins', async () => {
    const old = makeLog({
      sessionId: VALID_UUID,
      modified: new Date('2026-01-01'),
      firstPrompt: 'old',
    })
    const recent = makeLog({
      sessionId: VALID_UUID,
      modified: new Date('2026-04-24'),
      firstPrompt: 'recent',
    })
    mockLoadSameRepo.mockResolvedValueOnce([old, recent])

    const ctx = makeContext()
    await call(vi.fn(), ctx, VALID_UUID)
    await new Promise(r => setImmediate(r))
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect((ctx.resume as any).mock.calls[0][1].firstPrompt).toBe('recent')
  })

  test('lite log → loadFullLog is called before resume', async () => {
    const liteLog = makeLog({ sessionId: VALID_UUID, isLite: true })
    const fullLog = makeLog({
      sessionId: VALID_UUID,
      isLite: false,
      firstPrompt: 'full',
    })
    mockLoadSameRepo.mockResolvedValueOnce([liteLog])
    mockLoadFullLog.mockResolvedValueOnce(fullLog)

    const ctx = makeContext()
    await call(vi.fn(), ctx, VALID_UUID)
    await new Promise(r => setImmediate(r))
    expect(mockLoadFullLog).toHaveBeenCalledWith(liteLog)
    expect(ctx.resume).toHaveBeenCalledWith(
      VALID_UUID,
      fullLog,
      'slash_command_session_id',
    )
  })
})

describe('/resume call() — custom title arg', () => {
  test('exact title match (single result) → onResume with slash_command_title', async () => {
    mockLoadSameRepo.mockResolvedValueOnce([makeLog()]) // pass non-empty gate
    const titleMatch = makeLog({
      sessionId: VALID_UUID,
      customTitle: 'My deploy',
    })
    mockSearchByTitle.mockResolvedValueOnce([titleMatch])

    const ctx = makeContext()
    const result = await call(vi.fn(), ctx, 'My deploy')
    expect(result).toBeNull()
    await new Promise(r => setImmediate(r))
    expect(mockSearchByTitle).toHaveBeenCalledWith('My deploy', { exact: true })
    expect(ctx.resume).toHaveBeenCalledWith(
      VALID_UUID,
      titleMatch,
      'slash_command_title',
    )
  })

  test('multiple title matches → ResumeError multipleMatches', async () => {
    mockLoadSameRepo.mockResolvedValueOnce([makeLog()])
    mockSearchByTitle.mockResolvedValueOnce([
      makeLog({ sessionId: VALID_UUID, customTitle: 'duplicate' }),
      makeLog({ sessionId: VALID_UUID_2, customTitle: 'duplicate' }),
    ])

    const onDone = vi.fn()
    const result = await call(onDone, makeContext(), 'duplicate')
    expect(React.isValidElement(result)).toBe(true)
    expect((result as any).props.message).toContain('Found 2 sessions')
    expect((result as any).props.message).toContain('duplicate')
  })

  test('zero title matches → ResumeError sessionNotFound', async () => {
    mockLoadSameRepo.mockResolvedValueOnce([makeLog()])
    mockSearchByTitle.mockResolvedValueOnce([])

    const result = await call(vi.fn(), makeContext(), 'no-such-title')
    expect(React.isValidElement(result)).toBe(true)
    expect((result as any).props.message).toContain('was not found')
    expect((result as any).props.message).toContain('no-such-title')
  })

  test('custom title disabled → goes straight to sessionNotFound for non-UUID', async () => {
    mockIsCustomTitleEnabled.mockReturnValue(false)
    mockLoadSameRepo.mockResolvedValueOnce([makeLog()])

    const result = await call(vi.fn(), makeContext(), 'some-title')
    expect(React.isValidElement(result)).toBe(true)
    expect((result as any).props.message).toContain('was not found')
    // searchSessionsByCustomTitle must NOT be called
    expect(mockSearchByTitle).not.toHaveBeenCalled()
  })
})

describe('/resume call() — context.resume failure handling', () => {
  test('context.resume throws → onDone called with error message', async () => {
    const matchingLog = makeLog({ sessionId: VALID_UUID })
    mockLoadSameRepo.mockResolvedValueOnce([matchingLog])

    const ctx = makeContext()
    ;(ctx.resume as any).mockRejectedValueOnce(new Error('fork conflict'))

    const onDone = vi.fn()
    await call(onDone, ctx, VALID_UUID)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r)) // 2nd tick for inner async

    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('fork conflict'),
    )
  })
})

describe('filterResumableSessions — current-session and sidechain exclusion', () => {
  test('excludes the current session', () => {
    const current = makeLog({ sessionId: 'current-session-id' })
    const other = makeLog({ sessionId: 'other-id' })
    const result = filterResumableSessions(
      [current, other],
      'current-session-id',
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.sessionId).toBe('other-id')
  })

  test('excludes sidechain sessions', () => {
    const main = makeLog({ sessionId: 'main', isSidechain: false })
    const side = makeLog({ sessionId: 'side', isSidechain: true })
    const result = filterResumableSessions([main, side], 'unrelated')
    expect(result).toHaveLength(1)
    expect(result[0]!.sessionId).toBe('main')
  })

  test('returns empty array when only current/sidechain logs exist', () => {
    const current = makeLog({ sessionId: 'current-session-id' })
    const side = makeLog({ sessionId: 'side', isSidechain: true })
    const result = filterResumableSessions(
      [current, side],
      'current-session-id',
    )
    expect(result).toHaveLength(0)
  })
})
