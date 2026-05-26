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
  // maxTurns === 0 means "no budget" — show /∞ so the user knows
  // the loop won't auto-stop on turn count alone.
  const budget =
    goal.maxTurns > 0
      ? `${goal.turnsUsed}/${goal.maxTurns}`
      : `${goal.turnsUsed}/∞`

  // Three-tier degradation — the footer shares its row with permission
  // mode hint, shortcut display, PR status, etc. ModeIndicator alone is
  // ~50 cols ('⏵⏵ bypass permissions on (shift+tab to cycle) · esc to
  // interrupt'); blindly appending the goal pill mangled both at <100
  // cols. Strategy: drop goal text first, then drop budget, then bail
  // entirely.
  let label: string
  let textWidth: number
  if (columns >= 100) {
    label =
      goal.status === 'active'
        ? `${glyph} Goal ${budget}`
        : `${glyph} Goal paused`
    textWidth = 24
  } else if (columns >= 70) {
    label =
      goal.status === 'active' ? `${glyph} ${budget}` : `${glyph} paused`
    textWidth = 12
  } else {
    // Tight terminal — just the glyph + budget, no text at all.
    label =
      goal.status === 'active' ? `${glyph}${budget}` : `${glyph}`
    textWidth = 0
  }

  const working = isLoading && goal.status === 'active'

  return (
    <Box gap={1}>
      <Text color={color}>
        {label}
        {textWidth > 0 ? ':' : ''}
      </Text>
      {textWidth > 0 && (
        <Text dimColor>{truncateByColumns(goal.goal, textWidth)}</Text>
      )}
      {working && <Text dimColor>(working)</Text>}
    </Box>
  )
}
