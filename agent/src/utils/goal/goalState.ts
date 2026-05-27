/**
 * GoalState — pure-function helpers for the persistent /goal Ralph-loop.
 *
 * Ported from hermes-agent/hermes_cli/goals.py:142-194 + L505-518.
 *
 * Mirrors the Python `GoalState` dataclass field-for-field so the JSONL
 * persistence layer ({@link GoalStateEntry} in `types/logs.ts`) is a
 * straightforward extension. No I/O, no React — every helper here is
 * deterministic and trivially testable.
 */

import type { GoalStateEntry } from '../../types/logs.js'

export const DEFAULT_MAX_TURNS = 20

export type GoalStatus = 'active' | 'paused' | 'done' | 'cleared'
export type GoalVerdict = 'done' | 'continue' | 'skipped'

/**
 * In-memory shape — same fields as {@link GoalStateEntry} minus the
 * JSONL wrapper (`type` / `uuid` / `sessionId` / `timestamp`).
 */
export type GoalState = {
  goal: string
  status: GoalStatus
  turnsUsed: number
  maxTurns: number
  createdAt: number
  lastTurnAt: number
  lastVerdict?: GoalVerdict
  lastReason?: string
  pausedReason?: string
  consecutiveParseFailures: number
  subgoals: string[]
}

export function createInitialGoalState(
  goal: string,
  maxTurns: number = DEFAULT_MAX_TURNS,
): GoalState {
  return {
    goal,
    status: 'active',
    turnsUsed: 0,
    maxTurns,
    createdAt: Date.now(),
    lastTurnAt: 0,
    consecutiveParseFailures: 0,
    subgoals: [],
  }
}

/**
 * Strip jsonl wrapper fields off a {@link GoalStateEntry} to produce a
 * runtime {@link GoalState}. Defensive against partial entries from old
 * sessions — coerces every numeric field, rejects bad statuses, drops
 * empty/non-string subgoals.
 */
export function entryToState(entry: GoalStateEntry): GoalState {
  const status: GoalStatus = (
    ['active', 'paused', 'done', 'cleared'] as const
  ).includes(entry.status as GoalStatus)
    ? (entry.status as GoalStatus)
    : 'cleared'

  const subgoals = Array.isArray(entry.subgoals)
    ? entry.subgoals
        .map(s => (typeof s === 'string' ? s.trim() : ''))
        .filter(s => s.length > 0)
    : []

  return {
    goal: entry.goal ?? '',
    status,
    turnsUsed: Number.isFinite(entry.turnsUsed) ? Number(entry.turnsUsed) : 0,
    maxTurns: Number.isFinite(entry.maxTurns)
      ? Number(entry.maxTurns)
      : DEFAULT_MAX_TURNS,
    createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : 0,
    lastTurnAt: Number.isFinite(entry.lastTurnAt)
      ? Number(entry.lastTurnAt)
      : 0,
    lastVerdict: entry.lastVerdict,
    lastReason: entry.lastReason,
    pausedReason: entry.pausedReason,
    consecutiveParseFailures: Number.isFinite(entry.consecutiveParseFailures)
      ? Number(entry.consecutiveParseFailures)
      : 0,
    subgoals,
  }
}

/**
 * Render the subgoals as a numbered ``[N] text`` block. Empty
 * when there are no subgoals.
 *
 * Format note: we deliberately use square-brackets `[N]` not
 * markdown's `- N.` because the axiomate transcript renderer parses
 * `- N.` as an ordered list and re-numbers nested levels with
 * letters / Roman numerals (utils/markdown.ts:357 getListNumber). A
 * single subgoal block ends up as 'a. text' on screen, breaking the
 * symmetry with `/subgoal remove <n>` which expects digits. Square
 * brackets sidestep markdown's list parser entirely so the visible
 * number always matches the index passed to remove.
 */
export function renderSubgoalsBlock(state: Pick<GoalState, 'subgoals'>): string {
  if (state.subgoals.length === 0) return ''
  return state.subgoals.map((text, i) => `[${i + 1}] ${text}`).join('\n')
}

/**
 * Public render helper for the `/subgoal` command's bare-args path.
 * Matches the cli.py:9295 fallback ("(no subgoals — use /subgoal <text>...)").
 */
export function renderSubgoals(state: GoalState | null): string {
  if (state === null) return '(no active goal)'
  if (state.subgoals.length === 0) {
    return '(no subgoals — use /subgoal <text> to add criteria)'
  }
  return renderSubgoalsBlock(state)
}

/**
 * One-line status string for `/goal` and `/goal status`. Matches
 * goals.py:505-518 character for character — the leading glyph
 * (⊙ / ⏸ / ✓) is part of the API surface that users learn.
 */
export function statusLine(state: GoalState | null): string {
  if (state === null || state.status === 'cleared') {
    return 'No active goal. Set one with /goal <text>.'
  }
  // maxTurns === 0 → unlimited budget. Show "N/∞" so the user
  // sees the loop is genuinely unbounded.
  const turns =
    state.maxTurns > 0
      ? `${state.turnsUsed}/${state.maxTurns} turns`
      : `${state.turnsUsed}/∞ turns`
  const subCount = state.subgoals.length
  const sub = subCount > 0 ? `, ${subCount} subgoal${subCount === 1 ? '' : 's'}` : ''
  if (state.status === 'active') {
    return `⊙ Goal (active, ${turns}${sub}): ${state.goal}`
  }
  if (state.status === 'paused') {
    const extra = state.pausedReason ? ` — ${state.pausedReason}` : ''
    return `⏸ Goal (paused, ${turns}${sub}${extra}): ${state.goal}`
  }
  if (state.status === 'done') {
    return `✓ Goal done (${turns}${sub}): ${state.goal}`
  }
  return `Goal (${state.status}, ${turns}${sub}): ${state.goal}`
}
