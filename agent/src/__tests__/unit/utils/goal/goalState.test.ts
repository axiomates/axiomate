import { describe, expect, it } from 'vitest'
import type { GoalStateEntry } from '../../../../types/logs.js'
import {
  createInitialGoalState,
  DEFAULT_MAX_TURNS,
  entryToState,
  renderSubgoals,
  renderSubgoalsBlock,
  statusLine,
} from '../../../../utils/goal/goalState.js'
import type { UUID } from 'crypto'

const baseEntry = (overrides: Partial<GoalStateEntry> = {}): GoalStateEntry => ({
  type: 'goal-state',
  uuid: '00000000-0000-0000-0000-000000000001' as UUID,
  sessionId: '00000000-0000-0000-0000-000000000002' as UUID,
  timestamp: '2026-05-26T00:00:00.000Z',
  goal: 'write fib',
  status: 'active',
  turnsUsed: 3,
  maxTurns: 20,
  createdAt: 1000,
  lastTurnAt: 2000,
  consecutiveParseFailures: 0,
  subgoals: [],
  ...overrides,
})

describe('createInitialGoalState', () => {
  it('uses default max turns when none given', () => {
    const s = createInitialGoalState('do the thing')
    expect(s.goal).toBe('do the thing')
    expect(s.status).toBe('active')
    expect(s.turnsUsed).toBe(0)
    expect(s.maxTurns).toBe(DEFAULT_MAX_TURNS)
    expect(s.subgoals).toEqual([])
    expect(s.consecutiveParseFailures).toBe(0)
    expect(s.lastTurnAt).toBe(0)
    expect(s.createdAt).toBeGreaterThan(0)
  })

  it('honors explicit maxTurns', () => {
    expect(createInitialGoalState('x', 5).maxTurns).toBe(5)
  })
})

describe('entryToState', () => {
  it('strips wrapper fields and preserves all goal fields', () => {
    const s = entryToState(baseEntry({ subgoals: ['a', 'b'] }))
    expect(s).toEqual({
      goal: 'write fib',
      status: 'active',
      turnsUsed: 3,
      maxTurns: 20,
      createdAt: 1000,
      lastTurnAt: 2000,
      lastVerdict: undefined,
      lastReason: undefined,
      pausedReason: undefined,
      consecutiveParseFailures: 0,
      subgoals: ['a', 'b'],
    })
  })

  it('coerces unknown status to cleared', () => {
    const s = entryToState(baseEntry({ status: 'bogus' as 'active' }))
    expect(s.status).toBe('cleared')
  })

  it('drops empty / non-string subgoals', () => {
    const s = entryToState(
      baseEntry({ subgoals: ['real', '', '   ', 42 as unknown as string] }),
    )
    expect(s.subgoals).toEqual(['real'])
  })

  it('falls back to defaults for missing numeric fields', () => {
    const s = entryToState(
      baseEntry({
        turnsUsed: undefined as unknown as number,
        maxTurns: undefined as unknown as number,
        createdAt: NaN,
        consecutiveParseFailures: undefined as unknown as number,
      }),
    )
    expect(s.turnsUsed).toBe(0)
    expect(s.maxTurns).toBe(DEFAULT_MAX_TURNS)
    expect(s.createdAt).toBe(0)
    expect(s.consecutiveParseFailures).toBe(0)
  })

  it('preserves verdicts and reasons when present', () => {
    const s = entryToState(
      baseEntry({
        lastVerdict: 'continue',
        lastReason: 'still working',
        pausedReason: 'budget',
      }),
    )
    expect(s.lastVerdict).toBe('continue')
    expect(s.lastReason).toBe('still working')
    expect(s.pausedReason).toBe('budget')
  })
})

describe('renderSubgoalsBlock', () => {
  it('returns empty string when no subgoals', () => {
    expect(renderSubgoalsBlock({ subgoals: [] })).toBe('')
  })

  it('numbers from 1', () => {
    expect(renderSubgoalsBlock({ subgoals: ['first', 'second', 'third'] })).toBe(
      '[1] first\n[2] second\n[3] third',
    )
  })
})

describe('renderSubgoals', () => {
  it('handles null state', () => {
    expect(renderSubgoals(null)).toBe('(no active goal)')
  })

  it('points at /subgoal when empty', () => {
    expect(
      renderSubgoals(entryToState(baseEntry({ subgoals: [] }))),
    ).toContain('/subgoal <text>')
  })

  it('returns the numbered block when populated', () => {
    expect(renderSubgoals(entryToState(baseEntry({ subgoals: ['x'] })))).toBe(
      '[1] x',
    )
  })
})

describe('statusLine', () => {
  it('handles null state', () => {
    expect(statusLine(null)).toBe('No active goal. Set one with /goal <text>.')
  })

  it('handles cleared state same as null', () => {
    expect(statusLine(entryToState(baseEntry({ status: 'cleared' })))).toBe(
      'No active goal. Set one with /goal <text>.',
    )
  })

  it('renders active with turn count', () => {
    expect(statusLine(entryToState(baseEntry()))).toBe(
      '⊙ Goal (active, 3/20 turns): write fib',
    )
  })

  it('renders paused with reason and subgoals', () => {
    const s = entryToState(
      baseEntry({
        status: 'paused',
        pausedReason: 'budget exhausted',
        subgoals: ['a', 'b'],
      }),
    )
    expect(statusLine(s)).toBe(
      '⏸ Goal (paused, 3/20 turns, 2 subgoals — budget exhausted): write fib',
    )
  })

  it('renders done', () => {
    expect(statusLine(entryToState(baseEntry({ status: 'done' })))).toBe(
      '✓ Goal done (3/20 turns): write fib',
    )
  })

  it('singularizes "1 subgoal"', () => {
    expect(
      statusLine(entryToState(baseEntry({ subgoals: ['only one'] }))),
    ).toContain('1 subgoal)')
  })
})
