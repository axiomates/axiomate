/**
 * Persistence layer for {@link GoalState}, mirroring the
 * `load_goal` / `save_goal` / `clear_goal` helpers from
 * hermes-agent/hermes_cli/goals.py:239-280.
 *
 * Goal state is stored as append-only `goal-state` entries in the session
 * JSONL transcript. Latest-by-timestamp wins. Status `'cleared'` is the
 * tombstone — `loadGoalState` returns `null` for it.
 *
 * No in-memory cache lives here; callers (typically {@link GoalManager})
 * own the live state object and persist mutations through this module.
 */

import type { UUID } from 'crypto'
import {
  getTranscriptPathForSession,
  loadTranscriptFile,
  recordGoalState,
} from '../sessionStorage.js'
import type { GoalStateEntry } from '../../types/logs.js'
import { createSignal } from '../signal.js'
import { entryToState, type GoalState } from './goalState.js'

/**
 * In-process cache + change signal for active goal state. The JSONL store
 * is the source of truth, but UI components (statusline, footer)
 * subscribe here for responsive re-renders without re-reading the
 * transcript on every keystroke.
 *
 * - `recordedGoalStates` mirrors what's persisted, keyed by sessionId.
 * - `goalChanged.emit(sessionId)` fires after every save / clear so
 *   `useSyncExternalStore` consumers can rerun their snapshot getter.
 *
 * Misses (no entry in the cache) fall through to a real
 * `loadTranscriptFile` scan. The cache is populated lazily on first
 * load, so /resume sessions pick up their persisted goal automatically.
 */
const recordedGoalStates = new Map<UUID, GoalState | null>()
export const goalChanged = createSignal<[UUID]>()

/**
 * Persist a fresh snapshot of `state` for `sessionId`. Append-only; never
 * mutates earlier entries.
 */
export async function saveGoalState(
  sessionId: UUID,
  state: GoalState,
): Promise<void> {
  recordGoalState(sessionId, {
    goal: state.goal,
    status: state.status,
    turnsUsed: state.turnsUsed,
    maxTurns: state.maxTurns,
    createdAt: state.createdAt,
    lastTurnAt: state.lastTurnAt,
    lastVerdict: state.lastVerdict,
    lastReason: state.lastReason,
    pausedReason: state.pausedReason,
    consecutiveParseFailures: state.consecutiveParseFailures,
    subgoals: state.subgoals,
  })
  // Refresh cache with the in-memory snapshot — no need to re-read jsonl.
  // We clone to keep the cache immune to caller mutations.
  recordedGoalStates.set(sessionId, { ...state, subgoals: [...state.subgoals] })
  goalChanged.emit(sessionId)
}

/**
 * Load the latest goal state for `sessionId`, or `null` when none exists
 * or the most recent entry is the `'cleared'` tombstone.
 *
 * Walks the session JSONL via {@link loadTranscriptFile} and pulls the
 * `goalStates` map (sessionId → latest entry). No filesystem locking
 * needed — JSONL is append-only and the picker only reads.
 */
export async function loadGoalState(sessionId: UUID): Promise<GoalState | null> {
  if (recordedGoalStates.has(sessionId)) {
    return recordedGoalStates.get(sessionId) ?? null
  }
  const filePath = getTranscriptPathForSession(sessionId)
  const { goalStates } = await loadTranscriptFile(filePath)
  const entry = goalStates.get(sessionId)
  const state =
    !entry || entry.status === 'cleared' ? null : entryToState(entry)
  recordedGoalStates.set(sessionId, state)
  return state
}

/**
 * Mark the current goal cleared. Writes a tombstone entry (status='cleared',
 * goal='') so subsequent `loadGoalState` returns null. Mirrors
 * `clear_goal` (goals.py:273-279) — the audit trail is preserved by the
 * append-only design rather than rewriting earlier rows.
 *
 * No-op when there is no existing state to clear.
 */
export async function clearGoalState(sessionId: UUID): Promise<void> {
  const existing = await loadGoalState(sessionId)
  if (!existing) return
  recordGoalState(sessionId, {
    goal: '',
    status: 'cleared',
    turnsUsed: existing.turnsUsed,
    maxTurns: existing.maxTurns,
    createdAt: existing.createdAt,
    lastTurnAt: existing.lastTurnAt,
    lastVerdict: existing.lastVerdict,
    lastReason: existing.lastReason,
    pausedReason: existing.pausedReason,
    consecutiveParseFailures: existing.consecutiveParseFailures,
    subgoals: existing.subgoals,
  })
  recordedGoalStates.set(sessionId, null)
  goalChanged.emit(sessionId)
}

/**
 * Synchronous snapshot getter for {@link useSyncExternalStore} consumers.
 * Returns the cached state, or `null` when no goal has ever been loaded
 * for `sessionId` in this process (the async {@link loadGoalState} will
 * populate the cache on first call).
 */
export function getGoalStateSnapshot(sessionId: UUID): GoalState | null {
  return recordedGoalStates.get(sessionId) ?? null
}

/**
 * Test helper — load the raw {@link GoalStateEntry} (including JSONL
 * wrapper). Used by integration tests verifying the persisted shape.
 */
export async function loadGoalStateEntry(
  sessionId: UUID,
): Promise<GoalStateEntry | undefined> {
  const filePath = getTranscriptPathForSession(sessionId)
  const { goalStates } = await loadTranscriptFile(filePath)
  return goalStates.get(sessionId)
}
