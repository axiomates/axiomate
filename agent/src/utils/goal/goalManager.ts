/**
 * GoalManager — orchestration surface for the persistent /goal Ralph
 * loop. Ported from hermes-agent/hermes_cli/goals.py:471-747.
 *
 * Each session holds at most one GoalManager (constructed via
 * {@link GoalManager.load}). All mutations persist immediately through
 * the JSONL store ({@link saveGoalState}); state is also kept in-memory
 * so successive reads inside a turn don't re-walk the transcript.
 *
 * The state machine flow per turn:
 *   1. caller (`handleGoalHook`) extracts the assistant's last text.
 *   2. caller invokes {@link evaluateAfterTurn}.
 *   3. manager calls the judge, updates counters, and returns a
 *      decision the caller can ferry back to the message queue.
 *
 * Fail-open: any unexpected error in `evaluateAfterTurn` collapses to
 * `verdict='continue'` so a broken judge can never wedge progress; the
 * turn budget and the consecutive-parse-failures backstop are the
 * recovery paths.
 */

import type { UUID } from 'crypto'
import { getGlobalConfig } from '../config.js'
import { renderContinuationPrompt } from './continuation.js'
import {
  DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES,
  judgeGoal,
  type JudgeVerdict,
} from './goalJudge.js'
import {
  createInitialGoalState,
  DEFAULT_MAX_TURNS,
  type GoalState,
  type GoalStatus,
  renderSubgoals,
  renderSubgoalsBlock,
  statusLine,
} from './goalState.js'
import {
  clearGoalState,
  loadGoalState,
  saveGoalState,
} from './goalStore.js'

export type EvaluateAfterTurnArgs = {
  /** Concatenated text content of the most recent assistant message. */
  lastResponse: string
  /** True if the user cancelled (Ctrl+C) the turn that just finished. */
  interrupted?: boolean
  /** Used to abort the judge call if the user walks away mid-evaluation. */
  signal: AbortSignal
}

export type EvaluateAfterTurnDecision = {
  status: GoalStatus | null
  shouldContinue: boolean
  continuationPrompt: string | null
  verdict: JudgeVerdict | 'inactive'
  reason: string
  /**
   * One-line user-facing message ('↻ Continuing toward goal …',
   * '✓ Goal achieved …', '⏸ Goal paused …'). Empty string when the
   * caller should suppress UI output (e.g. inactive / empty response).
   */
  message: string
}

export class GoalManager {
  readonly sessionId: UUID
  readonly defaultMaxTurns: number
  private _state: GoalState | null

  private constructor(args: {
    sessionId: UUID
    defaultMaxTurns: number
    state: GoalState | null
  }) {
    this.sessionId = args.sessionId
    this.defaultMaxTurns = args.defaultMaxTurns
    this._state = args.state
  }

  /**
   * Construct a manager for `sessionId`, hydrating from the persisted
   * jsonl entry if one exists.
   */
  static async load(
    sessionId: UUID,
    opts?: { defaultMaxTurns?: number },
  ): Promise<GoalManager> {
    const state = await loadGoalState(sessionId)
    return new GoalManager({
      sessionId,
      defaultMaxTurns: opts?.defaultMaxTurns ?? DEFAULT_MAX_TURNS,
      state,
    })
  }

  // --- introspection ----------------------------------------------------

  get state(): GoalState | null {
    return this._state
  }

  isActive(): boolean {
    return this._state !== null && this._state.status === 'active'
  }

  /** True for `active` OR `paused` — the goal is "around" but maybe not running. */
  hasGoal(): boolean {
    return (
      this._state !== null &&
      (this._state.status === 'active' || this._state.status === 'paused')
    )
  }

  statusLine(): string {
    return statusLine(this._state)
  }

  renderSubgoals(): string {
    return renderSubgoals(this._state)
  }

  // --- mutation ---------------------------------------------------------

  /**
   * Start a fresh goal. Replaces any existing state outright (matches
   * hermes goals.py:522-536 — set is destructive on prior goals).
   */
  async set(
    goal: string,
    opts?: { maxTurns?: number },
  ): Promise<GoalState> {
    const trimmed = goal.trim()
    if (!trimmed) throw new Error('goal text is empty')
    const state = createInitialGoalState(
      trimmed,
      opts?.maxTurns ?? this.defaultMaxTurns,
    )
    this._state = state
    await saveGoalState(this.sessionId, state)
    return state
  }

