/**
 * Unit tests for prompt.ts (Step 2).
 *
 * Pin the LLM-facing surface — both the tool description (read by main agent)
 * and the summary prompt (read by aux LLM during Stage 4).
 */
import { describe, expect, test } from 'vitest'

import {
  SESSION_SEARCH_TOOL_NAME,
  getSessionSearchPrompt,
  getSummaryPrompt,
} from '../prompt.js'

describe('SESSION_SEARCH_TOOL_NAME', () => {
  test('canonical tool name is SessionSearch', () => {
    expect(SESSION_SEARCH_TOOL_NAME).toBe('SessionSearch')
  })
})

describe('getSessionSearchPrompt', () => {
  const text = getSessionSearchPrompt()

  test('mentions all 5 input parameters by name', () => {
    expect(text).toContain('query')
    expect(text).toContain('role_filter')
    expect(text).toContain('recent_days')
    expect(text).toContain('limit')
    expect(text).toContain('include_summary')
  })

  test('explains the cost trade-off + retrieval vs synthesis distinction', () => {
    expect(text.toLowerCase()).toContain('retrieval')
    expect(text.toLowerCase()).toContain('synthesis')
    expect(text).toMatch(/zero LLM cost|no LLM cost|default false/)
  })

  test('signals the axiomate-specific design (current session included)', () => {
    expect(text.toLowerCase()).toContain('current session')
    expect(text.toLowerCase()).toContain('compact')
  })

  test('lists the 4 algorithm stages so LLM understands cost shape', () => {
    expect(text).toContain('Stage 1')
    expect(text).toContain('Stage 2')
    expect(text).toContain('Stage 3')
    expect(text).toContain('Stage 4')
  })

  test('non-empty, reasonable size (<3500 chars; retrieval/synthesis examples added)', () => {
    expect(text.length).toBeGreaterThan(200)
    expect(text.length).toBeLessThan(3500)
  })
})

describe('getSummaryPrompt', () => {
  test('embeds the user query verbatim (so LLM stays on topic)', () => {
    const p = getSummaryPrompt('docker debug')
    expect(p).toContain('docker debug')
  })

  test('asks for the 5 categories of recall content', () => {
    const p = getSummaryPrompt('q')
    // Five-point structure mirrors hermes _SKILL_REVIEW_PROMPT
    expect(p).toMatch(/1\./)
    expect(p).toMatch(/2\./)
    expect(p).toMatch(/3\./)
    expect(p).toMatch(/4\./)
    expect(p).toMatch(/5\./)
  })

  test('explicitly forbids fabrication', () => {
    const p = getSummaryPrompt('q')
    expect(p.toLowerCase()).toContain('do not invent')
  })

  test('handles special characters in query without breaking the prompt', () => {
    const tricky = 'docker " quote\'s and `backticks`'
    const p = getSummaryPrompt(tricky)
    expect(p).toContain(tricky)
  })
})
