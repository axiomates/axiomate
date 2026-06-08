/**
 * `storeStatus` — read-only summary of the shadow checkpoint store.
 *
 * Backs the `/checkpoints` slash command and `axiomate checkpoints status`
 * CLI. Pure read path: no `git init`, no commits, no writes.
 * Safe to call before `ensureStore` has ever run — returns a "store
 * doesn't exist yet" shape with zeroed counts.
 *
 * Axiomate has no released pre-shadow-git checkpoint store to migrate, so
 * legacy archive fields are not part of this surface.
 *
 * Best-effort: every per-project lookup is wrapped in a soft-fail.
 * One bad ref does not knock out the whole report — the project's
 * `commits` field falls back to 0 and we keep walking. The reasoning
 * matches Hermes `store_status`::1561-1568: status is for the user to see *something*,
 * not a CI diagnostic.
 */

import { existsSync } from 'fs'
import { runCheckpointGit } from './git.js'
import { loadRecentMetrics, summarizeMetrics, type MetricsSummary } from './metrics.js'
import { getCheckpointBase, getStoreDir, refName } from './paths.js'
import { loadProjectMetas } from './projectMetas.js'
import { dirSizeBytes } from './prune.js'

/** One project's row in the status report. */
export interface StoreStatusProject {
  /** 16-hex SHA of the canonical workdir. */
  hash: string
  /** Canonical absolute workdir path as recorded at last touch. */
  workdir: string
  /** True if `workdir` still exists on disk right now. */
  exists: boolean
  /** Epoch seconds — first registration. */
  created_at: number
  /** Epoch seconds — most recent snapshot or touch. */
  last_touch: number
  /** Snapshot count under this project's ref. 0 if rev-list failed. */
  commits: number
}

export interface StoreStatusReport {
  /** Absolute path of `~/.axiomate/checkpoints/`. */
  base: string
  /** Recursive byte size of the store directory only. */
  store_size_bytes: number
  /** Recursive byte size of the entire checkpoint base. */
  total_size_bytes: number
  /** Number of registered projects. */
  project_count: number
  /** Per-project rows. Order is whatever `readdir` returned. */
  projects: StoreStatusProject[]
  /**
   * Rolling-window summary of recent `createSnapshot` outcomes.
   * Source: `metrics.jsonl` ring (≤ 100 rows). Empty file / fresh
   * install → `metrics.sample_size === 0` and percentile fields null.
   * Status renderer treats null/0-sample as "—".
   */
  metrics: MetricsSummary
}

/**
 * Build a status report. Never throws. If the base does not exist yet
 * (e.g. fresh install before any checkpoint has been written), returns
 * a zeroed report so the UI can still render.
 */
export async function storeStatus(): Promise<StoreStatusReport> {
  const base = getCheckpointBase()
  const metricRows = await loadRecentMetrics()
  const report: StoreStatusReport = {
    base,
    store_size_bytes: 0,
    total_size_bytes: 0,
    project_count: 0,
    projects: [],
    metrics: summarizeMetrics(metricRows),
  }
  if (!existsSync(base)) return report

  const store = getStoreDir()
  if (existsSync(store)) {
    report.store_size_bytes = dirSizeBytes(store)
    if (existsSync(`${store}/HEAD`)) {
      const { metas } = await loadProjectMetas()
      for (const meta of metas) {
        const ref = refName(meta.hash)
        const result = await runCheckpointGit(['rev-list', '--count', ref], {
          store,
          workTree: base,
          allowedExitCodes: new Set([128]),
        })
        let commits = 0
        if (result.ok) {
          const parsed = Number.parseInt(result.stdout.trim(), 10)
          if (Number.isFinite(parsed)) commits = parsed
        }
        report.projects.push({
          hash: meta.hash,
          workdir: meta.workdir,
          exists: meta.workdir !== '' && existsSync(meta.workdir),
          created_at: meta.created_at,
          last_touch: meta.last_touch,
          commits,
        })
      }
    }
  }
  report.project_count = report.projects.length
  report.total_size_bytes = dirSizeBytes(base)
  return report
}