  async pause(reason: string = 'user-paused'): Promise<GoalState | null> {
    if (!this._state) return null
    this._state.status = 'paused'
    this._state.pausedReason = reason
    await saveGoalState(this.sessionId, this._state)
    return this._state
  }

  /**
   * Resume from `paused` back to `active`. Unlike hermes (which resets
   * the turn budget by default), axiomate keeps `turnsUsed` so users
   * who pause briefly and resume see a continuous count — pause is a
   * "stop, then keep going" not a "stop, then restart". Pass
   * `resetBudget: true` for the hermes-style fresh-budget reset.
   */
  async resume(opts?: {
    resetBudget?: boolean
  }): Promise<GoalState | null> {
    if (!this._state) return null
    this._state.status = 'active'
    this._state.pausedReason = undefined
    if (opts?.resetBudget === true) {
      this._state.turnsUsed = 0
    }
    await saveGoalState(this.sessionId, this._state)
    return this._state
  }

  async clear(): Promise<void> {
    if (!this._state) return
    await clearGoalState(this.sessionId)
    this._state = null
  }

  async markDone(reason: string): Promise<void> {
    if (!this._state) return
    this._state.status = 'done'
    this._state.lastVerdict = 'done'
    this._state.lastReason = reason
    await saveGoalState(this.sessionId, this._state)
  }

  // --- /subgoal ---------------------------------------------------------

  async addSubgoal(text: string): Promise<string> {
    if (!this._state || !this.hasGoal()) {
      throw new Error('no active goal')
    }
    const trimmed = text.trim()
    if (!trimmed) throw new Error('subgoal text is empty')
    this._state.subgoals.push(trimmed)
    await saveGoalState(this.sessionId, this._state)
    return trimmed
  }

  async removeSubgoal(index1Based: number): Promise<string> {
    if (!this._state || !this.hasGoal()) {
      throw new Error('no active goal')
    }
    const idx = index1Based - 1
    if (idx < 0 || idx >= this._state.subgoals.length) {
      throw new RangeError(`index out of range (1..${this._state.subgoals.length})`)
    }
    const removed = this._state.subgoals.splice(idx, 1)[0]!
    await saveGoalState(this.sessionId, this._state)
    return removed
  }

  async clearSubgoals(): Promise<number> {
    if (!this._state || !this.hasGoal()) {
      throw new Error('no active goal')
    }
    const prev = this._state.subgoals.length
    this._state.subgoals = []
    await saveGoalState(this.sessionId, this._state)
    return prev
  }

  // --- the main per-turn entry point ------------------------------------

