import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseJudgeResponse } from '../../../../utils/goal/goalJudge.js'

vi.mock('../../../../services/api/llm.js', () => ({
  queryFastModel: vi.fn(),
}))

import { queryFastModel } from '../../../../services/api/llm.js'
import { judgeGoal } from '../../../../utils/goal/goalJudge.js'

const mockedQuery = vi.mocked(queryFastModel)

function fakeAssistantMessage(text: string) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as unknown as Awaited<ReturnType<typeof queryFastModel>>
}

beforeEach(() => {
  mockedQuery.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('parseJudgeResponse', () => {
  it('clean JSON object — done=true', () => {
    const r = parseJudgeResponse('{"done": true, "reason": "all done"}')
    expect(r.verdict).toBe('done')
    expect(r.reason).toBe('all done')
    expect(r.parseFailed).toBe(false)
  })

  it('clean JSON object — done=false', () => {
    const r = parseJudgeResponse('{"done": false, "reason": "still working"}')
    expect(r.verdict).toBe('continue')
    expect(r.reason).toBe('still working')
    expect(r.parseFailed).toBe(false)
  })

  it('strips ```json fence', () => {
    const r = parseJudgeResponse('```json\n{"done": true, "reason": "ok"}\n```')
    expect(r.verdict).toBe('done')
    expect(r.parseFailed).toBe(false)
  })

  it('strips bare ``` fence', () => {
    const r = parseJudgeResponse('```\n{"done": false, "reason": "x"}\n```')
    expect(r.verdict).toBe('continue')
    expect(r.parseFailed).toBe(false)
  })

  it('strips <think> reasoning prefix', () => {
    const r = parseJudgeResponse(
      '<think>The user wants me to check…</think>\n{"done": true, "reason": "ok"}',
    )
    expect(r.verdict).toBe('done')
    expect(r.parseFailed).toBe(false)
  })

  it('extracts first JSON object from prose', () => {
    const r = parseJudgeResponse(
      'After analysis: {"done": false, "reason": "needs more"} — see above.',
    )
    expect(r.verdict).toBe('continue')
    expect(r.reason).toBe('needs more')
    expect(r.parseFailed).toBe(false)
  })

  it('treats string "true" as done', () => {
    const r = parseJudgeResponse('{"done": "true", "reason": "ok"}')
    expect(r.verdict).toBe('done')
    expect(r.parseFailed).toBe(false)
  })

  it('treats string "yes"/"done"/"1" as done', () => {
    expect(parseJudgeResponse('{"done":"yes","reason":"x"}').verdict).toBe('done')
    expect(parseJudgeResponse('{"done":"done","reason":"x"}').verdict).toBe('done')
    expect(parseJudgeResponse('{"done":"1","reason":"x"}').verdict).toBe('done')
  })

  it('treats arbitrary string as not done', () => {
    expect(parseJudgeResponse('{"done":"maybe","reason":"x"}').verdict).toBe(
      'continue',
    )
  })

  it('flags empty response', () => {
    const r = parseJudgeResponse('')
    expect(r.parseFailed).toBe(true)
    expect(r.verdict).toBe('continue')
    expect(r.reason).toContain('empty')
  })

  it('flags non-JSON prose', () => {
    const r = parseJudgeResponse('Sure, the goal is done.')
    expect(r.parseFailed).toBe(true)
    expect(r.verdict).toBe('continue')
  })

  it('flags malformed JSON', () => {
    const r = parseJudgeResponse('{"done": true, "reason":')
    expect(r.parseFailed).toBe(true)
    expect(r.verdict).toBe('continue')
  })

  it('falls back to "no reason provided" when reason is empty', () => {
    const r = parseJudgeResponse('{"done": true, "reason": ""}')
    expect(r.reason).toBe('no reason provided')
    expect(r.parseFailed).toBe(false)
  })
})

describe('judgeGoal', () => {
  it('returns skipped on empty goal — no LLM call', async () => {
    const r = await judgeGoal({
      goal: '   ',
      lastResponse: 'agent did stuff',
      signal: new AbortController().signal,
    })
    expect(r.verdict).toBe('skipped')
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('returns continue on empty response — no LLM call', async () => {
    const r = await judgeGoal({
      goal: 'do x',
      lastResponse: '   ',
      signal: new AbortController().signal,
    })
    expect(r.verdict).toBe('continue')
    expect(r.reason).toContain('empty response')
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('returns done verdict from LLM', async () => {
    mockedQuery.mockResolvedValue(
      fakeAssistantMessage('{"done": true, "reason": "shipped"}'),
    )
    const r = await judgeGoal({
      goal: 'ship it',
      lastResponse: 'shipped fix',
      signal: new AbortController().signal,
    })
    expect(r.verdict).toBe('done')
    expect(r.reason).toBe('shipped')
    expect(mockedQuery).toHaveBeenCalledTimes(1)
  })

  it('returns continue verdict from LLM', async () => {
    mockedQuery.mockResolvedValue(
      fakeAssistantMessage('{"done": false, "reason": "more work"}'),
    )
    const r = await judgeGoal({
      goal: 'g',
      lastResponse: 'partial',
      signal: new AbortController().signal,
    })
    expect(r.verdict).toBe('continue')
    expect(r.reason).toBe('more work')
  })

  it('uses with-subgoals template when subgoals are present', async () => {
    mockedQuery.mockResolvedValue(
      fakeAssistantMessage('{"done": false, "reason": "needs more"}'),
    )
    await judgeGoal({
      goal: 'g',
      lastResponse: 'x',
      subgoals: ['add tests', 'cover edges'],
      signal: new AbortController().signal,
    })
    const sentPrompt = mockedQuery.mock.calls[0]![0].userPrompt as string
    expect(sentPrompt).toContain('Additional criteria the user added mid-loop')
    expect(sentPrompt).toContain('- 1. add tests')
    expect(sentPrompt).toContain('- 2. cover edges')
  })

  it('skips with-subgoals template when subgoals filter to empty', async () => {
    mockedQuery.mockResolvedValue(
      fakeAssistantMessage('{"done": false, "reason": "x"}'),
    )
    await judgeGoal({
      goal: 'g',
      lastResponse: 'x',
      subgoals: ['  ', ''],
      signal: new AbortController().signal,
    })
    const sentPrompt = mockedQuery.mock.calls[0]![0].userPrompt as string
    expect(sentPrompt).not.toContain('Additional criteria')
  })

  it('fails open on API error — verdict continue, parseFailed false', async () => {
    mockedQuery.mockRejectedValue(new Error('rate limited'))
    const r = await judgeGoal({
      goal: 'g',
      lastResponse: 'x',
      signal: new AbortController().signal,
    })
    expect(r.verdict).toBe('continue')
    expect(r.reason).toContain('judge error')
    expect(r.parseFailed).toBe(false)
  })

  it('flags parse failure when LLM returns non-JSON', async () => {
    mockedQuery.mockResolvedValue(fakeAssistantMessage('hello world'))
    const r = await judgeGoal({
      goal: 'g',
      lastResponse: 'x',
      signal: new AbortController().signal,
    })
    expect(r.verdict).toBe('continue')
    expect(r.parseFailed).toBe(true)
  })

  it('disables prompt caching for goal judge', async () => {
    mockedQuery.mockResolvedValue(
      fakeAssistantMessage('{"done": false, "reason": "x"}'),
    )
    await judgeGoal({
      goal: 'g',
      lastResponse: 'x',
      signal: new AbortController().signal,
    })
    const opts = mockedQuery.mock.calls[0]![0].options as {
      enablePromptCaching?: boolean
    }
    expect(opts.enablePromptCaching).toBe(false)
  })
})
