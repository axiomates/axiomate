/**
 * Behavior tests for `/checkpoints` view renderers and sub-arg parser.
 *
 * Pure tests — no IO, no real store. Pin:
 *   - empty/zero report renders without crashing
 *   - populated report shows the project rows
 *   - prune report formats with and without errors
 *   - skipped/git-missing prune branches surface correctly
 *   - parseSub maps args to the four sub-commands
 *   - list view shows the /rewind hint and short hashes
 */

import { describe, expect, test } from 'vitest'
import type { PruneReport } from '../../../../utils/checkpoints/prune.js'
import type { SnapshotEntry } from '../../../../utils/checkpoints/listSnapshots.js'
import type { StoreStatusReport } from '../../../../utils/checkpoints/storeStatus.js'
import { _internal } from '../../../../commands/checkpoints/checkpoints.js'
import {
  renderList,
  renderPruneReport,
  renderStatus,
} from '../../../../commands/checkpoints/views.js'

const { parseSub } = _internal

function emptyStatus(): StoreStatusReport {
  return {
    base: '/tmp/axiomate-base',
    store_size_bytes: 0,
    total_size_bytes: 0,
    project_count: 0,
    projects: [],
    metrics: {
      sample_size: 0,
      ok_p50_ms: null,
      ok_p95_ms: null,
      failure_count: 0,
      no_changes_count: 0,
      skipped_other_count: 0,
      ok_count: 0,
    },
  }
}

function snapshot(
  override: Partial<SnapshotEntry> = {},
): SnapshotEntry {
  return {
    hash: 'a'.repeat(40),
    shortHash: 'a1b2c3d',
    timestamp: '2026-05-21T14:30:00+00:00',
    subject: 'axiomate:m_42:edit',
    reason: { kind: 'axiomate', messageId: 'm_42', label: 'edit' },
    body: '',
    filesChanged: 1,
    filePaths: ['src/foo.ts'],
    insertions: 2,
    deletions: 0,
    ...override,
  }
}

describe('parseSub', () => {
  test('empty arg → status', () => {
    expect(parseSub('')).toEqual({ sub: 'status', rest: '' })
  })
  test('whitespace-only → status', () => {
    expect(parseSub('   ')).toEqual({ sub: 'status', rest: '' })
  })
  test('explicit status', () => {
    expect(parseSub('status')).toEqual({ sub: 'status', rest: '' })
  })
  test('list / prune / clear all recognized', () => {
    expect(parseSub('list')).toEqual({ sub: 'list', rest: '' })
    expect(parseSub('prune')).toEqual({ sub: 'prune', rest: '' })
    expect(parseSub('clear')).toEqual({ sub: 'clear', rest: '' })
  })
  test('prune with --force passes the flag through rest', () => {
    expect(parseSub('prune --force')).toEqual({
      sub: 'prune',
      rest: '--force',
    })
  })
  test('unknown sub returns error', () => {
    const out = parseSub('frobnicate')
    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error).toMatch(/Unknown subcommand: frobnicate/)
      expect(out.error).toMatch(/status, list, prune, clear/)
    }
  })
})

