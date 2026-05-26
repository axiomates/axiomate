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
import { logForDebugging } from '../../utils/debug.js'
import { formatAnchorReason } from '../../utils/checkpoints/reason.js'
import {
  ellipsisLeft,
  formatAgeOrAbsolute,
  formatBytes,
  padLeft,
  padRight,
} from './format.js'

const WORKDIR_COL = 60
const COMMITS_COL = 7
const LAST_COL = 16 // fits adaptive timestamp shape "2026-05-24 09:42"

/**
 * Multi-line `/checkpoints` (no arg) and `/checkpoints status` view.
 *
 * Empty-store handling: when `project_count === 0` we still print the
 * base path and totals — mirrors Hermes `cmd_status`::71-75 which always prints those
 * lines. Lets users sanity-check `~/.axiomate/checkpoints/` exists at all.
 */
export function renderStatus(report: StoreStatusReport, limit = 30): string {
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
      `  ${padRight(wd, WORKDIR_COL)}  ${padLeft(String(p.commits), COMMITS_COL)}  ${padLeft(formatAgeOrAbsolute(p.last_touch), LAST_COL)}  ${state}`,
    )
  }
  if (sorted.length > limit) {
    lines.push(`  … +${sorted.length - limit} more`)
  }
  appendOrphanReachabilityWarning(lines, sorted)
  appendMetricsSection(lines, report)
  return lines.join('\n')
}

/**
 * Surface the cross-worktree reachability hole as a single status line.
 *
 * Completion-plan 6C2 (the "fallback" path): we don't anchor refs across
 * worktrees, so when a project's workdir disappears, its `refs/axiomate/
 * <hash>` ref is the *only* anchor for those commits. The next
 * `pruneCheckpoints` orphan pass will drop the ref and gc will reclaim
 * the objects — at which point any resumed session pinned to one of those
 * commits gets a "missing object" failure on `/rewind`.
 *
 * Surfacing this in `/checkpoints status` lets the user notice and
 * either copy the workdir back into place or accept the loss before the
 * next prune. Matches Hermes' general pattern of preferring visibility
 * over silent data loss (`tools/checkpoint_manager.py::_prune_orphan_refs`
 * logs each orphan ref it removes).
 *
 * Skipped when no orphan workdir has any commits — common case on a
 * tidy install where every registered project still exists on disk.
 */
