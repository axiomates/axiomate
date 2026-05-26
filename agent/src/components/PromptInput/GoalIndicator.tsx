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
import { stringWidth } from '../../ink/stringWidth.js'
import { useGoalState } from '../../hooks/useGoalState.js'

// Footer pill shares a row with mode indicators / shortcut hints; long
// goal text squeezes them off-screen on narrow terminals. Bound the
// truncation by terminal column width (each CJK char = 2 columns) not
// JS-string length, so 中文 doesn't blow past 21 chars × 2 cols = 42
// columns visually even if length() looks 21.
const MAX_GOAL_COLUMNS = 24

function truncateByColumns(s: string, maxCols: number): string {
  if (stringWidth(s) <= maxCols) return s
  // Walk char by char to avoid splitting CJK glyphs in half.
  let acc = ''
  let cols = 0
  for (const ch of s) {
    const w = stringWidth(ch)
    if (cols + w > maxCols - 1) break // leave 1 col for ellipsis
    acc += ch
    cols += w
  }
  return acc + '…'
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
      <Text dimColor>{truncateByColumns(goal.goal, MAX_GOAL_COLUMNS)}</Text>
    </Box>
  )
}
