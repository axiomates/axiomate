import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { sanitizePath } from '../../../../utils/sessionStoragePortable.js'

const state = vi.hoisted(() => ({
  tempDir: '',
  cwd: '',
  sessionId: '',
  counter: 0,
}))

vi.mock('../../../../utils/envUtils.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/envUtils.js')>()
  return { ...actual, getConfigHomeDir: () => state.tempDir }
})

vi.mock('../../../../bootstrap/state.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../bootstrap/state.js')>()
  return {
    ...actual,
    getOriginalCwd: () => state.cwd,
    getSessionId: () => state.sessionId,
  }
})

// Mock judge — every test arranges its own return values.
vi.mock('../../../../utils/goal/goalJudge.js', () => ({
  judgeGoal: vi.fn(),
  DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES: 10,
}))

// Pin goalsParseFailureLimit to 3 so the parse-failure pause test
// stays fast (3 mock calls instead of 10). currentModel must be set
// because getCurrentModel() throws otherwise — getAuxiliaryModel reads it
// transitively via getMidModel/getFastModel in some paths.
vi.mock('../../../../utils/config.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/config.js')>()
  return {
    ...actual,
    getGlobalConfig: () => ({
      ...actual.getGlobalConfig(),
      currentModel: 'test-model',
      models: { 'test-model': { name: 'Test' } },
      goalsParseFailureLimit: 3,
    }),
  }
})

import type { UUID } from 'crypto'
import { judgeGoal } from '../../../../utils/goal/goalJudge.js'
import { GoalManager } from '../../../../utils/goal/goalManager.js'

const mockedJudge = vi.mocked(judgeGoal)

beforeEach(async () => {
  state.counter++
  state.tempDir = await mkdtemp(join(tmpdir(), 'axiomate-goal-mgr-'))
  state.cwd = `/tmp/axiomate-goal-mgr-cwd-${state.counter}`
  state.sessionId = `00000000-0000-4000-8000-${String(state.counter).padStart(12, '0')}`
  await mkdir(join(state.tempDir, 'projects', sanitizePath(state.cwd)), {
    recursive: true,
  })
  mockedJudge.mockReset()
})

afterEach(async () => {
  if (state.tempDir) await rm(state.tempDir, { recursive: true, force: true })
})

function sid(): UUID {
  return state.sessionId as UUID
}

const fakeSignal = (): AbortSignal => new AbortController().signal

describe('GoalManager.load + lifecycle', () => {
  test('load on empty session returns no-goal manager', async () => {
    const mgr = await GoalManager.load(sid())
    expect(mgr.state).toBeNull()
    expect(mgr.isActive()).toBe(false)
    expect(mgr.hasGoal()).toBe(false)
    expect(mgr.statusLine()).toContain('No active goal')
  })

  test('set then load returns same goal', async () => {
    const a = await GoalManager.load(sid())
    await a.set('do thing', { maxTurns: 5 })

    const b = await GoalManager.load(sid())
    expect(b.state?.goal).toBe('do thing')
    expect(b.state?.maxTurns).toBe(5)
    expect(b.isActive()).toBe(true)
  })

  test('set rejects empty / whitespace goal', async () => {
    const mgr = await GoalManager.load(sid())
    await expect(mgr.set('   ')).rejects.toThrow('empty')
  })

  test('pause then resume preserves goal text, resets budget by default', async () => {
    const mgr = await GoalManager.load(sid())
    await mgr.set('walk', { maxTurns: 10 })
    mgr.state!.turnsUsed = 7
    await mgr.pause('manual')
    expect(mgr.state?.status).toBe('paused')
    expect(mgr.state?.pausedReason).toBe('manual')
    await mgr.resume()
    expect(mgr.state?.status).toBe('active')
    expect(mgr.state?.turnsUsed).toBe(0)
  })

  test('resume({resetBudget:false}) keeps turns used', async () => {
    const mgr = await GoalManager.load(sid())
    await mgr.set('walk')
    mgr.state!.turnsUsed = 4
    await mgr.pause()
    await mgr.resume({ resetBudget: false })
    expect(mgr.state?.turnsUsed).toBe(4)
  })

  test('clear yields no-goal state', async () => {
    const mgr = await GoalManager.load(sid())
    await mgr.set('one')
    await mgr.clear()
    expect(mgr.state).toBeNull()
    const reloaded = await GoalManager.load(sid())
    expect(reloaded.state).toBeNull()
  })
})

