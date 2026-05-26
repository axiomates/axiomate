/**
 * Goal-judge LLM call + response parser. Ported from
 * hermes-agent/hermes_cli/goals.py:95-463.
 *
 * Two surfaces:
 *   - {@link parseJudgeResponse} — pure function that takes a raw model
 *     reply and returns a structured verdict. Tolerant of reasoning-model
 *     `<think>...</think>` prefixes, ```json fences, embedded prose, and
 *     the `done` field appearing as either bool or truthy string. Empty /
 *     unparseable replies are flagged via `parseFailed: true` so the
 *     manager can auto-pause after N consecutive failures.
 *   - {@link judgeGoal} — orchestrates the `queryFastModel` call + parse,
 *     with a strict fail-open contract: any API / transport / network
 *     error returns `('continue', 'judge error: ...', false)` rather than
 *     wedging progress.
 *
 * The judge runs on whatever model {@link getAuxiliaryModel} resolves for
 * the `'goalJudge'` role; users are nudged toward configuring a cheap
 * fast model at `/goal` set time.
 */

import { queryFastModel } from '../../services/api/llm.js'
import { extractTextContent } from '../messages.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'

export const DEFAULT_JUDGE_MAX_TOKENS = 4096
export const JUDGE_RESPONSE_SNIPPET_CHARS = 4000
export const DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES = 3

const JUDGE_GOAL_SNIPPET_CHARS = 2000
const JUDGE_SUBGOALS_SNIPPET_CHARS = 2000

export type JudgeVerdict = 'done' | 'continue' | 'skipped'

export type JudgeResult = {
  verdict: JudgeVerdict
  reason: string
  parseFailed: boolean
}

export const JUDGE_SYSTEM_PROMPT =
  "You are a strict judge evaluating whether an autonomous agent has " +
  "achieved a user's stated goal. You receive the goal text and the " +
  "agent's most recent response. Your only job is to decide whether " +
  "the goal is fully satisfied based on that response.\n\n" +
  'A goal is DONE only when:\n' +
  '- The response explicitly confirms the goal was completed, OR\n' +
  '- The response clearly shows the final deliverable was produced, OR\n' +
  '- The response explains the goal is unachievable / blocked / needs ' +
  'user input (treat this as DONE with reason describing the block).\n\n' +
  'Otherwise the goal is NOT done — CONTINUE.\n\n' +
  'Reply ONLY with a single JSON object on one line:\n' +
  '{"done": <true|false>, "reason": "<one-sentence rationale>"}'

const JUDGE_USER_PROMPT_TEMPLATE =
  'Goal:\n{goal}\n\n' +
  "Agent's most recent response:\n{response}\n\n" +
  'Current time: {currentTime}\n\n' +
  'Is the goal satisfied?'

const JUDGE_USER_PROMPT_WITH_SUBGOALS_TEMPLATE =
  'Goal:\n{goal}\n\n' +
  'Additional criteria the user added mid-loop (all must also be ' +
  'satisfied for the goal to be DONE):\n{subgoalsBlock}\n\n' +
  "Agent's most recent response:\n{response}\n\n" +
  'Current time: {currentTime}\n\n' +
  'Decision: For each numbered criterion above, find concrete ' +
  "evidence in the agent's response that the criterion is " +
  "satisfied. Do not accept generic phrases like 'all requirements " +
  "met' or 'implying it was done' — require specific evidence (a " +
  'file contents excerpt, an output line, a command result). If ' +
  'ANY criterion lacks specific evidence in the response, the goal ' +
  'is NOT done — return CONTINUE.\n\n' +
  'Is the goal AND every additional criterion satisfied?'

function truncate(text: string, limit: number): string {
  if (!text) return ''
  if (text.length <= limit) return text
  return text.slice(0, limit) + '… [truncated]'
}

// Strip <think>...</think> reasoning blocks (Qwen / DeepSeek-R1 over
// OpenAI-compatible endpoints prefix replies with one when our explicit
// thinkingConfig is ignored). Greedy across newlines; multiple blocks
// stripped independently.
function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
}

const JSON_OBJECT_RE = /\{[\s\S]*?\}/

