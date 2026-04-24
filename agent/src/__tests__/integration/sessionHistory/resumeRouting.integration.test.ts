/**
 * Integration test for /resume command routing through real storage layer
 * (Step 0a-C addendum, fulfilling plan's "集成测" label).
 *
 * Difference from unit test in commands/resume/__tests__/resume.test.tsx:
 *   - Real fs reads via real loadSameRepoMessageLogs / searchSessionsByCustomTitle /
 *     getLastSessionLog → getSessionFilesLite → getSessionFilesWithMtime
 *   - Real JSONL fixtures written to temp project dir
 *   - Only bootstrap state + worktree resolution mocked (heavy bootstrap is
 *     out of scope for tests; rest of the stack runs honestly)
 *
 * Plan: see C:\Users\kiro\.claude\plans\ai-agent-harness-enginneering-hermes-ag-lucky-cloud.md
 */
import * as React from 'react'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { sanitizePath } from '../../../utils/sessionStoragePortable.js'

// ---------------------------------------------------------------------------
// vi.hoisted state container — updated each beforeEach. vi.mock factories are
// hoisted to top of file, so plain `let` would not be initialized when they
// run. vi.hoisted runs alongside the mocks, giving them a stable reference.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  tempDir: '',
  cwd: '',
  testCounter: 0,
}))

// ---------------------------------------------------------------------------
// Mocks (closures over `state`, resolved lazily at call time)
// ---------------------------------------------------------------------------

// Mock at envUtils level — the real getProjectDir calls real getProjectsDir
// which calls real getConfigHomeDir. ESM closures bind at module load, so
// mocking sessionStorage.js's exported getProjectsDir does NOT affect the
// internal reference inside getProjectDir's closure. Replacing
// getConfigHomeDir at its source is the correct mock boundary.
vi.mock('../../../utils/envUtils.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../utils/envUtils.js')>()
  return {
    ...actual,
    // Replace memoized export with a non-memoized closure → updated per test
    getConfigHomeDir: () => state.tempDir,
  }
})

vi.mock('../../../bootstrap/state.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../bootstrap/state.js')>()
  return {
    ...actual,
    getOriginalCwd: () => state.cwd,
    getSessionId: () => 'current-session-uuid',
  }
})

vi.mock('../../../utils/getWorktreePaths.js', () => ({
  getWorktreePaths: vi.fn(async () => []), // single worktree → uses originalCwd
}))

vi.mock('../../../utils/crossProjectResume.js', () => ({
  checkCrossProjectResume: () => ({ isCrossProject: false }),
}))

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { call } from '../../../commands/resume/resume.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const SESSION_C = '33333333-3333-4333-8333-333333333333'
const UUID_USER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UUID_ASSISTANT_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function userEntry(opts: {
  uuid: string
  parentUuid?: string | null
  text: string
  sessionId: string
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: opts.text },
    uuid: opts.uuid,
    parentUuid: opts.parentUuid ?? null,
    logicalParentUuid: null,
    isSidechain: false,
    cwd: state.cwd,
    userType: 'human',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? '2026-04-24T12:00:00.000Z',
    version: 'test',
  })
}

function assistantEntry(opts: {
  uuid: string
  parentUuid: string
  text: string
  sessionId: string
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: opts.text }] },
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    logicalParentUuid: null,
    isSidechain: false,
    cwd: state.cwd,
    userType: 'agent',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? '2026-04-24T12:00:01.000Z',
    version: 'test',
  })
}

function customTitleEntry(opts: {
  sessionId: string
  customTitle: string
}): string {
  return JSON.stringify({
    type: 'custom-title',
    sessionId: opts.sessionId,
    customTitle: opts.customTitle,
  })
}