describe('subgoals', () => {
  test('add / remove / clear', async () => {
    const mgr = await GoalManager.load(sid())
    await mgr.set('parent')
    await mgr.addSubgoal(' first ')
    await mgr.addSubgoal('second')
    expect(mgr.state?.subgoals).toEqual(['first', 'second'])

    await mgr.removeSubgoal(1)
    expect(mgr.state?.subgoals).toEqual(['second'])

    const removedCount = await mgr.clearSubgoals()
    expect(removedCount).toBe(1)
    expect(mgr.state?.subgoals).toEqual([])
  })

  test('addSubgoal without active goal throws', async () => {
    const mgr = await GoalManager.load(sid())
    await expect(mgr.addSubgoal('x')).rejects.toThrow('no active goal')
  })

  test('removeSubgoal out of range throws RangeError', async () => {
    const mgr = await GoalManager.load(sid())
    await mgr.set('p')
    await mgr.addSubgoal('only')
    await expect(mgr.removeSubgoal(5)).rejects.toThrow(RangeError)
  })
})

describe('evaluateAfterTurn — branch ordering', () => {
  test('inactive goal — no judge call', async () => {
    const mgr = await GoalManager.load(sid())
    const r = await mgr.evaluateAfterTurn({
      lastResponse: 'whatever',
      signal: fakeSignal(),
    })
    expect(r.verdict).toBe('inactive')
    expect(r.shouldContinue).toBe(false)
    expect(mockedJudge).not.toHaveBeenCalled()
  })

  test('interrupted=true → pause without judge call', async () => {
    const mgr = await GoalManager.load(sid())
    await mgr.set('long task', { maxTurns: 20 })
    const r = await mgr.evaluateAfterTurn({
      lastResponse: 'partial work',
      interrupted: true,
      signal: fakeSignal(),
    })
    expect(r.status).toBe('paused')
    expect(r.shouldContinue).toBe(false)
    expect(r.message).toContain('interrupted')
    expect(mockedJudge).not.toHaveBeenCalled()
    expect(mgr.state?.pausedReason).toContain('Ctrl+C')
    expect(mgr.state?.turnsUsed).toBe(0) // not counted
  })

  test('empty response — no budget bump, no judge', async () => {
    const mgr = await GoalManager.load(sid())
    await mgr.set('task')
    const r = await mgr.evaluateAfterTurn({
      lastResponse: '   ',
      signal: fakeSignal(),
    })
    expect(r.verdict).toBe('continue')
    expect(r.shouldContinue).toBe(false)
    expect(r.message).toBe('')
    expect(mockedJudge).not.toHaveBeenCalled()
    expect(mgr.state?.turnsUsed).toBe(0)
  })

  test('done verdict — status=done, no continuation', async () => {
    mockedJudge.mockResolvedValue({
      verdict: 'done',
      reason: 'shipped',
      parseFailed: false,
    })
    const mgr = await GoalManager.load(sid())
    await mgr.set('ship it')
    const r = await mgr.evaluateAfterTurn({
      lastResponse: 'shipped fix',
      signal: fakeSignal(),
    })
    expect(r.status).toBe('done')
    expect(r.shouldContinue).toBe(false)
    expect(r.continuationPrompt).toBeNull()
    expect(r.message).toBe('✓ Goal achieved: shipped')
    expect(mgr.state?.turnsUsed).toBe(1)
  })

  test('continue verdict — emits continuation prompt', async () => {
    mockedJudge.mockResolvedValue({
      verdict: 'continue',
      reason: 'still working',
      parseFailed: false,
    })
    const mgr = await GoalManager.load(sid())
    await mgr.set('long')
    const r = await mgr.evaluateAfterTurn({
      lastResponse: 'progress',
      signal: fakeSignal(),
    })
    expect(r.shouldContinue).toBe(true)
    expect(r.continuationPrompt).toContain('long')
    expect(r.continuationPrompt).toContain('Continuing toward your standing goal')
    expect(r.message).toContain('Continuing toward goal (1/')
  })

  test('budget exhaustion — pauses on the turn that hits maxTurns', async () => {
    mockedJudge.mockResolvedValue({
      verdict: 'continue',
      reason: 'never done',
      parseFailed: false,
    })
    const mgr = await GoalManager.load(sid())
    await mgr.set('endless', { maxTurns: 2 })
    const r1 = await mgr.evaluateAfterTurn({
      lastResponse: 'turn1',
      signal: fakeSignal(),
    })
    expect(r1.shouldContinue).toBe(true)
    const r2 = await mgr.evaluateAfterTurn({
      lastResponse: 'turn2',
      signal: fakeSignal(),
    })
    expect(r2.shouldContinue).toBe(false)
    expect(r2.status).toBe('paused')
    expect(r2.message).toContain('2/2 turns used')
  })

  test('3 consecutive parse failures — judge-broken pause', async () => {
    mockedJudge.mockResolvedValue({
      verdict: 'continue',
      reason: 'unparseable',
      parseFailed: true,
    })
    const mgr = await GoalManager.load(sid())
    await mgr.set('x', { maxTurns: 99 })
    await mgr.evaluateAfterTurn({ lastResponse: 'a', signal: fakeSignal() })
    await mgr.evaluateAfterTurn({ lastResponse: 'b', signal: fakeSignal() })
    const r = await mgr.evaluateAfterTurn({
      lastResponse: 'c',
      signal: fakeSignal(),
    })
    expect(r.status).toBe('paused')
    expect(r.shouldContinue).toBe(false)
    expect(r.message).toContain('judge model')
    expect(r.message).toContain('midModel')
  })

  test('parseFailed counter resets after a usable judge reply', async () => {
    const mgr = await GoalManager.load(sid())
    await mgr.set('x', { maxTurns: 99 })
    mockedJudge.mockResolvedValueOnce({
      verdict: 'continue',
      reason: 'unparseable',
      parseFailed: true,
    })
    await mgr.evaluateAfterTurn({ lastResponse: 'a', signal: fakeSignal() })
    expect(mgr.state?.consecutiveParseFailures).toBe(1)

    mockedJudge.mockResolvedValueOnce({
      verdict: 'continue',
      reason: 'fine',
      parseFailed: false,
    })
    await mgr.evaluateAfterTurn({ lastResponse: 'b', signal: fakeSignal() })
    expect(mgr.state?.consecutiveParseFailures).toBe(0)
  })

  test('subgoals get forwarded to judge', async () => {
    mockedJudge.mockResolvedValue({
      verdict: 'continue',
      reason: 'k',
      parseFailed: false,
    })
    const mgr = await GoalManager.load(sid())
    await mgr.set('parent')
    await mgr.addSubgoal('first')
    await mgr.addSubgoal('second')
    await mgr.evaluateAfterTurn({
      lastResponse: 'work',
      signal: fakeSignal(),
    })
    const args = mockedJudge.mock.calls[0]![0]
    expect(args.subgoals).toEqual(['first', 'second'])
  })

  test('continuation prompt switches to with-subgoals template when subgoals exist', async () => {
    mockedJudge.mockResolvedValue({
      verdict: 'continue',
      reason: 'k',
      parseFailed: false,
    })
    const mgr = await GoalManager.load(sid())
    await mgr.set('parent')
    await mgr.addSubgoal('alpha')
    const r = await mgr.evaluateAfterTurn({
      lastResponse: 'x',
      signal: fakeSignal(),
    })
    expect(r.continuationPrompt).toContain('Additional criteria')
    expect(r.continuationPrompt).toContain('- 1. alpha')
  })
})

describe('persistence — every mutation reflected on next load', () => {
  test('evaluateAfterTurn done → reload reflects done', async () => {
    mockedJudge.mockResolvedValue({
      verdict: 'done',
      reason: 'ok',
      parseFailed: false,
    })
    const a = await GoalManager.load(sid())
    await a.set('g')
    await a.evaluateAfterTurn({ lastResponse: 'r', signal: fakeSignal() })

    const b = await GoalManager.load(sid())
    // status='done' is not "active" but is hasGoal()-true (paused/active only).
    // Loaded state will be null because we treat the persisted record as live;
    // but evaluateAfterTurn for done writes status='done' which is loadGoalState
    // returns. Verify by reading state directly.
    expect(b.state?.status).toBe('done')
  })
})