export function parseJudgeResponse(raw: string): JudgeResult {
  if (!raw) {
    return { verdict: 'continue', reason: 'judge returned empty response', parseFailed: true }
  }

  let text = stripReasoning(raw).trim()

  // Strip ```...``` markdown fence (with or without the json tag).
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '')
    text = text.replace(/```$/, '').trim()
  }

  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    const match = JSON_OBJECT_RE.exec(text)
    if (match) {
      try {
        data = JSON.parse(match[0])
      } catch {
        data = null
      }
    }
  }

  if (!data || typeof data !== 'object') {
    return {
      verdict: 'continue',
      reason: `judge reply was not JSON: ${JSON.stringify(truncate(raw, 200))}`,
      parseFailed: true,
    }
  }

  const obj = data as { done?: unknown; reason?: unknown }
  let done: boolean
  if (typeof obj.done === 'string') {
    done = ['true', 'yes', '1', 'done'].includes(obj.done.trim().toLowerCase())
  } else {
    done = Boolean(obj.done)
  }
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim().length > 0
      ? obj.reason.trim()
      : 'no reason provided'

  return {
    verdict: done ? 'done' : 'continue',
    reason,
    parseFailed: false,
  }
}

function renderSubgoalsBlockForPrompt(subgoals: string[]): string {
  return subgoals
    .map((text, i) => `- ${i + 1}. ${text}`)
    .join('\n')
}

/**
 * Run the judge on the agent's last response and return a structured
 * verdict. Fail-open: every error path returns `verdict='continue'` so a
 * broken judge can never wedge the loop — the turn budget and the
 * consecutive-parse-failures counter are the backstops.
 *
 * `parseFailed` is true ONLY when the API call succeeded but the reply
 * was unparseable. API / transport / network failures return
 * `parseFailed: false` so flaky networks don't trip the auto-pause meant
 * for genuinely bad judge models.
 */
export async function judgeGoal(args: {
  goal: string
  lastResponse: string
  subgoals?: string[]
  signal: AbortSignal
}): Promise<JudgeResult> {
  const goal = args.goal.trim()
  if (!goal) {
    return { verdict: 'skipped', reason: 'empty goal', parseFailed: false }
  }
  const lastResponse = args.lastResponse.trim()
  if (!lastResponse) {
    return {
      verdict: 'continue',
      reason: 'empty response (nothing to evaluate)',
      parseFailed: false,
    }
  }

  const cleanSubgoals = (args.subgoals ?? [])
    .map(s => s.trim())
    .filter(s => s.length > 0)
  const currentTime = new Date().toISOString()

  const userPrompt =
    cleanSubgoals.length > 0
      ? JUDGE_USER_PROMPT_WITH_SUBGOALS_TEMPLATE.replace(
          '{goal}',
          truncate(goal, JUDGE_GOAL_SNIPPET_CHARS),
        )
          .replace(
            '{subgoalsBlock}',
            truncate(
              renderSubgoalsBlockForPrompt(cleanSubgoals),
              JUDGE_SUBGOALS_SNIPPET_CHARS,
            ),
          )
          .replace(
            '{response}',
            truncate(lastResponse, JUDGE_RESPONSE_SNIPPET_CHARS),
          )
          .replace('{currentTime}', currentTime)
      : JUDGE_USER_PROMPT_TEMPLATE.replace(
          '{goal}',
          truncate(goal, JUDGE_GOAL_SNIPPET_CHARS),
        )
          .replace(
            '{response}',
            truncate(lastResponse, JUDGE_RESPONSE_SNIPPET_CHARS),
          )
          .replace('{currentTime}', currentTime)

  try {
    const result = await queryFastModel({
      systemPrompt: asSystemPrompt([JUDGE_SYSTEM_PROMPT]),
      userPrompt,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            done: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['done', 'reason'],
          additionalProperties: false,
        },
      },
      signal: args.signal,
      options: {
        querySource: 'side_question',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        enablePromptCaching: false,
      },
    })
    const text = extractTextContent(result.message.content)
    return parseJudgeResponse(text)
  } catch (err) {
    logForDebugging(`goal judge: API call failed: ${errorMessage(err)}`, {
      level: 'info',
    })
    return {
      verdict: 'continue',
      reason: `judge error: ${(err as Error).name ?? 'Error'}`,
      parseFailed: false,
    }
  }
}
