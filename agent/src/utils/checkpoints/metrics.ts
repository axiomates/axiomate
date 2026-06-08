/**
 * Snapshot metrics — append-only JSONL ring of recent `createSnapshot`
 * outcomes plus the pure percentile/aggregation helpers that turn that
 * file into the rolling p50/p95 + failure-count stats surfaced by
 * `/checkpoints status`.
 *
 * **Why a separate file from `~/.axiomate/debug/*`**: debug logs are
 * level-gated, may be off, and are user-invisible by default. Metrics
 * are *always* recorded (when checkpointing is enabled) and feed the
 * status UI directly. Decoupling the two means turning debug off
 * doesn't blind the status panel, and the metrics format can stay
 * stable without dragging the debug log format with it.
 *
 * **Why JSONL ring instead of in-memory only**: the agent restarts
 * between sessions and we want "rolling last 100" to mean "last 100
 * across sessions" so a fresh boot has signal immediately. Cost is
 * one append + a periodic compact when the file crosses
 * `MAX_LINES * 2`. No fancy log-rotation library — JSONL is the same
 * shape as `~/.axiomate/projects/*` files everywhere else in axiomate.
 *
 * The API is intentionally small: `recordSnapshotOutcome`,
 * `loadRecentMetrics`, and `summarizeMetrics`.
 *
 * Fail-open everywhere: a write failure cannot block a snapshot, a
 * read failure cannot block status rendering. Both paths swallow into
 * `logForDebugging`.
 */

import { existsSync } from 'fs'
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from '../debug.js'
import { getCheckpointBase, getMetricsPath } from './paths.js'

/** Bound on rows kept in the file. The compact pass keeps the most-recent N. */
export const METRICS_MAX_LINES = 100

/**
 * Compact threshold: when the on-disk row count exceeds this, drop the
 * head down to `METRICS_MAX_LINES`. 2× chosen so we're not rewriting on
 * every snapshot once we hit cap; the file grows to ~200 then halves.
 */
const METRICS_COMPACT_AT = METRICS_MAX_LINES * 2

/**
 * Outcome category — collapses `CreateSnapshotResult`'s discriminated
 * union into the buckets the status panel cares about.
 *
 *   - `ok`             — snapshot committed
 *   - `no-changes`     — workdir matched ref tip; intentional skip
 *   - `skipped-other`  — git missing / too-many-files / workdir-too-broad
 *   - `error`          — transient-error / race (the failures we want
 *                        to count for the user-facing failure_count)
 */
export type SnapshotOutcome = 'ok' | 'no-changes' | 'skipped-other' | 'error'
export type SnapshotMetricSource = 'full-snapshot' | 'prepared-tree'

export interface SnapshotMetric {
  /** Epoch ms. Kept in ms (not seconds) for sub-second ordering. */
  ts: number
  /** Wall-clock duration of the `createSnapshot` call in ms. */
  duration_ms: number
  outcome: SnapshotOutcome
  /** 16-hex project hash for filtering by project in future UIs. */
  project_hash: string
  /**
   * For `outcome === 'skipped-other'` or `'error'`, the precise reason
   * from `CreateSnapshotResult.skipped`. Empty for `ok`/`no-changes` so
   * the row stays compact.
   */
  reason?: string
  /** Source entrypoint. Missing means legacy full-snapshot row. */
  source?: SnapshotMetricSource
}

/** Rolling summary computed by `summarizeMetrics`. */
export interface MetricsSummary {
  /** Number of rows the summary was computed from (≤ METRICS_MAX_LINES). */
  sample_size: number
  /**
   * p50/p95 of `duration_ms` across rows where `outcome === 'ok'`. Null
   * when there are fewer than 2 ok rows — percentiles on 0-1 samples are
   * misleading. Status renderer shows "—" in that case.
   */
  ok_p50_ms: number | null
  ok_p95_ms: number | null
  /** Count of rows with `outcome === 'error'`. */
  failure_count: number
  /** Count of rows with `outcome === 'no-changes'`. */
  no_changes_count: number
  /** Count of rows with `outcome === 'skipped-other'`. */
  skipped_other_count: number
  /** Count of rows with `outcome === 'ok'`. */
  ok_count: number
  /** Count of rows from full snapshot entrypoints. */
  full_snapshot_count: number
  /** Count of rows from prepared-tree snapshot entrypoints. */
  prepared_tree_count: number
}

/**
 * Append a single metric to the on-disk JSONL ring. Never throws. If the
 * file crosses `METRICS_COMPACT_AT`, drops down to `METRICS_MAX_LINES`
 * lines synchronously after the append. The compact is best-effort: if
 * it fails, we keep writing — the file growing past 200 rows is a
 * cosmetic issue, not a correctness one.
 */
