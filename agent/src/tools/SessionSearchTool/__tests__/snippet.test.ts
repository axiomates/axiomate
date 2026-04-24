/**
 * Unit tests for snippet.ts (Step 1b).
 *
 * Pure-function tests, no fs/no LLM. Ports hermes _truncate_around_matches
 * 4-strategy fallback contract.
 */
import { describe, expect, test } from 'vitest'
import { pickWindow } from '../snippet.js'

describe('pickWindow — short text passthrough', () => {
  test('text shorter than maxChars → return as-is, no truncation flags', () => {
    const result = pickWindow('hello world', 'world', 100)
    expect(result.window).toBe('hello world')
    expect(result.earlierTruncated).toBe(false)
    expect(result.laterTruncated).toBe(false)
  })

  test('text exactly maxChars → return as-is', () => {
    const text = 'a'.repeat(100)
    const result = pickWindow(text, 'b', 100)
    expect(result.window).toBe(text)
    expect(result.earlierTruncated).toBe(false)
    expect(result.laterTruncated).toBe(false)
  })
})

describe('pickWindow — Strategy 1: full-phrase match', () => {
  test('phrase found near middle of long text → window centered (25%/75%)', () => {
    const before = 'x'.repeat(2000)
    const after = 'y'.repeat(2000)
    const text = before + ' DOCKER_NEEDLE ' + after
    const result = pickWindow(text, 'DOCKER_NEEDLE', 1000)
    expect(result.window.toLowerCase()).toContain('docker_needle')
    expect(result.earlierTruncated).toBe(true)
    expect(result.laterTruncated).toBe(true)
    // 25% before bias: window starts roughly 250 chars before match
    const matchOffsetInWindow = result.window.toLowerCase().indexOf('docker_needle')
    expect(matchOffsetInWindow).toBeLessThan(400) // ~25% of 1000
    expect(matchOffsetInWindow).toBeGreaterThanOrEqual(0)
  })

  test('case-insensitive phrase match', () => {
    const text = 'x'.repeat(1000) + ' MixedCase ' + 'y'.repeat(1000)
    const result = pickWindow(text, 'mixedcase', 500)
    expect(result.window.toLowerCase()).toContain('mixedcase')
  })

  test('multiple phrase matches → window covering most of them wins', () => {
    // Three matches spread over ~6000 chars; window of 2000 should cluster
    // around the densest area.
    const block = 'a'.repeat(1000)
    const text = `START ${block} HIT ${block} HIT ${block} HIT ${block} END`
    const result = pickWindow(text, 'HIT', 2000)
    const occurrences = (result.window.match(/HIT/g) ?? []).length
    // Should pick a window that gets at least 2 of 3 hits
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })
})

describe('pickWindow — Strategy 2: proximity co-occurrence (multi-term query)', () => {
  test('two terms within PROXIMITY_RANGE both required for hit', () => {
    const before = 'x'.repeat(2000)
    const middle = 'docker container deployed'
    const after = 'y'.repeat(2000)
    const text = before + ' ' + middle + ' ' + after
    // 'docker container' as exact phrase will match Strategy 1, so use
    // term order that does NOT appear as exact phrase in text:
    const result = pickWindow(text, 'container docker', 1000)
    expect(result.window.toLowerCase()).toContain('docker')
    expect(result.window.toLowerCase()).toContain('container')
  })

  test('terms farther than PROXIMITY_RANGE → falls through to Strategy 3', () => {
    // 'docker' at start, 'container' at end >> 200 chars apart
    const text =
      'docker is in this part ' +
      'q'.repeat(5000) +
      ' container is way over here ' +
      'r'.repeat(5000)
    const result = pickWindow(text, 'container docker', 2000)
    // Strategy 3 falls back to individual term hits — first found wins (rarest term)
    expect(result.window.toLowerCase()).toMatch(/docker|container/)
  })
})

describe('pickWindow — Strategy 3: individual term positions', () => {
  test('single non-existent multi-word query → first term still anchors window', () => {
    // No 'magicwordzzz' → no match anywhere
    const text =
      'hello docker world '.repeat(500) + 'OFFTOPIC '.repeat(500)
    const result = pickWindow(text, 'magicwordzzz docker', 2000)
    // 'docker' is in text → Strategy 3 picks one of those positions
    expect(result.window.toLowerCase()).toContain('docker')
  })
})

describe('pickWindow — Strategy 4: no match → from start', () => {
  test('query with no matching tokens → window from start with later truncation', () => {
    const text = 'completely unrelated content '.repeat(500)
    const result = pickWindow(text, 'NONEXISTENT_TOKEN_ZZ', 1000)
    expect(result.window).toBe(text.slice(0, 1000))
    expect(result.earlierTruncated).toBe(false)
    expect(result.laterTruncated).toBe(true)
  })

  test('empty query falls back to from-start (no Strategy 1-3 anchor)', () => {
    const text = 'a'.repeat(2000)
    const result = pickWindow(text, '', 500)
    expect(result.window).toBe(text.slice(0, 500))
    expect(result.earlierTruncated).toBe(false)
    expect(result.laterTruncated).toBe(true)
  })
})

describe('pickWindow — window boundary correctness', () => {
  test('match near end of text → window slides to fit, earlierTruncated=true', () => {
    const text = 'x'.repeat(5000) + ' MATCHED'
    const result = pickWindow(text, 'MATCHED', 1000)
    expect(result.window).toContain('MATCHED')
    expect(result.earlierTruncated).toBe(true)
    expect(result.laterTruncated).toBe(false)
  })

  test('match near start → window pinned to 0, no earlier truncation', () => {
    const text = 'MATCHED ' + 'y'.repeat(5000)
    const result = pickWindow(text, 'MATCHED', 1000)
    expect(result.window).toContain('MATCHED')
    expect(result.earlierTruncated).toBe(false)
    expect(result.laterTruncated).toBe(true)
  })

  test('window length never exceeds maxChars', () => {
    const text = 'x'.repeat(10000) + ' HIT ' + 'y'.repeat(10000)
    const result = pickWindow(text, 'HIT', 1500)
    expect(result.window.length).toBeLessThanOrEqual(1500)
  })
})