describe('renderStatus', () => {
  test('empty store: prints base + zero counts, no project rows', () => {
    const out = renderStatus(emptyStatus())
    expect(out).toContain('Checkpoint base: /tmp/axiomate-base')
    expect(out).toContain('Projects:        0')
    expect(out).not.toContain('WORKDIR')
  })

  test('populated store: shows headers + per-project rows', () => {
    const report: StoreStatusReport = {
      base: '/tmp/axiomate-base',
      store_size_bytes: 12345,
      total_size_bytes: 12345,
      project_count: 2,
      projects: [
        {
          hash: '0000000000000001',
          workdir: '/work/a',
          exists: true,
          created_at: 1700000000,
          last_touch: 1716000000,
          commits: 3,
        },
        {
          hash: '0000000000000002',
          workdir: '/work/b',
          exists: false,
          created_at: 1700000000,
          last_touch: 1715000000,
          commits: 1,
        },
      ],
      metrics: {
        sample_size: 0,
        ok_p50_ms: null,
        ok_p95_ms: null,
        failure_count: 0,
        no_changes_count: 0,
        skipped_other_count: 0,
        ok_count: 0,
      },
    }
    const out = renderStatus(report)
    expect(out).toContain('WORKDIR')
    expect(out).toContain('/work/a')
    expect(out).toContain('/work/b')
    expect(out).toContain('live')
    expect(out).toContain('orphan')
  })

  test('long workdir is truncated with leading ellipsis', () => {
    const longPath = '/' + 'segment/'.repeat(20) + 'leaf'
    const report: StoreStatusReport = {
      ...emptyStatus(),
      project_count: 1,
      projects: [
        {
          hash: '0000000000000001',
          workdir: longPath,
          exists: true,
          created_at: 1700000000,
          last_touch: 1716000000,
          commits: 1,
        },
      ],
    }
    const out = renderStatus(report)
    expect(out).toContain('…')
    expect(out).toContain('leaf')
  })

  test('metrics block hidden when sample_size is zero', () => {
    const out = renderStatus(emptyStatus())
    expect(out).not.toContain('Snapshot metrics')
    expect(out).not.toContain('p50')
  })

  test('metrics block shows counts + percentiles when sample_size > 0', () => {
    const report: StoreStatusReport = {
      ...emptyStatus(),
      metrics: {
        sample_size: 25,
        ok_p50_ms: 42.4,
        ok_p95_ms: 187.6,
        failure_count: 1,
        no_changes_count: 4,
        skipped_other_count: 0,
        ok_count: 20,
      },
    }
    const out = renderStatus(report)
    expect(out).toContain('Snapshot metrics (last 25)')
    expect(out).toContain('ok 20')
    expect(out).toContain('failed 1')
    expect(out).toContain('no-changes 4')
    expect(out).toContain('p50 42ms')
    expect(out).toContain('p95 188ms')
  })

  test('metrics block dashes when sample exists but ok-percentiles null', () => {
    const report: StoreStatusReport = {
      ...emptyStatus(),
      metrics: {
        sample_size: 5,
        ok_p50_ms: null,
        ok_p95_ms: null,
        failure_count: 0,
        no_changes_count: 5,
        skipped_other_count: 0,
        ok_count: 0,
      },
    }
    const out = renderStatus(report)
    expect(out).toContain('Snapshot metrics (last 5)')
    expect(out).toContain('p50 —')
    expect(out).toContain('p95 —')
  })

  test('orphan reachability warning shown when orphan workdir has commits', () => {
    const report: StoreStatusReport = {
      ...emptyStatus(),
      project_count: 2,
      projects: [
        {
          hash: '0000000000000001',
          workdir: '/work/live',
          exists: true,
          created_at: 1700000000,
          last_touch: 1716000000,
          commits: 4,
        },
        {
          hash: '0000000000000002',
          workdir: '/work/gone',
          exists: false,
          created_at: 1700000000,
          last_touch: 1715000000,
          commits: 7,
        },
      ],
    }
    const out = renderStatus(report)
    expect(out).toMatch(/7 snapshots from 1 orphan workdir/)
    expect(out).toMatch(/discarded on next prune/)
  })

  test('orphan reachability warning aggregates across multiple orphans', () => {
    const report: StoreStatusReport = {
      ...emptyStatus(),
      project_count: 2,
      projects: [
        {
          hash: '0000000000000001',
          workdir: '/work/gone-a',
          exists: false,
          created_at: 1700000000,
          last_touch: 1715000000,
          commits: 3,
        },
        {
          hash: '0000000000000002',
          workdir: '/work/gone-b',
          exists: false,
          created_at: 1700000000,
          last_touch: 1715000000,
          commits: 2,
        },
      ],
    }
    const out = renderStatus(report)
    expect(out).toMatch(/5 snapshots from 2 orphan workdirs/)
  })

  test('orphan with zero commits does not trigger warning', () => {
    const report: StoreStatusReport = {
      ...emptyStatus(),
      project_count: 1,
      projects: [
        {
          hash: '0000000000000001',
          workdir: '/work/gone',
          exists: false,
          created_at: 1700000000,
          last_touch: 1715000000,
          commits: 0,
        },
      ],
    }
    const out = renderStatus(report)
    expect(out).not.toMatch(/discarded on next prune/)
  })

  test('all-live projects: no orphan reachability warning', () => {
    const report: StoreStatusReport = {
      ...emptyStatus(),
      project_count: 1,
      projects: [
        {
          hash: '0000000000000001',
          workdir: '/work/live',
          exists: true,
          created_at: 1700000000,
          last_touch: 1716000000,
          commits: 9,
        },
      ],
    }
    const out = renderStatus(report)
    expect(out).not.toMatch(/discarded on next prune/)
  })
})