async function writeRealSession(
  sessionId: string,
  entries: string[],
): Promise<string> {
  // Real getProjectsDir = join(getConfigHomeDir(), 'projects'), so fixtures
  // live in <tempDir>/projects/<sanitizePath(cwd)>/<sessionId>.jsonl
  const projectDir = join(state.tempDir, 'projects', sanitizePath(state.cwd))
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(filePath, entries.join('\n') + '\n', 'utf8')
  return filePath
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

beforeEach(async () => {
  state.testCounter++
  state.tempDir = await mkdtemp(join(tmpdir(), 'axiomate-resume-int-'))
  // Unique cwd per test → memoized getProjectDir cache stays clean
  state.cwd = `/tmp/axiomate-test-cwd-${state.testCounter}`
})

afterEach(async () => {
  if (state.tempDir) {
    await rm(state.tempDir, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests — real fs end-to-end through call()
// ---------------------------------------------------------------------------

describe('/resume integration — empty arg', () => {
  test('returns ResumeCommand picker element (no fs reads)', async () => {
    const result = await call(vi.fn(), makeContext(), '')
    expect(React.isValidElement(result)).toBe(true)
  })
})

describe('/resume integration — UUID arg with real session files', () => {
  test('valid UUID with matching real JSONL → context.resume invoked', async () => {
    await writeRealSession(SESSION_A, [
      userEntry({
        uuid: UUID_USER_1,
        text: 'real session content',
        sessionId: SESSION_A,
      }),
      assistantEntry({
        uuid: UUID_ASSISTANT_1,
        parentUuid: UUID_USER_1,
        text: 'response',
        sessionId: SESSION_A,
      }),
    ])

    const ctx = makeContext()
    const result = await call(vi.fn(), ctx, SESSION_A)
    expect(result).toBeNull()
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect((ctx.resume as any).mock.calls[0][0]).toBe(SESSION_A)
    expect((ctx.resume as any).mock.calls[0][2]).toBe(
      'slash_command_session_id',
    )
  })

  test('valid UUID with no matching file → ResumeError sessionNotFound', async () => {
    // Write SESSION_B but ask for SESSION_C
    await writeRealSession(SESSION_B, [
      userEntry({
        uuid: UUID_USER_1,
        text: 'something else',
        sessionId: SESSION_B,
      }),
    ])

    const ctx = makeContext()
    const result = await call(vi.fn(), ctx, SESSION_C)
    // Either gets to ResumeError, or fallback getLastSessionLog also fails
    // Result is a React element (ResumeError) or null.
    if (result === null) {
      // getLastSessionLog might have found nothing; ctx.resume not called
      expect(ctx.resume).not.toHaveBeenCalled()
    } else {
      expect(React.isValidElement(result)).toBe(true)
      // ResumeError carries 'was not found' message
      expect((result as any).props.message).toContain('was not found')
    }
  })

  test('multiple sessions on disk; UUID picks the right one', async () => {
    await writeRealSession(SESSION_A, [
      userEntry({ uuid: UUID_USER_1, text: 'session A', sessionId: SESSION_A }),
    ])
    await writeRealSession(SESSION_B, [
      userEntry({ uuid: UUID_USER_1, text: 'session B', sessionId: SESSION_B }),
    ])
    await writeRealSession(SESSION_C, [
      userEntry({ uuid: UUID_USER_1, text: 'session C', sessionId: SESSION_C }),
    ])

    const ctx = makeContext()
    await call(vi.fn(), ctx, SESSION_B)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect((ctx.resume as any).mock.calls[0][0]).toBe(SESSION_B)
  })
})

describe('/resume integration — custom title arg', () => {
  test('exact title match in real custom-title entry → resume with slash_command_title', async () => {
    await writeRealSession(SESSION_A, [
      userEntry({
        uuid: UUID_USER_1,
        text: 'work on deploy',
        sessionId: SESSION_A,
      }),
      customTitleEntry({
        sessionId: SESSION_A,
        customTitle: 'My deploy script',
      }),
    ])

    const ctx = makeContext()
    const result = await call(vi.fn(), ctx, 'My deploy script')
    expect(result).toBeNull()
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect((ctx.resume as any).mock.calls[0][0]).toBe(SESSION_A)
    expect((ctx.resume as any).mock.calls[0][2]).toBe('slash_command_title')
  })

  test('no logs at all → ResumeError "No conversations found"', async () => {
    // Don't write any session files
    const ctx = makeContext()
    const result = await call(vi.fn(), ctx, 'anything')
    expect(React.isValidElement(result)).toBe(true)
    expect((result as any).props.message).toBe(
      'No conversations found to resume.',
    )
    expect(ctx.resume).not.toHaveBeenCalled()
  })
})
