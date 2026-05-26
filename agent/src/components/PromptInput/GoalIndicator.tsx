/**
 * Footer pill that surfaces the active /goal status. Renders a single
 * line so the goal stays visible even while the agent is running:
 *
 *   ⊙ Goal 3/20: write fib                  (active)
 *   ⏸ Goal paused: refactor auth            (paused — judge / Ctrl+C)
 *
 * Hidden when the session has no goal or the goal is `done` / `cleared`.
 * Subscribes to {@link useGoalState} so changes from `/goal`,
 * `/subgoal`, or the stop hook re-render immediately.
 */

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useGoalState } from '../../hooks/useGoalState.js'

const MAX_GOAL_TEXT = 60

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

export function GoalIndicator(): React.ReactNode {
  const goal = useGoalState()
  if (!goal) return null
  if (goal.status !== 'active' && goal.status !== 'paused') return null

  const glyph = goal.status === 'active' ? '⊙' : '⏸'
  const color = goal.status === 'active' ? 'success' : 'warning'
  // maxTurns === 0 means "no budget" — show /∞ so the user knows
  // the loop won't auto-stop on turn count alone.
  const budget =
    goal.maxTurns > 0
      ? `${goal.turnsUsed}/${goal.maxTurns}`
      : `${goal.turnsUsed}/∞`
  const label =
    goal.status === 'active'
      ? `${glyph} Goal ${budget}`
      : `${glyph} Goal paused`

  return (
    <Box gap={1}>
      <Text color={color}>{label}:</Text>
      <Text dimColor>{truncate(goal.goal, MAX_GOAL_TEXT)}</Text>
    </Box>
  )
}