describe('renderList', () => {
  // Empty diskDiffs map is the most common test case — covers the
  // "anchor exists, but no anchor-vs-disk diff was computed" path.
  // Callers that want to exercise the CHANGES column pass a Map
  // with hash → DiffStats.
  const noDiffs = new Map()

  test('no entries: shows "no checkpoints" message', () => {
    const out = renderList('/work/a', [], noDiffs)
    expect(out).toContain('No checkpoints recorded yet')
    expect(out).toContain('/work/a')
  })

  test('axiomate-style reason: shows label + short messageId; hash visible in ID column', () => {
    const out = renderList('/work/a', [snapshot()], noDiffs)
    // Reason text comes from formatAnchorReason (single-source codec).
    expect(out).toContain('edit')
    expect(out).toContain('m_42')
    // Short hash now surfaces in the ID column — users plug it into
    // external git commands against the shadow store.
    expect(out).toContain('a1b2c3d')
  })

  test('raw reason: falls back to subject text', () => {
    const out = renderList(
      '/work/a',
      [
        snapshot({
          reason: { kind: 'raw', subject: 'manual git commit' },
          subject: 'manual git commit',
        }),
      ],
      noDiffs,
    )
    expect(out).toContain('manual git commit')
  })

  test('always points users at /rewind for interactive rollback', () => {
    const out = renderList('/work/a', [snapshot()], noDiffs)
    expect(out).toContain('/rewind')
  })

  test('CHANGES column shows file basename when 1 file changed', () => {
    const e = snapshot()
    const diffs = new Map([
      [e.hash, { filesChanged: ['src/foo.ts'], insertions: 5, deletions: 2 }],
    ])
    const out = renderList('/work/a', [e], diffs)
    expect(out).toContain('foo.ts +5 -2')
    expect(out).not.toContain('src/') // basename only
  })

  test('CHANGES column collapses to "N files" when 2+ files changed', () => {
    const e = snapshot()
    const diffs = new Map([
      [e.hash, { filesChanged: ['a.ts', 'b.ts', 'c.ts'], insertions: 8, deletions: 3 }],
    ])
    const out = renderList('/work/a', [e], diffs)
    expect(out).toContain('3 files +8 -3')
  })

  test('CHANGES column shows "(no diff)" when anchor matches disk', () => {
    const e = snapshot()
    const diffs = new Map([[e.hash, { filesChanged: [], insertions: 0, deletions: 0 }]])
    const out = renderList('/work/a', [e], diffs)
    expect(out).toContain('(no diff)')
  })

  test('CHANGES column shows "(no diff)" when anchor missing from diffs map', () => {
    // Defensive case: bulk diff fetch may skip an anchor on transient
    // git failure; the row still renders, just without a diff.
    const out = renderList('/work/a', [snapshot()], noDiffs)
    expect(out).toContain('(no diff)')
  })
})

