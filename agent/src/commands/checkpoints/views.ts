/**
 * Render the read-only `/checkpoints status`, `/checkpoints list`, and
 * `/checkpoints prune` views as plain text.
 *
 * Pure rendering (no IO) — input is the report shape from
 * `storeStatus` / `listSnapshots` / `pruneCheckpoints`, output is a
 * multi-line string. Kept leaf-only so the same code backs the slash
 * command, the CLI subcommand, and tests.
 *
 * Format-wise this mirrors Hermes `cmd_status` / `cmd_prune`
 * (`hermes_cli/checkpoints.py::cmd_status` / `::cmd_prune`). One
 * divergence: `legacy_size_bytes` / "Legacy archives" sections are
 * dropped — see progress doc "`clear-legacy` is NOT ported".
 */

import type { PruneReport } from '../../utils/checkpoints/prune.js'
import type {
  SnapshotEntry,
} from '../../utils/checkpoints/listSnapshots.js'
import type { StoreStatusReport } from '../../utils/checkpoints/storeStatus.js'
import {
  ellipsisLeft,
  formatAge,
  formatBytes,
  formatTimestamp,
  padLeft,
  padRight,
} from './format.js'

const WORKDIR_COL = 60
const COMMITS_COL = 7
const LAST_COL = 12

/**
 * Multi-line `/checkpoints` (no arg) and `/checkpoints status` view.
 *
 * Empty-store handling: when `project_count === 0` we still print the
 * base path and totals — mirrors Hermes 71-75 which always prints those
 * lines. Lets users sanity-check `~/.axiomate/checkpoints/` exists at all.
 */
export function renderStatus(report: StoreStatusReport, limit = 20): string {
  const lines: string[] = []
  lines.push(`Checkpoint base: ${report.base}`)
  lines.push(`Total size:      ${formatBytes(report.total_size_bytes)}`)
  lines.push(`  store/         ${formatBytes(report.store_size_bytes)}`)
  lines.push(`Projects:        ${report.project_count}`)

  if (report.projects.length === 0) {
    appendMetricsSection(lines, report)
    return lines.join('\n')
  }

  const sorted = [...report.projects].sort(
    (a, b) => (b.last_touch ?? 0) - (a.last_touch ?? 0),
  )
  lines.push('')
  lines.push(
    `  ${padRight('WORKDIR', WORKDIR_COL)}  ${padLeft('COMMITS', COMMITS_COL)}  ${padLeft('LAST TOUCH', LAST_COL)}  STATE`,
  )
  for (const p of sorted.slice(0, limit)) {
    const wd = p.workdir ? ellipsisLeft(p.workdir, WORKDIR_COL) : '(unknown)'
    const state = p.exists ? 'live' : 'orphan'
    lines.push(
      `  ${padRight(wd, WORKDIR_COL)}  ${padLeft(String(p.commits), COMMITS_COL)}  ${padLeft(formatAge(p.last_touch), LAST_COL)}  ${state}`,
    )
  }
  if (sorted.length > limit) {
    lines.push(`  … +${sorted.length - limit} more`)
  }
  appendMetricsSection(lines, report)
  return lines.join('\n')
}

/**
 * Render the rolling snapshot-metrics block.
 *
 * Hermes has no equivalent — completion-plan 6E is an axiomate-only
 * addition. We surface the rolling p50/p95 of `ok` snapshot durations
 * plus failure / no-changes / skipped-other counters, all over the
 * last ≤100 snapshots. Skipped entirely when `sample_size === 0` so
 * a fresh install doesn't show empty stats.
 *
 * Format note: `ok_p50_ms` / `ok_p95_ms` are null when the ok-sample
 * is < 2 (percentile on 0-1 points is misleading). Render those as
 * "—" rather than 0ms so users don't read "0ms p50" as "instant".
 */
