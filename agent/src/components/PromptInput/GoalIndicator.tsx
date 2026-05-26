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
 *
 * Implementation note: the whole pill is emitted as ONE <Text> node
 * with chalk-embedded color codes, matching the Notifications.tsx
 * pattern. An earlier version used three sibling <Text> elements
 * inside a <Box>; Ink's wrap/truncate boundary on horizontal flex
 * layout occasionally rendered ghost remnants of the previous frame
 * underneath the new pill on state changes, producing visible
 * "two pills" duplicates like '⏸ Goal paused1. 在…⏸ Goal paused: 1. 在…'.
 * Single-Text rendering side-steps that layout pass entirely.
 */

import * as React from 'react'
import chalk from 'chalk'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useGoalState } from '../../hooks/useGoalState.js'
import { logForDebugging } from '../../utils/debug.js'

// Process-wide counter for instance ids. If we ever see two distinct
// ids logging on the same frame, GoalIndicator is being mounted twice
// — instant root-cause signal for the "double pill" reports.
let instanceCounter = 0

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
  // Per-instance id — survives renders of the same mounted component
  // but increments when React mounts a fresh instance. Pair with the
  // render-counter ref below to distinguish "Component A re-rendered"
  // from "two Components A both rendered once".
  const instanceIdRef = React.useRef<number | null>(null)
  if (instanceIdRef.current === null) {
    instanceIdRef.current = ++instanceCounter
  }
  const renderCountRef = React.useRef(0)
  renderCountRef.current++

  // Log mount / unmount separately from per-render trace. If we ever
  // see two mounts without an unmount between, two GoalIndicator
  // instances are alive at once and the double-pill is real React
  // tree state. If only ever one mount, the visual duplicate is an
  // Ink renderer-level ghost (previous frame not cleared).
  React.useEffect(() => {
    logForDebugging(
      `[GOAL-PILL] instance#${instanceIdRef.current} MOUNT`,
      { level: 'info' },
    )
    return () => {
      logForDebugging(
        `[GOAL-PILL] instance#${instanceIdRef.current} UNMOUNT`,
        { level: 'info' },
      )
    }
  }, [])

  const goal = useGoalState()
  const { columns } = useTerminalSize()

  // Log every render so we can grep [GOAL-PILL] in debug log when the
  // double-pill bug recurs. Two distinct instance#N values in the
  // same wall-clock millisecond → genuine double mount.
  logForDebugging(
    `[GOAL-PILL] instance#${instanceIdRef.current} render#${renderCountRef.current} ` +
      `status=${goal?.status ?? 'null'} turns=${goal?.turnsUsed ?? '-'}/${goal?.maxTurns ?? '-'} ` +
      `cols=${columns} loading=${!!isLoading}`,
    { level: 'info' },
  )

  if (!goal) return null
  if (goal.status !== 'active' && goal.status !== 'paused') return null

  const glyph = goal.status === 'active' ? '⊙' : '⏸'
  // axiomate theme colors aren't accessible to chalk; use the closest
  // raw ANSI colors (cyan ≈ success accent, yellow ≈ warning).
  const colorize = goal.status === 'active' ? chalk.cyan : chalk.yellow
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

  const head = `${label}: `
  const suffix = working ? ' (working)' : ''
  const headWidth = stringWidth(head)
  const suffixWidth = stringWidth(suffix)
  // Reserve columns for the Notifications panel on the footer's right
  // side (token counts, IDE status, debug hint, etc.). Without this
  // the goal pill grabs the whole row and Notifications gets pushed
  // off-screen. 30 cols handles "16804 tokens · Debug mode" with room.
  // Tighter cap on narrow terminals so the pill still shows something.
  const RIGHT_RESERVE = columns >= 100 ? 30 : 16
  const textCols = Math.max(8, columns - headWidth - suffixWidth - RIGHT_RESERVE)
  const text = truncateByColumns(goal.goal, textCols)

  // Build the full visible string in one go so Ink emits exactly one
  // text node. Colored prefix + dim body + dim suffix all baked in via
  // chalk; dimColor handled by chalk.dim instead of <Text dimColor>.
  const line = colorize(head) + chalk.dim(text) + chalk.dim(suffix)

  // Wrap in <Box flexShrink={0} overflowX="hidden"> for the same
  // reason Notifications.tsx does it (L125-130): without an explicit
  // box slot, Ink's frame diff doesn't know the column range owned by
  // this component and leaves stale glyphs in cells the new render
  // didn't touch. Symptom was the "double pause" — when the pill
  // shrinks (active → paused drops ' (working)'), the previous-frame
  // tail wasn't cleared. Boxed slot = Ink owns the whole strip and
  // repaints it as a unit.
  return (
    <Box flexShrink={0} overflowX="hidden">
      <Text wrap="truncate">{line}</Text>
    </Box>
  )
}