describe('renderPruneReport', () => {
  function emptyReport(): PruneReport {
    return {
      orphanRefsRemoved: 0,
      orphanRefsSkipped: 0,
      staleRefsRemoved: 0,
      snapshotCapRefsTouched: 0,
      snapshotCapCommitsDropped: 0,
      sizeCapRefsTouched: 0,
      sizeCapCommitsDropped: 0,
      keepRefsAnchored: 0,
      keepRefsExpired: 0,
      sessionsScanned: 0,
      gcInvocations: 0,
      bytesFreed: 0,
      errors: [],
      skipped: false,
      gitMissing: false,
    }
  }

  test('git missing branch', () => {
    const out = renderPruneReport({ ...emptyReport(), gitMissing: true })
    expect(out).toMatch(/git not found/)
  })

  test('skipped (idempotency window) branch', () => {
    const out = renderPruneReport({ ...emptyReport(), skipped: true })
    expect(out).toMatch(/Skipped/)
    expect(out).toMatch(/--force/)
  })

  test('happy path with errors trimmed', () => {
    const out = renderPruneReport({
      ...emptyReport(),
      orphanRefsRemoved: 3,
      staleRefsRemoved: 1,
      bytesFreed: 4096,
      errors: Array.from({ length: 12 }, (_, i) => `err ${i}`),
    })
    expect(out).toMatch(/Orphan refs removed:    3/)
    expect(out).toMatch(/Stale refs removed:     1/)
    expect(out).toMatch(/Errors \(12\)/)
    expect(out).toContain('err 0')
    expect(out).toContain('+2 more')
  })

  test('orphanRefsSkipped row hidden when zero', () => {
    const out = renderPruneReport(emptyReport())
    expect(out).not.toMatch(/Orphan refs skipped/)
  })

  test('orphanRefsSkipped surfaces when --keep-orphans fired', () => {
    const out = renderPruneReport({
      ...emptyReport(),
      orphanRefsRemoved: 0,
      orphanRefsSkipped: 4,
      staleRefsRemoved: 1,
    })
    expect(out).toMatch(/Orphan refs removed:    0/)
    expect(out).toMatch(/Orphan refs skipped:    4/)
    expect(out).toMatch(/Stale refs removed:     1/)
  })
})

describe('formatAgeOrAbsolute', () => {
  test('< 1 min → "just now"', async () => {
    const { formatAgeOrAbsolute } = await import('../../../../commands/checkpoints/format.js')
    const now = Date.now() / 1000
    expect(formatAgeOrAbsolute(now - 30)).toBe('just now')
  })

  test('< 1 h → "Nm ago"', async () => {
    const { formatAgeOrAbsolute } = await import('../../../../commands/checkpoints/format.js')
    const now = Date.now() / 1000
    expect(formatAgeOrAbsolute(now - 5 * 60)).toBe('5m ago')
    expect(formatAgeOrAbsolute(now - 59 * 60)).toBe('59m ago')
  })

  test('< 24 h → "Nh ago"', async () => {
    const { formatAgeOrAbsolute } = await import('../../../../commands/checkpoints/format.js')
    const now = Date.now() / 1000
    expect(formatAgeOrAbsolute(now - 3 * 3600)).toBe('3h ago')
    expect(formatAgeOrAbsolute(now - 23 * 3600)).toBe('23h ago')
  })

  test('≥ 24 h → absolute timestamp', async () => {
    const { formatAgeOrAbsolute } = await import('../../../../commands/checkpoints/format.js')
    const now = Date.now() / 1000
    // Old enough to switch to absolute. Match the timestamp shape
    // rather than an exact value (Date formatting is timezone-aware).
    const out = formatAgeOrAbsolute(now - 30 * 86400)
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  test('non-finite input → em dash', async () => {
    const { formatAgeOrAbsolute } = await import('../../../../commands/checkpoints/format.js')
    expect(formatAgeOrAbsolute(NaN)).toBe('—')
    expect(formatAgeOrAbsolute(Infinity)).toBe('—')
  })
})
