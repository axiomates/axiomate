/**
 * Continuation prompt templates fed back into the conversation when the
 * judge says "continue". Ported from
 * hermes-agent/hermes_cli/goals.py:71-92 — verbatim text, because the
 * leading `[Continuing toward your standing goal]` marker is also used
 * by the UI layer ({@link UserTextMessage}) to render a ↻ glyph on the
 * synthesized turn.
 *
 * Axiomate divergence: when `lastReason` is provided we append a
 * "Judge's note on your last turn: <reason>" block. Hermes never tells
 * the agent why the judge said continue — the agent has to re-examine
 * its own output to guess what was missing, which on long goals leads
 * to "I already did that" / judge "didn't see it" loops. Passing the
 * judge's note breaks that cycle. User-toggleable via
 * `globalConfig.goalsContinuationIncludeReason` (default true).
 */

export const CONTINUATION_PROMPT_PREFIX =
  '[Continuing toward your standing goal]'

const BASE_TEMPLATE =
  `${CONTINUATION_PROMPT_PREFIX}\n` +
  'Goal: {goal}\n\n' +
  '{judgeNote}' +
  'Continue working toward this goal. Take the next concrete step. ' +
  'If you believe the goal is complete, state so explicitly and stop. ' +
  'If you are blocked and need input from the user, say so clearly and stop.'

const WITH_SUBGOALS_TEMPLATE =
  `${CONTINUATION_PROMPT_PREFIX}\n` +
  'Goal: {goal}\n\n' +
  'Additional criteria the user added mid-loop:\n' +
  '{subgoalsBlock}\n\n' +
  '{judgeNote}' +
  'Continue working toward the goal AND all additional criteria. Take ' +
  'the next concrete step. If you believe the goal and every ' +
  'additional criterion are complete, state so explicitly and stop. ' +
  'If you are blocked and need input from the user, say so clearly ' +
  'and stop.'

function judgeNoteBlock(reason: string | undefined): string {
  if (!reason) return ''
  return `Judge's note on your last turn: ${reason}\n\n`
}

export function renderContinuationPrompt(args: {
  goal: string
  subgoalsBlock?: string
  /** Last verdict's reason — only included when caller wants it (see
   * `globalConfig.goalsContinuationIncludeReason`). */
  lastReason?: string
}): string {
  const note = judgeNoteBlock(args.lastReason)
  if (args.subgoalsBlock && args.subgoalsBlock.length > 0) {
    return WITH_SUBGOALS_TEMPLATE.replace('{goal}', args.goal)
      .replace('{subgoalsBlock}', args.subgoalsBlock)
      .replace('{judgeNote}', note)
  }
  return BASE_TEMPLATE.replace('{goal}', args.goal).replace('{judgeNote}', note)
}

/**
 * Cheap predicate the UI layer uses to detect continuation-prompt user
 * messages without coupling to the full template string.
 */
export function isContinuationPrompt(text: string): boolean {
  return text.startsWith(CONTINUATION_PROMPT_PREFIX)
}
