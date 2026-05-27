/**
 * `/subgoal` slash command — mid-loop user-added criteria for the
 * standing /goal. Ported from hermes-agent/hermes_cli/cli.py
 * `_handle_subgoal_command` L9265-9338.
 *
 * Subcommands:
 *   `/subgoal`                → show current subgoals + status line
 *   `/subgoal list`           → alias of `/subgoal` (explicit list verb)
 *   `/subgoal <text>`         → append a new criterion
 *   `/subgoal remove <n>`     → drop subgoal N (1-based)
 *   `/subgoal clear`          → wipe all subgoals
 *
 * Subgoals don't kick anything off — the running turn finishes, then
 * the next judge call factors them in via the with-subgoals template.
 */

import React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { UUID } from 'crypto'
import { getGlobalConfig } from '../../utils/config.js'
import { GoalManager } from '../../utils/goal/goalManager.js'
import { logForDebugging } from '../../utils/debug.js'

type Verb = 'show' | 'remove' | 'clear' | 'add'

function parseVerb(arg: string): { verb: Verb; rest: string } {
  if (arg === '') return { verb: 'show', rest: '' }
  const [head, ...rest] = arg.split(/\s+/)
  const lower = (head ?? '').toLowerCase()
  // `list` and `ls` are explicit aliases for the bare-no-args form.
  // Without these, '/subgoal list' fell through the if-chain into the
  // 'add' branch and stored "list" as a real subgoal — confusing.
  if (lower === 'list' || lower === 'ls') return { verb: 'show', rest: '' }
  if (lower === 'remove' || lower === 'rm') return { verb: 'remove', rest: rest.join(' ').trim() }
  if (lower === 'clear') return { verb: 'clear', rest: rest.join(' ').trim() }
  // Anything else — treat the entire arg as the new subgoal text.
  return { verb: 'add', rest: arg }
}

export async function call(
  onDone: (result?: string) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode | null> {
  const sessionId = getSessionId() as UUID
  // Debug trace — pin down where weird subgoal text comes from. Logs
  // the raw args, parsed verb/rest, and (for show) the existing
  // subgoal array verbatim so we can see whether letter prefixes
  // come from user input vs render-time formatting.
  logForDebugging(
    `[SUBGOAL] raw args=${JSON.stringify(args)} (len=${args?.length ?? 0})`,
    { level: 'info' },
  )
  const mgr = await GoalManager.load(sessionId, {
    defaultMaxTurns: getGlobalConfig().goalsMaxTurns,
  })

  if (!mgr.hasGoal()) {
    onDone('No active goal. Set one with /goal <text>.')
    return null
  }

  const arg = (args ?? '').trim()
  const { verb, rest } = parseVerb(arg)
  logForDebugging(
    `[SUBGOAL] parsed verb=${verb} rest=${JSON.stringify(rest)} ` +
      `existing=${JSON.stringify(mgr.state?.subgoals ?? [])}`,
    { level: 'info' },
  )

  if (verb === 'show') {
    const rendered = `${mgr.statusLine()}\n${mgr.renderSubgoals()}`
    logForDebugging(`[SUBGOAL] show rendered=${JSON.stringify(rendered)}`, {
      level: 'info',
    })
    onDone(rendered)
    return null
  }

  if (verb === 'remove') {
    if (!rest) {
      onDone('Usage: /subgoal remove <n>')
      return null
    }
    const n = Number(rest.split(/\s+/)[0])
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      onDone('/subgoal remove: <n> must be an integer (1-based index).')
      return null
    }
    try {
      const removed = await mgr.removeSubgoal(n)
      onDone(`✓ Removed subgoal ${n}: ${removed}`)
    } catch (e) {
      onDone(`/subgoal remove: ${(e as Error).message}`)
    }
    return null
  }

  if (verb === 'clear') {
    try {
      const prev = await mgr.clearSubgoals()
      onDone(
        prev > 0
          ? `✓ Cleared ${prev} subgoal${prev === 1 ? '' : 's'}.`
          : 'No subgoals to clear.',
      )
    } catch (e) {
      onDone(`/subgoal clear: ${(e as Error).message}`)
    }
    return null
  }

  // verb === 'add'
  try {
    const text = await mgr.addSubgoal(arg)
    const idx = mgr.state?.subgoals.length ?? 0
    logForDebugging(
      `[SUBGOAL] added idx=${idx} text=${JSON.stringify(text)} ` +
        `array-after=${JSON.stringify(mgr.state?.subgoals ?? [])}`,
      { level: 'info' },
    )
    onDone(`✓ Added subgoal ${idx}: ${text}`)
  } catch (e) {
    onDone(`/subgoal: ${(e as Error).message}`)
  }
  return null
}

export const _internal = { parseVerb }