  /**
   * Run the judge on the agent's last response and update state. Pure
   * 1:1 port of hermes goals.py:620-737, branch order preserved:
   *
   *  1. inactive               → return inactive (no message, no judge)
   *  2. interrupted (Ctrl+C)   → pause, NO judge call
   *  3. empty response         → silent return (no budget bump, no judge)
   *  4. tick turnsUsed/lastTurnAt
   *  5. judge → updates verdict / reason
   *  6. parse failed?          → bump consecutiveParseFailures (else reset)
   *  7. verdict==='done'       → status=done, return ✓
   *  8. parse failures >= cap  → status=paused, return ⏸ + judge-config hint
   *  9. turnsUsed >= maxTurns  → status=paused (budget), return ⏸
   * 10. otherwise              → continue with continuation prompt
   */
  async evaluateAfterTurn(
    args: EvaluateAfterTurnArgs,
  ): Promise<EvaluateAfterTurnDecision> {
    const state = this._state
    if (!state || state.status !== 'active') {
      return {
        status: state?.status ?? null,
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'inactive',
        reason: 'no active goal',
        message: '',
      }
    }

    // Branch 2: Ctrl+C — pause without judging. Mirrors cli.py:9404-9413.
    // The judge would almost always say "continue" on the partial output
    // and re-queue another turn, which is exactly what the user cancelled.
    if (args.interrupted) {
      state.status = 'paused'
      state.pausedReason = 'user-interrupted (Ctrl+C)'
      await saveGoalState(this.sessionId, state)
      return {
        status: 'paused',
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'continue',
        reason: state.pausedReason,
        message:
          '⏸ Goal paused — turn was interrupted. Use /goal resume to continue, or /goal clear to stop.',
      }
    }

    // Branch 3: empty response — almost always a transient API hiccup;
    // skipping avoids tripping the parse-failure backstop unnecessarily
    // (cli.py:9440 mirror).
    if (!args.lastResponse.trim()) {
      return {
        status: 'active',
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'continue',
        reason: 'empty response (skipped)',
        message: '',
      }
    }

    // Branch 4: tick budget.
    state.turnsUsed += 1
    state.lastTurnAt = Date.now()

    const judgeResult = await judgeGoal({
      goal: state.goal,
      lastResponse: args.lastResponse,
      subgoals: state.subgoals.length > 0 ? state.subgoals : undefined,
      signal: args.signal,
    })
    state.lastVerdict = judgeResult.verdict
    state.lastReason = judgeResult.reason

    // Branch 6: parse failure counter. API/transport errors (parseFailed=false)
    // reset the counter — flaky network must not trip the auto-pause that
    // exists for genuinely bad judge models.
    if (judgeResult.parseFailed) {
      state.consecutiveParseFailures += 1
    } else {
      state.consecutiveParseFailures = 0
    }

    // Branch 7: done.
    if (judgeResult.verdict === 'done') {
      state.status = 'done'
      await saveGoalState(this.sessionId, state)
      return {
        status: 'done',
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'done',
        reason: judgeResult.reason,
        message: `✓ Goal achieved: ${judgeResult.reason}`,
      }
    }

    // Branch 8: judge-broken auto-pause. Mirrors goals.py:687-709 — points
    // the user at the auxiliary.goal_judge override so they can route
    // this side task to a model that follows the JSON contract.
    // Threshold is user-configurable via `goalsParseFailureLimit`; 0
    // disables the cap entirely.
    const configuredLimit = getGlobalConfig().goalsParseFailureLimit
    const parseFailureLimit =
      typeof configuredLimit === 'number' && Number.isFinite(configuredLimit) && configuredLimit >= 0
        ? configuredLimit
        : DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES
    if (
      parseFailureLimit > 0 &&
      state.consecutiveParseFailures >= parseFailureLimit
    ) {
      state.status = 'paused'
      state.pausedReason = `judge model returned unparseable output ${state.consecutiveParseFailures} turns in a row`
      await saveGoalState(this.sessionId, state)
      return {
        status: 'paused',
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'continue',
        reason: judgeResult.reason,
        message:
          `⏸ Goal paused — the judge model (${state.consecutiveParseFailures} turns) ` +
          "isn't returning the required JSON verdict. Set " +
          '`midModel` or `fastModel` in ~/.axiomate.json to a stricter ' +
          'model (one that follows JSON output instructions). ' +
          'Then /goal resume to continue.',
      }
    }

    // Branch 9: budget exhausted. maxTurns=0 means "unlimited" (the
    // only stops are parse-failure cap, user pause, or done).
    if (state.maxTurns > 0 && state.turnsUsed >= state.maxTurns) {
      state.status = 'paused'
      state.pausedReason = `turn budget exhausted (${state.turnsUsed}/${state.maxTurns})`
      await saveGoalState(this.sessionId, state)
      return {
        status: 'paused',
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'continue',
        reason: judgeResult.reason,
        message:
          `⏸ Goal paused — ${state.turnsUsed}/${state.maxTurns} turns used. ` +
          'Use /goal resume to keep going, or /goal clear to stop.',
      }
    }

    // Branch 10: continue.
    await saveGoalState(this.sessionId, state)
    const budget =
      state.maxTurns > 0
        ? `${state.turnsUsed}/${state.maxTurns}`
        : `${state.turnsUsed}/∞`
    return {
      status: 'active',
      shouldContinue: true,
      continuationPrompt: this.nextContinuationPrompt(),
      verdict: 'continue',
      reason: judgeResult.reason,
      message: `↻ Continuing toward goal (${budget}): ${judgeResult.reason}`,
    }
  }

  /**
   * Render the continuation prompt to feed back into the conversation
   * loop. Returns null when no goal is active (caller should treat that
   * as "nothing to enqueue").
   */
  nextContinuationPrompt(): string | null {
    if (!this._state || this._state.status !== 'active') return null
    const subgoalsBlock = renderSubgoalsBlock(this._state)
    return renderContinuationPrompt({
      goal: this._state.goal,
      subgoalsBlock: subgoalsBlock.length > 0 ? subgoalsBlock : undefined,
    })
  }
}