function appendMetricsSection(
  lines: string[],
  report: StoreStatusReport,
): void {
  const m = report.metrics
  if (m.sample_size === 0) return
  const p50 = m.ok_p50_ms === null ? '—' : `${Math.round(m.ok_p50_ms)}ms`
  const p95 = m.ok_p95_ms === null ? '—' : `${Math.round(m.ok_p95_ms)}ms`
  lines.push('')
  lines.push(`Snapshot metrics (last ${m.sample_size}):`)
  lines.push(`  ok ${m.ok_count}, no-changes ${m.no_changes_count}, skipped ${m.skipped_other_count}, failed ${m.failure_count}`)
  lines.push(`  duration p50 ${p50}, p95 ${p95}`)
}

/**
 * Multi-line `/checkpoints list` view for one project.
 *
 * Read-only: matches Hermes' `cmd_list` which is just `cmd_status` (line
 * 106-108). Interactive rollback lives in `/rewind`, which operates on
 * the in-session `appState.fileHistory` and is the only path that keeps
 * REPL state and worktree state in sync.
 */
export function renderList(
  workdir: string,
  entries: SnapshotEntry[],
  limit = 20,
): string {
  if (entries.length === 0) {
    return [
      `No checkpoints recorded yet for ${workdir}.`,
      'Make an edit through the agent, then re-run /checkpoints list.',
    ].join('\n')
  }

  const shown = entries.slice(0, limit)
  const lines: string[] = []
  lines.push(`Checkpoints for ${workdir}:`)
  lines.push('')
  lines.push(`  ${padRight('WHEN', 17)}  ${padRight('HASH', 8)}  REASON`)
  for (const e of shown) {
    const when = formatTimestamp(parseIsoToEpochSeconds(e.timestamp))
    const reason =
      e.reason.kind === 'axiomate'
        ? `${e.reason.label}${e.reason.messageId ? ` (${e.reason.messageId.slice(0, 8)})` : ''}`
        : e.subject || '(no subject)'
    lines.push(
      `  ${padRight(when, 17)}  ${padRight(e.shortHash, 8)}  ${reason}`,
    )
  }
  if (entries.length > limit) {
    lines.push(`  … +${entries.length - limit} more`)
  }
  lines.push('')
  lines.push('Roll back to a turn with /rewind (interactive selector).')
  return lines.join('\n')
}

function parseIsoToEpochSeconds(iso: string): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? Number.NaN : t / 1000
}

/**
 * Multi-line `/checkpoints prune` report view.
 *
 * Hermes prints six fixed labels (`hermes_cli/checkpoints.py::cmd_prune`).
 * We surface the equivalent fields from PruneReport, plus axiomate-only
 * `sizeCapRefsTouched` / `sizeCapCommitsDropped` and `gcInvocations` so
 * users can see what the size-cap pass actually did.
 */
export function renderPruneReport(report: PruneReport): string {
  if (report.gitMissing) {
    return 'Checkpoints disabled: git not found on PATH.'
  }
  if (report.skipped) {
    return [
      'Skipped — prune ran less than 24h ago.',
      'Pass --force to bypass the idempotency marker.',
    ].join('\n')
  }
  const lines: string[] = []
  lines.push('Prune complete.')
  lines.push(`Orphan refs removed:    ${report.orphanRefsRemoved}`)
  lines.push(`Stale refs removed:     ${report.staleRefsRemoved}`)
  lines.push(`Size-cap refs touched:  ${report.sizeCapRefsTouched}`)
  lines.push(`Size-cap commits drop:  ${report.sizeCapCommitsDropped}`)
  lines.push(`gc invocations:         ${report.gcInvocations}`)
  lines.push(`Bytes reclaimed:        ${formatBytes(report.bytesFreed)}`)
  if (report.errors.length > 0) {
    lines.push('')
    lines.push(`Errors (${report.errors.length}):`)
    for (const e of report.errors.slice(0, 10)) lines.push(`  - ${e}`)
    if (report.errors.length > 10) {
      lines.push(`  … +${report.errors.length - 10} more`)
    }
  }
  return lines.join('\n')
}
