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
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useGoalState } from '../../hooks/useGoalState.js'

function truncateByColumns(s: string, maxCols: number): string {
  if (stringWidth(s) <= maxCols) return s
  let acc = ''
  let cols = 0
  for (const ch of s) {
    const w = stringWidth(ch)
    if (cols + w > maxCols - 1) break
    acc += ch
    cols += w
  }
  return acc + '…'
}

type Props = {
  /** True when a query is in-flight — adds a "(working)" marker so the
   * user can tell the turn count hasn't ticked because the AI is still
   * cranking, not because nothing is happening. */
  isLoading?: boolean
}

export function GoalIndicator({ isLoading }: Props): React.ReactNode {
  const goal = useGoalState()
  const { columns } = useTerminalSize()
  if (!goal) return null
  if (goal.status !== 'active' && goal.status !== 'paused') return null

  const glyph = goal.status === 'active' ? '⊙' : '⏸'
  const color = goal.status === 'active' ? 'success' : 'warning'
  // maxTurns === 0 → "no budget" — show /∞ so the user knows the loop
  // won't auto-stop on turn count alone.
  const budget =
    goal.maxTurns > 0
      ? `${goal.turnsUsed}/${goal.maxTurns}`
      : `${goal.turnsUsed}/∞`
  const label =
    goal.status === 'active'
      ? `${glyph} Goal ${budget}`
      : `${glyph} Goal paused`

  // turnsUsed only ticks at evaluateAfterTurn (turn end); while a long
  // turn runs the count sits e.g. 0/20 for minutes. Marker tells the
  // user the wait is real work, not a hung loop.
  const working = isLoading && goal.status === 'active'

  // Cap goal-text width to leave room for label/(working) on a single
  // line. Now that GoalIndicator owns its row (not sharing with mode
  // hint), the cap can be generous — full terminal width minus the
  // fixed prefix/suffix is the bound.
  const fixedCols = stringWidth(label) + 2 /*": "*/ + (working ? 11 /*" (working)"*/ : 0) + 4 /*safety*/
  const textCols = Math.max(20, columns - fixedCols)
  const text = truncateByColumns(goal.goal, textCols)

  // Render as ONE Box with explicit space separators inside <Text>
  // rather than relying on Box gap — Ink's gap propagation across
  // wrap boundaries can drop the space, producing 'paused1.' for
  // long goal text (reported by user 2026-05-26).
  return (
    <Box>
      <Text color={color}>{label}: </Text>
      <Text dimColor>{text}</Text>
      {working && <Text dimColor> (working)</Text>}
    </Box>
  )
}
