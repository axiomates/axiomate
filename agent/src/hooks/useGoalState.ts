/**
 * React hook surface for the active /goal state. Subscribes via
 * `useSyncExternalStore` to the in-process cache + signal pair in
 * `utils/goal/goalStore.ts`, then triggers a one-shot async load on
 * mount so /resume sessions populate the snapshot.
 *
 * Returns the cached {@link GoalState} (or `null` when no goal is set).
 * Consumers (statusline, footer) re-render automatically when the
 * persisted snapshot changes via `goalChanged.emit(sessionId)`.
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { UUID } from 'crypto'
import { getSessionId } from '../bootstrap/state.js'
import type { GoalState } from '../utils/goal/goalState.js'
import {
  getGoalStateSnapshot,
  goalChanged,
  loadGoalState,
} from '../utils/goal/goalStore.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'

export function useGoalState(): GoalState | null {
  const sessionId = getSessionId() as UUID

  // Sync subscribe — fires whenever any goalChanged signal lands. Filter
  // inside `getSnapshot` so cross-session emits are no-ops here.
  const state = useSyncExternalStore(
    listener => goalChanged.subscribe(listener),
    () => getGoalStateSnapshot(sessionId),
    () => getGoalStateSnapshot(sessionId),
  )

  // One-shot async hydration. Subsequent loads are served from the
  // module-level cache; the persistent listener handles updates.
  useEffect(() => {
    void loadGoalState(sessionId).catch(err => {
      logForDebugging(`useGoalState: load failed: ${errorMessage(err)}`, {
        level: 'warn',
      })
    })
  }, [sessionId])

  return state
}
