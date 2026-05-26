import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  const actual = await importOriginal<typeof import('../../../../utils/envUtils.js')>()
  return { ...actual, getConfigHomeDir: () => state.tempDir }
})

vi.mock('../../../../bootstrap/state.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../bootstrap/state.js')>()
  return {
    ...actual,
    getOriginalCwd: () => state.cwd,
    getSessionId: () => state.sessionId,
  }
})

import type { UUID } from 'crypto'
import {
  clearGoalState,
  loadGoalState,
  loadGoalStateEntry,
  saveGoalState,
} from '../../../../utils/goal/goalStore.js'
import { createInitialGoalState } from '../../../../utils/goal/goalState.js'

beforeEach(async () => {
  state.counter++
  state.tempDir = await mkdtemp(join(tmpdir(), 'axiomate-goal-store-'))
  state.cwd = `/tmp/axiomate-goal-cwd-${state.counter}`
  state.sessionId = `00000000-0000-4000-8000-${String(state.counter).padStart(12, '0')}`
  // pre-create the project dir so appendEntryToFile doesn't ENOENT
  const projectDir = join(state.tempDir, 'projects', sanitizePath(state.cwd))
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  if (state.tempDir) {
    await rm(state.tempDir, { recursive: true, force: true })
  }
})

function sid(): UUID {
  return state.sessionId as UUID
}

async function readJsonl(): Promise<unknown[]> {
  const projectDir = join(state.tempDir, 'projects', sanitizePath(state.cwd))
  const path = join(projectDir, `${state.sessionId}.jsonl`)
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

describe('saveGoalState + loadGoalState round-trip', () => {
  test('save then load returns the same fields', async () => {
    const initial = createInitialGoalState('write fib', 10)
    initial.turnsUsed = 2
    initial.lastVerdict = 'continue'
    initial.lastReason = 'still typing'

    await saveGoalState(sid(), initial)
    const loaded = await loadGoalState(sid())

    expect(loaded).not.toBeNull()
    expect(loaded!.goal).toBe('write fib')
    expect(loaded!.maxTurns).toBe(10)
    expect(loaded!.turnsUsed).toBe(2)
    expect(loaded!.lastVerdict).toBe('continue')
    expect(loaded!.lastReason).toBe('still typing')
    expect(loaded!.status).toBe('active')
  })

  test('load on empty session returns null', async () => {
    expect(await loadGoalState(sid())).toBeNull()
  })

  test('multiple saves — latest by timestamp wins', async () => {
    const a = createInitialGoalState('first', 20)
    a.turnsUsed = 1
    await saveGoalState(sid(), a)
    // Ensure timestamp ordering — JSONL records ISO timestamps at second
    // precision in worst-case clocks; wait a tick.
    await new Promise(r => setTimeout(r, 5))
    const b = createInitialGoalState('second', 20)
    b.turnsUsed = 7
    await saveGoalState(sid(), b)

    const loaded = await loadGoalState(sid())
    expect(loaded!.goal).toBe('second')
    expect(loaded!.turnsUsed).toBe(7)
  })

  test('writes append — both entries are visible in raw jsonl', async () => {
    await saveGoalState(sid(), createInitialGoalState('a'))
    await new Promise(r => setTimeout(r, 5))
    await saveGoalState(sid(), createInitialGoalState('b'))
    const lines = await readJsonl()
    const goalLines = lines.filter(
      (l: any) => l.type === 'goal-state',
    )
    expect(goalLines).toHaveLength(2)
  })
})

describe('clearGoalState', () => {
  test('no-op when nothing saved', async () => {
    await clearGoalState(sid())
    const lines = await readJsonl()
    expect(lines).toHaveLength(0)
  })

  test('writes tombstone — loadGoalState returns null afterward', async () => {
    await saveGoalState(sid(), createInitialGoalState('to be cleared'))
    await new Promise(r => setTimeout(r, 5))
    await clearGoalState(sid())

    expect(await loadGoalState(sid())).toBeNull()
    const entry = await loadGoalStateEntry(sid())
    expect(entry?.status).toBe('cleared')
    expect(entry?.goal).toBe('')
  })

  test('tombstone preserves prior maxTurns / createdAt for audit', async () => {
    const original = createInitialGoalState('preserved fields', 50)
    await saveGoalState(sid(), original)
    await new Promise(r => setTimeout(r, 5))
    await clearGoalState(sid())

    const entry = await loadGoalStateEntry(sid())
    expect(entry?.maxTurns).toBe(50)
    expect(entry?.createdAt).toBe(original.createdAt)
  })
})

describe('isolation across sessions', () => {
  test('loading sessionA does not return sessionB goal', async () => {
    const sidA = sid()
    await saveGoalState(sidA, createInitialGoalState('A goal'))

    // Now switch sessionId; project dir is shared so file goes to same
    // dir but different filename → different transcript.
    const previousSid = state.sessionId
    state.sessionId = '99999999-9999-4999-8999-999999999999'
    const sidB = sid()
    await saveGoalState(sidB, createInitialGoalState('B goal'))

    const loadedB = await loadGoalState(sidB)
    expect(loadedB?.goal).toBe('B goal')

    state.sessionId = previousSid
    const loadedA = await loadGoalState(sidA)
    expect(loadedA?.goal).toBe('A goal')
  })
})
