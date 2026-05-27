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
import type { LocalJSXCommandOnDone } from '../../types/command.js'

type Sub = 'status' | 'pause' | 'resume' | 'clear'

function parseSub(arg: string): Sub | null {
  const lower = arg.toLowerCase()
  if (lower === '' || lower === 'status' || lower === 'list' || lower === 'ls') return 'status'
  if (lower === 'pause') return 'pause'
  if (lower === 'resume') return 'resume'
  if (lower === 'clear' || lower === 'stop' || lower === 'done') return 'clear'
  return null
}

function doneSystem(onDone: LocalJSXCommandOnDone, result: string): void {
  onDone(result, { display: 'system' })
}

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
  onDone: LocalJSXCommandOnDone,
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
    // Show status line + subgoals list. statusLine reports "N subgoals"
    // count but not the items themselves; users naturally hit /goal
    // expecting full state, then have to /subgoal to see what those
    // criteria actually are. Merging here matches what /subgoal show
    // already does (mgr.renderSubgoals output).
    const hasSubgoals = (mgr.state?.subgoals?.length ?? 0) > 0
    doneSystem(
      onDone,
      hasSubgoals
        ? `${mgr.statusLine()}\n${mgr.renderSubgoals()}`
        : mgr.statusLine(),
    )
    return null
  }

  if (sub === 'pause') {
    const state = await mgr.pause('user-paused')
    if (state) {
      doneSystem(onDone, `⏸ Goal paused: ${state.goal}`)
    } else {
      doneSystem(onDone, 'No goal set.')
    }
    return null
  }

  if (sub === 'resume') {
    const state = await mgr.resume()
    if (!state) {
      doneSystem(onDone, 'No goal to resume.')
      return null
    }
    // Unlike pause/set, resume needs an explicit notification: hermes
    // resume semantics don't auto-kick the next turn — the user has
    // to type any message (e.g. 'continue') to trigger evaluation.
    // Without the prompt the pill flips to ⊙ active but the loop
    // sits silent and confused users wait. The pill carries the
    // status; the notification carries the "you need to send
    // something" call-to-action that the pill alone can't.
    doneSystem(
      onDone,
      'Send any message (or type "continue") to resume the goal loop.',
    )
    return null
  }

  if (sub === 'clear') {
    const had = mgr.hasGoal()
    await mgr.clear()
    doneSystem(onDone, had ? '✓ Goal cleared.' : 'No active goal.')
    return null
  }

  // Otherwise: treat the whole arg as goal text.
  try {
    const state = await mgr.set(arg)
    const warning = judgeRoutingWarning()
    const budgetLabel =
      state.maxTurns > 0 ? `${state.maxTurns}-turn budget` : 'unlimited budget'
    doneSystem(
      onDone,
      `⊙ Goal set (${budgetLabel}): ${state.goal}\n` +
        'After each turn a judge model checks if the goal is done. ' +
        'Use /goal status, /goal pause, /goal resume, /goal clear.' +
        warning,
    )
    // Kick first turn (hermes cli.py:9261 — self._pending_input.put).
    enqueue({ value: state.goal, mode: 'prompt', priority: 'next' })
  } catch (e) {
    doneSystem(onDone, `Invalid goal: ${(e as Error).message}`)
  }
  return null
}

// Exposed for tests so the parser stays the single source of truth.
export const _internal = { parseSub }
