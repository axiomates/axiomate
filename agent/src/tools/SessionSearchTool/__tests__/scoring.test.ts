/**
 * Unit tests for scoring.ts (Step 1b).
 *
 * Pure-function tests, no fs/no LLM. Pin ordering contracts that downstream
 * SessionSearchTool ranking depends on.
 */
import { describe, expect, test } from 'vitest'
import { scoreHit } from '../scoring.js'

describe('scoreHit — basic shape', () => {
  test('zero termFreq + no metadata → 0', () => {
    expect(
      scoreHit({ termFreq: 0, contentLength: 0, recencyDays: 0 }),
    ).toBe(0)
  })

  test('positive termFreq → positive score', () => {
    const score = scoreHit({
      termFreq: 1,
      contentLength: 100,
      recencyDays: 0,
    })
    expect(score).toBeGreaterThan(0)
  })

  test('higher termFreq → higher score (monotone)', () => {
    const low = scoreHit({ termFreq: 1, contentLength: 100, recencyDays: 0 })
    const mid = scoreHit({ termFreq: 5, contentLength: 100, recencyDays: 0 })
    const high = scoreHit({ termFreq: 50, contentLength: 100, recencyDays: 0 })
    expect(mid).toBeGreaterThan(low)
    expect(high).toBeGreaterThan(mid)
  })

  test('termFreq saturates (BM25-like) — 1000 vs 50 are close', () => {
    const fifty = scoreHit({ termFreq: 50, contentLength: 100, recencyDays: 0 })
    const thousand = scoreHit({
      termFreq: 1000,
      contentLength: 100,
      recencyDays: 0,
    })
    // Saturation: 1000 should be < 1.05x of 50 (both near asymptote of 1)
    expect(thousand / fifty).toBeLessThan(1.05)
  })
})

describe('scoreHit — metadata boost ordering contract', () => {
  test('tag-match score > title-match score > summary-match score (same recency)', () => {
    const tagOnly = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['tag'],
      recencyDays: 0,
    })
    const titleOnly = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['title'],
      recencyDays: 0,
    })
    const customTitleOnly = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['customTitle'],
      recencyDays: 0,
    })
    const summaryOnly = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['summary'],
      recencyDays: 0,
    })
    expect(tagOnly).toBeGreaterThan(titleOnly)
    expect(tagOnly).toBeGreaterThan(customTitleOnly)
    expect(titleOnly).toBeGreaterThan(summaryOnly)
    expect(customTitleOnly).toBe(titleOnly) // both map to same boost
  })

  test('any metadata hit > pure body hit (single occurrence)', () => {
    const bodyOnly = scoreHit({
      termFreq: 1,
      contentLength: 100,
      recencyDays: 0,
    })
    const summaryOnly = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['summary'],
      recencyDays: 0,
    })
    expect(summaryOnly).toBeGreaterThan(bodyOnly)
  })

  test('multi-field metadata stacks additively', () => {
    const tagOnly = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['tag'],
      recencyDays: 0,
    })
    const tagAndTitle = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['tag', 'title'],
      recencyDays: 0,
    })
    const tagTitleSummary = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['tag', 'title', 'summary'],
      recencyDays: 0,
    })
    expect(tagAndTitle).toBeGreaterThan(tagOnly)
    expect(tagTitleSummary).toBeGreaterThan(tagAndTitle)
  })

  test('empty metadataMatches treated as no boost', () => {
    const empty = scoreHit({
      termFreq: 1,
      contentLength: 100,
      metadataMatches: [],
      recencyDays: 0,
    })
    const noField = scoreHit({
      termFreq: 1,
      contentLength: 100,
      recencyDays: 0,
    })
    expect(empty).toBe(noField)
  })
})

describe('scoreHit — recency decay', () => {
  test('newer session > older session (same other inputs)', () => {
    const today = scoreHit({
      termFreq: 5,
      contentLength: 100,
      recencyDays: 0,
    })
    const monthAgo = scoreHit({
      termFreq: 5,
      contentLength: 100,
      recencyDays: 30,
    })
    const yearAgo = scoreHit({
      termFreq: 5,
      contentLength: 100,
      recencyDays: 365,
    })
    expect(today).toBeGreaterThan(monthAgo)
    expect(monthAgo).toBeGreaterThan(yearAgo)
  })

  test('30-day halflife — score at 30 days ≈ half of fresh', () => {
    const fresh = scoreHit({
      termFreq: 5,
      contentLength: 100,
      recencyDays: 0,
    })
    const halflife = scoreHit({
      termFreq: 5,
      contentLength: 100,
      recencyDays: 30,
    })
    // 1 / (1 + 30/30) = 0.5 → halflife is exactly 50% of fresh
    expect(halflife / fresh).toBeCloseTo(0.5, 2)
  })

  test('negative recencyDays clamped to 0 (treats as fresh)', () => {
    const fresh = scoreHit({
      termFreq: 5,
      contentLength: 100,
      recencyDays: 0,
    })
    const future = scoreHit({
      termFreq: 5,
      contentLength: 100,
      recencyDays: -100,
    })
    expect(future).toBe(fresh)
  })

  test('very stale (Infinity) → score approaches 0', () => {
    const score = scoreHit({
      termFreq: 100,
      contentLength: 100,
      metadataMatches: ['tag', 'title', 'summary'],
      recencyDays: Number.POSITIVE_INFINITY,
    })
    expect(score).toBeCloseTo(0, 5)
  })
})

describe('scoreHit — combined ordering (real-world scenarios)', () => {
  test('newer body-hit can beat older tag-hit when recency gap is huge', () => {
    const newerBodyOnly = scoreHit({
      termFreq: 1,
      contentLength: 100,
      recencyDays: 0,
    })
    const veryOldTagHit = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['tag'],
      recencyDays: 365 * 5, // 5 years
    })
    // tag boost = 5.0, recency factor at 1825 days = 1/(1+60.83) ≈ 0.0162
    // → 5.0 * 0.0162 ≈ 0.081
    // body tf score for tf=1 ≈ 1/2.2 ≈ 0.455, recency 0 → 0.455 unchanged
    expect(newerBodyOnly).toBeGreaterThan(veryOldTagHit)
  })

  test('same metadata + newer wins (recency tie-break)', () => {
    const newerTag = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['tag'],
      recencyDays: 0,
    })
    const olderTag = scoreHit({
      termFreq: 0,
      contentLength: 0,
      metadataMatches: ['tag'],
      recencyDays: 7,
    })
    expect(newerTag).toBeGreaterThan(olderTag)
  })
})
