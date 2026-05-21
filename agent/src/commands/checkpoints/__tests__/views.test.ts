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
import type { PruneReport } from '../../../utils/checkpoints/prune.js'
import type { SnapshotEntry } from '../../../utils/checkpoints/listSnapshots.js'
import type { StoreStatusReport } from '../../../utils/checkpoints/storeStatus.js'
import { _internal } from '../checkpoints.js'
import {
  renderList,
  renderPruneReport,
  renderStatus,
} from '../views.js'

const { parseSub } = _internal

function emptyStatus(): StoreStatusReport {
  return {
    base: '/tmp/axiomate-base',
    store_size_bytes: 0,
    total_size_bytes: 0,
    project_count: 0,
    projects: [],
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
    filesChanged: 1,
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
})

describe('renderList', () => {
  test('no entries: shows "no checkpoints" message', () => {
    const out = renderList('/work/a', [])
    expect(out).toContain('No checkpoints recorded yet')
    expect(out).toContain('/work/a')
  })

  test('axiomate-style reason: shows label + short messageId', () => {
    const out = renderList('/work/a', [snapshot()])
    expect(out).toContain('a1b2c3d')
    expect(out).toContain('edit')
    expect(out).toContain('m_42')
  })

  test('raw reason: falls back to subject text', () => {
    const out = renderList('/work/a', [
      snapshot({
        reason: { kind: 'raw', subject: 'manual git commit' },
        subject: 'manual git commit',
      }),
    ])
    expect(out).toContain('manual git commit')
  })

  test('always points users at /rewind for interactive rollback', () => {
    const out = renderList('/work/a', [snapshot()])
    expect(out).toContain('/rewind')
  })
})

describe('renderPruneReport', () => {
  function emptyReport(): PruneReport {
    return {
      orphanRefsRemoved: 0,
      staleRefsRemoved: 0,
      sizeCapRefsTouched: 0,
      sizeCapCommitsDropped: 0,
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
})
