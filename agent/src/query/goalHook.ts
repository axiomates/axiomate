/**
 * Goal-loop turn-end hook. Wires the {@link GoalManager} state machine
 * into the main query pipeline by running once at the end of each
 * assistant turn — after all user-configured stop hooks finish but
 * before the response leaves `handleStopHooks`.
 *
 * Port of hermes-agent/hermes_cli/cli.py:9340-9454
 * (`_maybe_continue_goal_after_turn`).
 *
 * Decision flow:
 *   1. No active goal in this session                       → no-op.
 *   2. A real (non-slash-command) user message is already queued
 *      → defer; the user's turn takes priority.
 *   3. The user cancelled the turn (Ctrl+C aborted the controller)
 *      → call `evaluateAfterTurn({interrupted:true})` so the manager
 *      pauses without judging.
 *   4. Otherwise extract last assistant text and run the judge.
 *   5. If the verdict is "continue" + we're under budget, enqueue the
 *      continuation prompt as a normal user message (priority `'next'`).
 *
 * The yielded verdict message is marked `isMeta: true` so the user sees
 * it but it does NOT enter the model's next-turn context (avoids
 * polluting prompt cache with judge prose).
 */

import { getSessionId } from '../bootstrap/state.js'
import { randomUUID } from 'crypto'
import { GoalManager } from '../utils/goal/goalManager.js'
import { getGlobalConfig } from '../utils/config.js'
import {
  enqueue,
  getCommandQueueSnapshot,
  isSlashCommand,
  removeByFilter,
} from '../utils/messageQueueManager.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { isContinuationPrompt } from '../utils/goal/continuation.js'
import type {
  AssistantMessage,
  Message,
  SystemInformationalMessage,
} from '../types/message.js'
import type { ToolUseContext } from '../Tool.js'
import type { UUID } from 'crypto'

/**
 * True when there's already a real user message queued behind the
 * current turn. Slash commands are inspection / mutation noise and
 * don't count — letting them block goal continuation would silently
 * stall the loop when the user types `/subgoal add foo` mid-run.
 *
 * Mirrors hermes cli.py:9374-9395 (_pending_input deque peek).
 */
function realUserMessageQueued(): boolean {
  const queue = getCommandQueueSnapshot()
  for (const cmd of queue) {
    if (isSlashCommand(cmd)) continue
    // Non-string payloads (image / attachment blocks) count as real.
    if (typeof cmd.value !== 'string') return true
    if (cmd.value.trim() !== '') return true
  }
  return false
}

function extractLastAssistantText(
  assistantMessages: readonly AssistantMessage[],
): string {
  const last = assistantMessages[assistantMessages.length - 1]
  const content = last?.message?.content
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : ''
  }
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
    )
    .map(b => b.text)
    .join('\n')
}

export async function* handleGoalHook(args: {
  assistantMessages: readonly AssistantMessage[]
  toolUseContext: ToolUseContext
}): AsyncGenerator<Message, void> {
  const sessionId = (getSessionId() as unknown) as UUID
  if (!sessionId) return

  let mgr: GoalManager
  try {
    mgr = await GoalManager.load(sessionId, {
      defaultMaxTurns: getGlobalConfig().goalsMaxTurns,
    })
  } catch (err) {
    logForDebugging(`goal hook: load failed: ${errorMessage(err)}`, {
      level: 'info',
    })
    return
  }

  if (!mgr.isActive()) return

  // Branch 2: real user message preempts (slash commands don't count).
  if (realUserMessageQueued()) return

  const interrupted = args.toolUseContext.abortController.signal.aborted

  // Branch 3 setup: empty response check happens inside evaluateAfterTurn,
  // but skip the work when not interrupted AND empty (so we don't even
  // load the judge module).
  const lastResponse = extractLastAssistantText(args.assistantMessages)
  if (!interrupted && !lastResponse.trim()) return

  let decision
  try {
    decision = await mgr.evaluateAfterTurn({
      lastResponse,
      interrupted,
      signal: args.toolUseContext.abortController.signal,
    })
  } catch (err) {
    // Fail-open: never let goal-judging wedge the conversation flow.
    logForDebugging(
      `goal hook: evaluateAfterTurn threw: ${errorMessage(err)}`,
      { level: 'warn' },
    )
    return
  }

  if (decision.message) {
    // isMeta:true keeps verdict text out of the model's next-turn context
    // while still surfacing it to the user (B6 in the plan). createSystemMessage
    // hardcodes isMeta:false, so we build the message directly.
    const verdictMessage: SystemInformationalMessage = {
      type: 'system',
      subtype: 'informational',
      content: decision.message,
      isMeta: true,
      timestamp: new Date().toISOString(),
      uuid: randomUUID(),
      level: 'info',
    }
    yield verdictMessage
  }

  if (decision.shouldContinue && decision.continuationPrompt) {
    try {
      enqueue({
        value: decision.continuationPrompt,
        mode: 'prompt',
        priority: 'next',
      })
    } catch (err) {
      logForDebugging(`goal hook: enqueue failed: ${errorMessage(err)}`, {
        level: 'warn',
      })
    }
  } else {
    // Goal just stopped (done / paused / parse-failure / budget). Strip
    // any stale continuation prompts an earlier turn might have already
    // queued — without this, the queue processor would still dispatch
    // them and you'd see "↻ Continuing toward your standing goal" fire
    // AFTER the ✓ Goal achieved verdict. Detection key: the goalHook
    // is the only producer of strings starting with
    // CONTINUATION_PROMPT_PREFIX, so an exact prefix match is safe.
    try {
      removeByFilter(
        cmd =>
          cmd.mode === 'prompt' &&
          typeof cmd.value === 'string' &&
          isContinuationPrompt(cmd.value),
      )
    } catch (err) {
      logForDebugging(
        `goal hook: stale-continuation cleanup failed: ${errorMessage(err)}`,
        { level: 'warn' },
      )
    }
  }
}