function appendOrphanReachabilityWarning(
  lines: string[],
  projects: readonly StoreStatusReport['projects'][number][],
): void {
  const orphans = projects.filter(p => !p.exists && p.commits > 0)
  if (orphans.length === 0) return
  const totalCommits = orphans.reduce((sum, p) => sum + p.commits, 0)
  lines.push('')
  lines.push(
    `Note: ${totalCommits} snapshot${totalCommits === 1 ? '' : 's'} from ${orphans.length} orphan workdir${orphans.length === 1 ? '' : 's'} will be discarded on next prune.`,
  )
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
  // Map<gitHash, DiffStats> from bulkDiffEventStats. Each entry
  // describes "what THIS row's turn wrote" — anchor[i] vs anchor[i-1]
  // for older rows, anchor[0] vs disk for the newest. Same data the
  // picker uses. The earlier implementation copied per-anchor
  // commit-vs-parent stats from SnapshotEntry, which was off-by-one
  // (each row described what the PRIOR turn did) and showed empty
  // for root commits.
  diskDiffs: Map<
    string,
    | { filesChanged?: string[]; insertions: number; deletions: number }
    | undefined
  >,
  limit = 30,
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

  // Column order: WHEN  ID  CHANGES  TURN. TURN sits last because it
  // contains free-form text (CJK, quotes, long previews) — putting it
  // at the line end means we never have to compute terminal-display-
  // width for padding. JS .length and CJK char width disagree by 2x,
  // which broke alignment in the prior layout.
  //
  // Two-pass render: pre-compute each cell, then size each column to
  // its widest cell (capped at COL_MAX so a single long path can't
  // explode the layout). Earlier this was hard-coded at fixed-width
  // worst-case sizes (16 / 8 / 24), which left huge gaps when actual
  // content was short — "5m ago" took up "16 chars + 2 padding"
  // regardless. Dynamic widths give a uniform 2-space gutter between
  // every column.
  const COL_MAX = 32
  const COL_GAP = '  '
  type Row = { when: string; id: string; stats: string; turn: string }
  const rows: Row[] = []
  for (const e of shown) {
    const when = formatAgeOrAbsolute(parseIsoToEpochSeconds(e.timestamp))
    const reason = formatAnchorReason(e.subject, e.body)
    // CHANGES column: anchor-vs-disk diff (matches picker semantics).
    //   - 1 file → "<basename> +N -M"
    //   - 2+ files → "<count> files +N -M"
    //   - 0 changes → "(no diff)" so users can tell the row is
    //     intentionally empty rather than a rendering glitch
    let stats = '(no diff)'
    const diff = diskDiffs.get(e.hash)
    if (diff && diff.filesChanged && diff.filesChanged.length > 0) {
      const paths = diff.filesChanged
      if (paths.length === 1) {
        const fp = paths[0] ?? ''
        const slash = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'))
        const base = slash >= 0 ? fp.slice(slash + 1) : fp
        stats = `${base} +${diff.insertions} -${diff.deletions}`
      } else {
        stats = `${paths.length} files +${diff.insertions} -${diff.deletions}`
      }
    }
    rows.push({ when, id: e.shortHash, stats, turn: reason })
    // Full commit hash + message UUID still go to the debug log for
    // diagnosis (--debug mode). The user-visible ID column shows
    // shortHash only since git CLI accepts it; full hash is rarely
    // needed for tooling beyond the rare bisect.
    logForDebugging(
      `checkpoints/list: row hash=${e.hash} shortHash=${e.shortHash} ` +
        `messageId=${e.reason.kind === 'axiomate' ? e.reason.messageId : '(raw)'} ` +
        `subject=${e.subject}`,
    )
  }

  const headers = { when: 'WHEN', id: 'ID', stats: 'CHANGES', turn: 'TURN' }
  const widths = {
    when: Math.min(
      COL_MAX,
      Math.max(headers.when.length, ...rows.map(r => r.when.length)),
    ),
    id: Math.min(
      COL_MAX,
      Math.max(headers.id.length, ...rows.map(r => r.id.length)),
    ),
    stats: Math.min(
      COL_MAX,
      Math.max(headers.stats.length, ...rows.map(r => r.stats.length)),
    ),
  }

  lines.push(
    `  ${padRight(headers.when, widths.when)}${COL_GAP}${padRight(headers.id, widths.id)}${COL_GAP}${padRight(headers.stats, widths.stats)}${COL_GAP}${headers.turn}`,
  )
  for (const r of rows) {
    lines.push(
      `  ${padRight(r.when, widths.when)}${COL_GAP}${padRight(r.id, widths.id)}${COL_GAP}${padRight(r.stats, widths.stats)}${COL_GAP}${r.turn}`,
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
 * `snapshotCapRefsTouched` / `snapshotCapCommitsDropped` (only printed
 * when the snapshot-count pass actually fired) /
 * `sizeCapRefsTouched` / `sizeCapCommitsDropped` and `gcInvocations` so
 * users can see what the snapshot- and size-cap passes actually did.
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
  if (report.orphanRefsSkipped > 0) {
    lines.push(`Orphan refs skipped:    ${report.orphanRefsSkipped}`)
  }
  lines.push(`Stale refs removed:     ${report.staleRefsRemoved}`)
  if (report.snapshotCapRefsTouched > 0 || report.snapshotCapCommitsDropped > 0) {
    lines.push(`Snap-cap refs touched:  ${report.snapshotCapRefsTouched}`)
    lines.push(`Snap-cap commits drop:  ${report.snapshotCapCommitsDropped}`)
  }
  lines.push(`Size-cap refs touched:  ${report.sizeCapRefsTouched}`)
  lines.push(`Size-cap commits drop:  ${report.sizeCapCommitsDropped}`)
  if (report.keepRefsAnchored > 0 || report.keepRefsExpired > 0) {
    lines.push(`Keep-refs anchored:     ${report.keepRefsAnchored}`)
    lines.push(`Keep-refs expired:      ${report.keepRefsExpired}`)
  }
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
