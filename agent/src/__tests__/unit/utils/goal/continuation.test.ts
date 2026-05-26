import { describe, expect, it } from 'vitest'
import {
  CONTINUATION_PROMPT_PREFIX,
  isContinuationPrompt,
  renderContinuationPrompt,
} from '../../../../utils/goal/continuation.js'

describe('renderContinuationPrompt', () => {
  it('renders the base template when no subgoals', () => {
    const out = renderContinuationPrompt({ goal: 'write fibonacci' })
    expect(out).toContain(CONTINUATION_PROMPT_PREFIX)
    expect(out).toContain('Goal: write fibonacci')
    expect(out).not.toContain('Additional criteria')
  })

  it('renders the with-subgoals template when block is non-empty', () => {
    const out = renderContinuationPrompt({
      goal: 'do thing',
      subgoalsBlock: '- 1. add tests\n- 2. cover edge cases',
    })
    expect(out).toContain('Goal: do thing')
    expect(out).toContain('Additional criteria the user added mid-loop:')
    expect(out).toContain('- 1. add tests')
    expect(out).toContain('- 2. cover edge cases')
  })

  it('treats empty-string subgoalsBlock as no subgoals', () => {
    const out = renderContinuationPrompt({
      goal: 'g',
      subgoalsBlock: '',
    })
    expect(out).not.toContain('Additional criteria')
  })
})

describe('isContinuationPrompt', () => {
  it('returns true for rendered continuation prompts', () => {
    expect(isContinuationPrompt(renderContinuationPrompt({ goal: 'x' }))).toBe(
      true,
    )
  })

  it('returns false for plain user text', () => {
    expect(isContinuationPrompt('hello world')).toBe(false)
    expect(isContinuationPrompt(`${CONTINUATION_PROMPT_PREFIX} but inline`)).toBe(
      true,
    )
  })
})
