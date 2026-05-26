/**
 * `/goal` slash command — persistent cross-turn goal (Ralph loop).
 *
 * Subcommands (matches hermes-agent/hermes_cli/goals.py + cli.py
 * `_handle_goal_command` L9199-9263 1:1):
 *   `/goal` / `/goal status`     → show current state
 *   `/goal <text>`               → set a new standing goal (replaces prior)
 *   `/goal pause`                → pause without clearing
 *   `/goal resume`               → resume + reset turn budget
 *   `/goal clear` / `stop` / `done` → clear (three aliases, hermes parity)
 *
 * Setting a goal also enqueues the goal text as the first user turn so
 * the loop kicks off without requiring the user to send another message
 * (mirrors `self._pending_input.put(state.goal)` cli.py:9261).
 */

import React from 'react'
import chalk from 'chalk'
import { getSessionId } from '../../bootstrap/state.js'
import type { UUID } from 'crypto'
import { enqueue } from '../../utils/messageQueueManager.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { GoalManager } from '../../utils/goal/goalManager.js'
import { getAuxiliaryModel } from '../../utils/model/model.js'

type Sub = 'status' | 'pause' | 'resume' | 'clear'

function parseSub(arg: string): Sub | null {
  const lower = arg.toLowerCase()
  if (lower === '' || lower === 'status') return 'status'
  if (lower === 'pause') return 'pause'
  if (lower === 'resume') return 'resume'
  if (lower === 'clear' || lower === 'stop' || lower === 'done') return 'clear'
  return null
}

/**
 * Return a one-line yellow warning when the judge would fall back to the
 * main model AND the user hasn't seen the warning yet. After the first
 * show we flip `goalJudgeCostWarned` so we never annoy the same user
 * twice for the same configuration omission.
 */
function judgeRoutingWarning(): string {
  const aux = getAuxiliaryModel('goalJudge')
  if (aux.tier !== 'main') return ''
  if (getGlobalConfig().goalJudgeCostWarned) return ''
  saveGlobalConfig(current => ({ ...current, goalJudgeCostWarned: true }))
  return (
    '\n' +
    chalk.yellow(
      `⚠ Goal judge will use the main model (${aux.model}). Set fastModel ` +
        'or midModel in ~/.axiomate.json to a cheaper model to lower per-turn cost. ' +
        '(This warning is shown once.)',
    )
  )
}

export async function call(
  onDone: (result?: string) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode | null> {
  const sessionId = getSessionId() as UUID
  const mgr = await GoalManager.load(sessionId, {
    defaultMaxTurns: getGlobalConfig().goalsMaxTurns,
  })
  const arg = (args ?? '').trim()
  const sub = parseSub(arg)

  // Bare /goal or /goal status (also unknown subverb → treat the WHOLE
  // arg as goal text, hermes-style; the only way to hit "unknown" here
  // is when sub === null AND arg is multi-word).
  if (sub === 'status') {
    onDone(mgr.statusLine())
    return null
  }

  if (sub === 'pause') {
    const state = await mgr.pause('user-paused')
    onDone(state ? `⏸ Goal paused: ${state.goal}` : 'No goal set.')
    return null
  }

  if (sub === 'resume') {
    const state = await mgr.resume()
    if (!state) {
      onDone('No goal to resume.')
      return null
    }
    onDone(
      `▶ Goal resumed: ${state.goal}\n` +
        'Send any message (or type "continue") to kick off the next turn.',
    )
    return null
  }

  if (sub === 'clear') {
    const had = mgr.hasGoal()
    await mgr.clear()
    onDone(had ? '✓ Goal cleared.' : 'No active goal.')
    return null
  }

  // Otherwise: treat the whole arg as goal text.
  try {
    const state = await mgr.set(arg)
    const warning = judgeRoutingWarning()
    const budgetLabel =
      state.maxTurns > 0 ? `${state.maxTurns}-turn budget` : 'unlimited budget'
    onDone(
      `⊙ Goal set (${budgetLabel}): ${state.goal}\n` +
        'After each turn a judge model checks if the goal is done. ' +
        'Use /goal status, /goal pause, /goal resume, /goal clear.' +
        warning,
    )
    // Kick first turn (hermes cli.py:9261 — self._pending_input.put).
    enqueue({ value: state.goal, mode: 'prompt', priority: 'next' })
  } catch (e) {
    onDone(`Invalid goal: ${(e as Error).message}`)
  }
  return null
}

// Exposed for tests so the parser stays the single source of truth.
export const _internal = { parseSub }
