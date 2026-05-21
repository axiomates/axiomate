/**
 * Behavior tests for the snapshot-metrics ring + summarizer.
 *
 * Two halves:
 *   1. Pure `summarizeMetrics` cases (no IO) — pin percentile math
 *      and outcome counters across edge cases (empty, all-error,
 *      mixed, single-ok which should yield null percentiles).
 *   2. On-disk ring: `recordSnapshotOutcome` appends, `loadRecentMetrics`
 *      reads, malformed lines are skipped, the file compacts when it
 *      grows past `METRICS_COMPACT_AT`.
 *
 * The on-disk half uses `AXIOMATE_CHECKPOINT_BASE` to redirect the
 * metrics path into a tmpdir per test, matching every other checkpoint
 * test in this directory.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest'
import {
  METRICS_MAX_LINES,
  loadRecentMetrics,
  recordSnapshotOutcome,
  summarizeMetrics,
  type SnapshotMetric,
} from '../metrics.js'
import { getMetricsPath } from '../paths.js'

let tmpRoot: string
let baseEnvBefore: string | undefined

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-metrics-'))
  baseEnvBefore = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (baseEnvBefore === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = baseEnvBefore
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  const fresh = mkdtempSync(join(tmpRoot, 'base-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = fresh
})

afterEach(() => {
  delete process.env.AXIOMATE_CHECKPOINT_BASE
})

function row(over: Partial<SnapshotMetric> = {}): SnapshotMetric {
  return {
    ts: 1_700_000_000_000,
    duration_ms: 50,
    outcome: 'ok',
    project_hash: 'a'.repeat(16),
    ...over,
  }
}

describe('summarizeMetrics', () => {
  test('empty input → all-zero summary, percentiles null', () => {
    const s = summarizeMetrics([])
    expect(s.sample_size).toBe(0)
    expect(s.ok_count).toBe(0)
    expect(s.failure_count).toBe(0)
    expect(s.ok_p50_ms).toBeNull()
    expect(s.ok_p95_ms).toBeNull()
  })

  test('single ok → percentiles null (n<2 → "—" rendering)', () => {
    const s = summarizeMetrics([row({ duration_ms: 100 })])
    expect(s.ok_count).toBe(1)
    expect(s.ok_p50_ms).toBeNull()
    expect(s.ok_p95_ms).toBeNull()
  })

  test('two ok rows → linear-interp p50 = midpoint, p95 ~ second value', () => {
    const s = summarizeMetrics([
      row({ duration_ms: 10 }),
      row({ duration_ms: 100 }),
    ])
    expect(s.ok_p50_ms).toBe(55)
    expect(s.ok_p95_ms).toBeCloseTo(95.5, 5)
  })

  test('outcome counters bucket correctly', () => {
    const s = summarizeMetrics([
      row({ outcome: 'ok' }),
      row({ outcome: 'ok' }),
      row({ outcome: 'no-changes' }),
      row({ outcome: 'no-changes' }),
      row({ outcome: 'skipped-other', reason: 'too-many-files' }),
      row({ outcome: 'error', reason: 'transient-error' }),
    ])
    expect(s.sample_size).toBe(6)
    expect(s.ok_count).toBe(2)
    expect(s.no_changes_count).toBe(2)
    expect(s.skipped_other_count).toBe(1)
    expect(s.failure_count).toBe(1)
  })

  test('non-ok rows do not contaminate p50/p95', () => {
    const s = summarizeMetrics([
      row({ outcome: 'ok', duration_ms: 10 }),
      row({ outcome: 'ok', duration_ms: 20 }),
      row({ outcome: 'error', duration_ms: 9999 }),
    ])
    expect(s.ok_p50_ms).toBe(15)
    expect(s.ok_p95_ms).toBeCloseTo(19.5, 5)
  })

  test('non-finite duration on ok is dropped, not coerced', () => {
    const s = summarizeMetrics([
      row({ outcome: 'ok', duration_ms: NaN }),
      row({ outcome: 'ok', duration_ms: 100 }),
      row({ outcome: 'ok', duration_ms: 200 }),
    ])
    expect(s.ok_count).toBe(3)
    expect(s.ok_p50_ms).toBe(150)
  })
})

describe('on-disk ring', () => {
  test('record then load round-trips one row', async () => {
    await recordSnapshotOutcome(row({ duration_ms: 42 }))
    const loaded = await loadRecentMetrics()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.duration_ms).toBe(42)
  })

  test('malformed JSONL lines are skipped, valid rows survive', async () => {
    const path = getMetricsPath()
    await recordSnapshotOutcome(row({ duration_ms: 1 }))
    const original = readFileSync(path, 'utf-8')
    writeFileSync(
      path,
      original + 'not-json\n' + JSON.stringify({ ts: 'not a number' }) + '\n',
      'utf-8',
    )
    await recordSnapshotOutcome(row({ duration_ms: 99 }))
    const loaded = await loadRecentMetrics()
    expect(loaded.map(r => r.duration_ms)).toEqual([1, 99])
  })

  test('compaction trims to MAX_LINES once past 2x threshold', async () => {
    for (let i = 0; i < METRICS_MAX_LINES * 2 + 5; i++) {
      await recordSnapshotOutcome(row({ duration_ms: i }))
    }
    const loaded = await loadRecentMetrics()
    expect(loaded.length).toBeLessThanOrEqual(METRICS_MAX_LINES)
    // The most-recent row must be present (compact preserves the tail).
    const last = loaded[loaded.length - 1]!
    expect(last.duration_ms).toBe(METRICS_MAX_LINES * 2 + 4)
  })

  test('fresh install (no metrics file) → empty array, no throw', async () => {
    expect(existsSync(getMetricsPath())).toBe(false)
    const loaded = await loadRecentMetrics()
    expect(loaded).toEqual([])
  })
})