export async function recordSnapshotOutcome(m: SnapshotMetric): Promise<void> {
  const path = getMetricsPath()
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(m) + '\n', 'utf-8')
  } catch (e) {
    logForDebugging(
      `metrics: appendFile failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }
  await maybeCompact(path)
}

async function maybeCompact(path: string): Promise<void> {
  try {
    const content = await readFile(path, 'utf-8')
    const lines = content.split('\n').filter(l => l.length > 0)
    if (lines.length <= METRICS_COMPACT_AT) return
    const tail = lines.slice(lines.length - METRICS_MAX_LINES)
    await writeFile(path, tail.join('\n') + '\n', 'utf-8')
  } catch (e) {
    logForDebugging(
      `metrics: compact failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * Load the most recent `METRICS_MAX_LINES` rows from the metrics file.
 * Returns an empty array if the file does not exist (fresh install) or
 * cannot be read. Malformed lines (partial writes from a crash, manual
 * edits) are skipped silently — one bad row should not nuke the panel.
 */
export async function loadRecentMetrics(): Promise<SnapshotMetric[]> {
  const path = getMetricsPath()
  if (!existsSync(getCheckpointBase())) return []
  if (!existsSync(path)) return []
  let content: string
  try {
    content = await readFile(path, 'utf-8')
  } catch (e) {
    logForDebugging(
      `metrics: read failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return []
  }
  const out: SnapshotMetric[] = []
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as SnapshotMetric
      if (typeof parsed.ts !== 'number') continue
      if (typeof parsed.duration_ms !== 'number') continue
      if (typeof parsed.outcome !== 'string') continue
      if (typeof parsed.project_hash !== 'string') continue
      parsed.source = normalizeMetricSource(parsed.source)
      out.push(parsed)
    } catch {
      continue
    }
  }
  if (out.length > METRICS_MAX_LINES) {
    return out.slice(out.length - METRICS_MAX_LINES)
  }
  return out
}

/**
 * Compute p50/p95 of ok-snapshot durations and aggregate the outcome
 * counters. Pure function — exported so tests can pin behavior without
 * touching the filesystem.
 *
 * Percentile method: nearest-rank with linear interpolation on a sorted
 * copy. Standard, no library — for `n ≤ 100` the cost is negligible
 * and avoiding a dependency keeps the bundle clean. Documented as
 * "rolling sample" in the status renderer; not an SLO.
 */
function normalizeMetricSource(source: unknown): SnapshotMetricSource {
  return source === 'prepared-tree' ? 'prepared-tree' : 'full-snapshot'
}

export function summarizeMetrics(rows: readonly SnapshotMetric[]): MetricsSummary {
  let ok_count = 0
  let failure_count = 0
  let no_changes_count = 0
  let skipped_other_count = 0
  let full_snapshot_count = 0
  let prepared_tree_count = 0
  const okDurations: number[] = []
  for (const r of rows) {
    const source = normalizeMetricSource(r.source)
    if (source === 'prepared-tree') prepared_tree_count++
    else full_snapshot_count++

    switch (r.outcome) {
      case 'ok':
        ok_count++
        if (
          source === 'full-snapshot' &&
          Number.isFinite(r.duration_ms) &&
          r.duration_ms >= 0
        ) {
          okDurations.push(r.duration_ms)
        }
        break
      case 'error':
        failure_count++
        break
      case 'no-changes':
        no_changes_count++
        break
      case 'skipped-other':
        skipped_other_count++
        break
    }
  }
  okDurations.sort((a, b) => a - b)
  return {
    sample_size: rows.length,
    ok_p50_ms: okDurations.length >= 2 ? percentile(okDurations, 0.5) : null,
    ok_p95_ms: okDurations.length >= 2 ? percentile(okDurations, 0.95) : null,
    failure_count,
    no_changes_count,
    skipped_other_count,
    ok_count,
    full_snapshot_count,
    prepared_tree_count,
  }
}

/**
 * Linear-interpolated percentile. `sorted` MUST be ascending.
 * `q` ∈ [0, 1]. For `n=2, q=0.95` returns sorted[1] (rank 1.9 → ceil 1).
 * Matches numpy's `linear` interpolation on small inputs, which is
 * what most "p50/p95" mental models implicitly assume.
 */
function percentile(sorted: readonly number[], q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0]!
  const rank = q * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]!
  const frac = rank - lo
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac
}

/**
 * Test-only: drop the on-disk metrics file. Production code MUST NOT
 * call this — `recordSnapshotOutcome` already self-compacts.
 */
export async function _resetMetricsForTesting(): Promise<void> {
  const path = getMetricsPath()
  if (!existsSync(path)) return
  try {
    await writeFile(path, '', 'utf-8')
  } catch (e) {
    logForDebugging(
      `metrics: reset failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}
