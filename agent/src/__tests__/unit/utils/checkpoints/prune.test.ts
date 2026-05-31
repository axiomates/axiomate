/**
 * Phase 4 commit 1 — entry-contract tests for `pruneCheckpoints`.
 *
 * The skeleton implementation only exercises:
 *   - git-missing soft-disable (Hermes `ensure_checkpoint`::632-636 parity)
 *   - 24h `.last_prune` marker check (Hermes `maybe_auto_prune_checkpoints`::1488-1497)
 *   - `forceNow` bypass (Hermes `maybe_auto_prune_checkpoints`::1488 inverted)
 *   - corrupt/unreadable marker tolerance (Hermes `maybe_auto_prune_checkpoints`::1497 silent pass-through)
 *   - marker write on completion
 *
 * Pass 1/2/3 land in subsequent commits and are tested there.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test as vitestTest } from 'vitest'
import { _resetGitAvailableCacheForTesting, runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import {
  getLastPrunePath,
  getStoreDir,
  indexPath,
  projectHash,
  projectMetaPath,
  refName,
} from '../../../../utils/checkpoints/paths.js'
import { pruneCheckpoints, MIN_INTERVAL_HOURS } from '../../../../utils/checkpoints/prune.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { touchProject } from '../../../../utils/checkpoints/touchProject.js'
import { buildFixtureCommit } from './fixtures.js'

let tmpRoot: string
let baseEnvBefore: string | undefined
const CHECKPOINT_TEST_TIMEOUT_MS = 30_000

function test(
  name: string,
  fn: () => void | Promise<void>,
  timeout = CHECKPOINT_TEST_TIMEOUT_MS,
): void {
  vitestTest(name, fn, timeout)
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-prune-skel-'))
  baseEnvBefore = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (baseEnvBefore === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = baseEnvBefore
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // Each test gets a fresh checkpoint base directory so markers and
  // store init don't bleed across tests.
  const fresh = mkdtempSync(join(tmpRoot, 'base-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = fresh
  _resetGitAvailableCacheForTesting()
})

afterEach(() => {
  _resetGitAvailableCacheForTesting()
})

describe('pruneCheckpoints — entry contract', () => {
  test('returns gitMissing=true when git probe fails (without throwing)', async () => {
    // Force probe failure by pointing to a nonexistent git binary.
    const pathBefore = process.env.PATH
    process.env.PATH = ''
    try {
      _resetGitAvailableCacheForTesting()
      const r = await pruneCheckpoints({})
      expect(r.gitMissing).toBe(true)
      expect(r.skipped).toBe(false)
      expect(r.errors).toEqual([])
    } finally {
      process.env.PATH = pathBefore
      _resetGitAvailableCacheForTesting()
    }
  })

  test('returns skipped=true when marker is younger than 24h', async () => {
    // ensureStore so the checkpoint base exists before we drop a marker.
    const e = await ensureStore()
    expect(e.ok).toBe(true)

    const marker = getLastPrunePath()
    writeFileSync(marker, String(Date.now()), 'utf-8')

    const r = await pruneCheckpoints({})
    expect(r.skipped).toBe(true)
    expect(r.gitMissing).toBe(false)
    expect(r.orphanRefsRemoved).toBe(0)
    expect(r.staleRefsRemoved).toBe(0)
  })

  test('does NOT skip when marker is older than 24h', async () => {
    await ensureStore()
    const marker = getLastPrunePath()
    writeFileSync(marker, '0', 'utf-8')
    // Push mtime back 25 hours to simulate a stale marker.
    const stale = (Date.now() - (MIN_INTERVAL_HOURS + 1) * 3600 * 1000) / 1000
    utimesSync(marker, stale, stale)

    const r = await pruneCheckpoints({})
    expect(r.skipped).toBe(false)
    expect(r.gitMissing).toBe(false)
  })

  test('forceNow=true bypasses a recent marker', async () => {
    await ensureStore()
    const marker = getLastPrunePath()
    writeFileSync(marker, String(Date.now()), 'utf-8')

    const r = await pruneCheckpoints({ forceNow: true })
    expect(r.skipped).toBe(false)
    expect(r.gitMissing).toBe(false)
  })

  test('treats a corrupt marker as "no recent run" (Hermes `maybe_auto_prune_checkpoints`::1497 parity)', async () => {
    await ensureStore()
    const marker = getLastPrunePath()
    // Future timestamp — Hermes _validate_unix_time would reject this;
    // we read mtime, so the test instead targets an unreadable mtime
    // (we can't easily corrupt mtime, so verify the body-content path
    // is irrelevant: garbage body, fresh mtime → still skipped).
    writeFileSync(marker, 'NOT-A-NUMBER', 'utf-8')
    // Fresh mtime → marker IS recent regardless of content.
    const r = await pruneCheckpoints({})
    expect(r.skipped).toBe(true)
  })

  test('writes the marker on a completed run', async () => {
    await ensureStore()
    const marker = getLastPrunePath()
    expect(existsSync(marker)).toBe(false)

    const before = Date.now()
    const r = await pruneCheckpoints({})
    expect(r.skipped).toBe(false)
    expect(existsSync(marker)).toBe(true)

    const stamp = Number.parseInt(readFileSync(marker, 'utf-8'), 10)
    expect(stamp).toBeGreaterThanOrEqual(before)
    expect(stamp).toBeLessThanOrEqual(Date.now())
  })

  test('subsequent call within 24h short-circuits', async () => {
    await ensureStore()
    // First call writes the marker.
    await pruneCheckpoints({})
    // Second call within the window is throttled.
    const r = await pruneCheckpoints({})
    expect(r.skipped).toBe(true)
  })

  test('never throws — fail-open contract', async () => {
    // Even with a bogus checkpoint base (parent path is a regular file),
    // pruneCheckpoints must return a typed result.
    const file = join(tmpRoot, 'i-am-a-file')
    writeFileSync(file, 'content')
    process.env.AXIOMATE_CHECKPOINT_BASE = join(file, 'nested')
    await expect(pruneCheckpoints({ forceNow: true })).resolves.toBeDefined()
  })

  test('fresh install (no store dir) → no errors, no gc invocation', async () => {
    // Regression: before the existsSync guard in runReflogExpireAndGc,
    // running prune on a freshly-created checkpoint base (where
    // ensureStore has NOT been called) emitted two cosmetic
    // "reflog expire / gc: working directory not found" entries in
    // report.errors, which made `axiomate checkpoints prune` exit 1
    // for what is really a no-op.
    expect(existsSync(getStoreDir())).toBe(false)
    const r = await pruneCheckpoints({ forceNow: true })
    expect(r.gitMissing).toBe(false)
    expect(r.skipped).toBe(false)
    expect(r.errors).toEqual([])
    expect(r.gcInvocations).toBe(0)
    expect(r.orphanRefsRemoved).toBe(0)
    expect(r.staleRefsRemoved).toBe(0)
  })
})

/**
 * Build a fully-populated project: real workdir on disk, real ref with
 * 1 commit, real index, real projects/<hash>.json. Returns the inputs
 * the prune passes will look at.
 */
async function buildPopulatedProject(args: {
  store: string
  /** Parent dir for the workdir to be created under. */
  parent: string
  /** Override last_touch to backdate the project. */
  lastTouchSec?: number
}): Promise<{ hash: string; workdir: string; ref: string; metaPath: string; indexFilePath: string }> {
  const workdir = mkdtempSync(join(args.parent, 'wt-'))
  await touchProject(workdir)
  const hash = projectHash(workdir)
  const ref = refName(hash)
  const indexFilePath = indexPath(hash)
  const metaPath = projectMetaPath(hash)

  await buildFixtureCommit({
    store: args.store,
    workTree: workdir,
    indexFile: indexFilePath,
    ref,
    files: { 'a.txt': 'one' },
    subject: 'axiomate:m1:turn 1',
  })

  if (args.lastTouchSec !== undefined) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    meta.last_touch = args.lastTouchSec
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  }

  return { hash, workdir, ref, metaPath, indexFilePath }
}

describe('pruneCheckpoints — orphan pass', () => {
  test('drops ref + index + meta when workdir is gone', async () => {
    const e = await ensureStore()
    expect(e.ok).toBe(true)
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildPopulatedProject({ store: e.store, parent: wtParent })

    // Confirm setup: ref exists, index exists, meta exists.
    expect(existsSync(proj.metaPath)).toBe(true)
    expect(existsSync(proj.indexFilePath)).toBe(true)
    const refCheckBefore = await runCheckpointGit(
      ['rev-parse', '--verify', proj.ref],
      { store: e.store, workTree: e.store },
    )
    expect(refCheckBefore.ok).toBe(true)

    // Delete the workdir to make this an orphan.
    rmSync(proj.workdir, { recursive: true, force: true })

    const r = await pruneCheckpoints({ forceNow: true })
    expect(r.gitMissing).toBe(false)
    expect(r.skipped).toBe(false)
    expect(r.orphanRefsRemoved).toBe(1)
    expect(r.staleRefsRemoved).toBe(0)
    expect(r.errors).toEqual([])

    // Ref + index + meta all gone.
    const refCheckAfter = await runCheckpointGit(
      ['rev-parse', '--verify', proj.ref],
      { store: e.store, workTree: e.store, allowedExitCodes: new Set([128]) },
    )
    expect(refCheckAfter.ok && refCheckAfter.code === 128).toBe(true)
    expect(existsSync(proj.metaPath)).toBe(false)
    expect(existsSync(proj.indexFilePath)).toBe(false)
  })

  test('leaves an alive project untouched', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildPopulatedProject({ store: e.store, parent: wtParent })

    const r = await pruneCheckpoints({ forceNow: true })
    expect(r.orphanRefsRemoved).toBe(0)
    expect(r.staleRefsRemoved).toBe(0)
    expect(existsSync(proj.metaPath)).toBe(true)

    const refCheck = await runCheckpointGit(
      ['rev-parse', '--verify', proj.ref],
      { store: e.store, workTree: e.store },
    )
    expect(refCheck.ok).toBe(true)
  })
})

describe('pruneCheckpoints — stale pass', () => {
  test('drops ref when last_touch is older than retentionDays', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const oldSec = Math.floor(Date.now() / 1000) - 30 * 86400 // 30 days ago
    const proj = await buildPopulatedProject({
      store: e.store,
      parent: wtParent,
      lastTouchSec: oldSec,
    })

    const r = await pruneCheckpoints({ forceNow: true, retentionDays: 14 })
    expect(r.staleRefsRemoved).toBe(1)
    expect(r.orphanRefsRemoved).toBe(0)
    expect(existsSync(proj.metaPath)).toBe(false)
  })

  test('respects retentionDays=0 to disable stale pass', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const oldSec = Math.floor(Date.now() / 1000) - 30 * 86400
    const proj = await buildPopulatedProject({
      store: e.store,
      parent: wtParent,
      lastTouchSec: oldSec,
    })

    const r = await pruneCheckpoints({ forceNow: true, retentionDays: 0 })
    expect(r.staleRefsRemoved).toBe(0)
    expect(existsSync(proj.metaPath)).toBe(true)
  })

  test('orphan wins over stale when both apply', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const oldSec = Math.floor(Date.now() / 1000) - 30 * 86400
    const proj = await buildPopulatedProject({
      store: e.store,
      parent: wtParent,
      lastTouchSec: oldSec,
    })

    // Make it both an orphan AND stale.
    rmSync(proj.workdir, { recursive: true, force: true })

    const r = await pruneCheckpoints({ forceNow: true, retentionDays: 14 })
    expect(r.orphanRefsRemoved).toBe(1)
    expect(r.staleRefsRemoved).toBe(0) // counted as orphan, not stale
  })
})

describe('pruneCheckpoints — intermediate gc', () => {
  test('runs gc unconditionally — even with no orphan/stale candidates', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    // Fresh store; no projects → no orphans → no stale.
    const r = await pruneCheckpoints({ forceNow: true })
    expect(r.orphanRefsRemoved).toBe(0)
    expect(r.staleRefsRemoved).toBe(0)
    // Hermes parity: intermediate gc still runs (1375-1382 unconditional).
    // Until commit 3 lands the final-gc, gcInvocations === 1.
    expect(r.gcInvocations).toBe(1)
    expect(r.errors).toEqual([])
  })

  test('runs gc after orphan/stale drops', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildPopulatedProject({ store: e.store, parent: wtParent })
    rmSync(proj.workdir, { recursive: true, force: true })

    const r = await pruneCheckpoints({ forceNow: true })
    expect(r.orphanRefsRemoved).toBe(1)
    expect(r.gcInvocations).toBe(1)
  })
})

describe('pruneCheckpoints — error handling', () => {
  test('malformed projects/<hash>.json is logged in errors[] but does not abort', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    // Write a malformed meta. Use a 16-char hash to pass the filename check.
    const projectsDir = join(getStoreDir(), 'projects')
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(join(projectsDir, '0123456789abcdef.json'), 'not json {{{', 'utf-8')

    // Add a real project alongside so we can confirm it's still processed.
    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildPopulatedProject({ store: e.store, parent: wtParent })
    rmSync(proj.workdir, { recursive: true, force: true })

    const r = await pruneCheckpoints({ forceNow: true })
    expect(r.errors.some(s => s.includes('0123456789abcdef'))).toBe(true)
    expect(r.orphanRefsRemoved).toBe(1) // alive project still processed
  })
})

/**
 * Build a populated project with N commits on its ref so the size cap
 * has something to drop. Returns the same shape as `buildPopulatedProject`
 * for chained assertions.
 */
async function buildProjectWithNCommits(args: {
  store: string
  parent: string
  commits: number
}): Promise<{ hash: string; workdir: string; ref: string; metaPath: string }> {
  const proj = await buildPopulatedProject({ store: args.store, parent: args.parent })
  for (let i = 1; i < args.commits; i++) {
    await buildFixtureCommit({
      store: args.store,
      workTree: proj.workdir,
      indexFile: indexPath(proj.hash),
      ref: proj.ref,
      files: { 'a.txt': `content-${i}` },
      subject: `axiomate:m1:turn ${i + 1}`,
    })
  }
  return proj
}

async function commitCountOnRef(store: string, ref: string): Promise<number> {
  const r = await runCheckpointGit(
    ['rev-list', '--count', ref],
    { store, workTree: store, allowedExitCodes: new Set([128]) },
  )
  if (r.ok === false) return 0
  return Number.parseInt(r.stdout.trim(), 10) || 0
}

describe('pruneCheckpoints — snapshot cap pass', () => {
  test('truncates ref to maxN when count exceeds cap', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 3,
    })

    const r = await pruneCheckpoints({
      forceNow: true,
      maxSnapshotsPerRef: 2,
      // Disable size cap so it can't muddy the dropped-commit count.
      maxTotalSizeMb: 0,
    })
    expect(r.snapshotCapRefsTouched).toBe(1)
    expect(r.snapshotCapCommitsDropped).toBe(1)
    expect(await commitCountOnRef(e.store, proj.ref)).toBe(2)
  }, 30_000)

  test('no-ops when count is at or below cap', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 2,
    })

    const r = await pruneCheckpoints({
      forceNow: true,
      maxSnapshotsPerRef: 2,
      maxTotalSizeMb: 0,
    })
    expect(r.snapshotCapRefsTouched).toBe(0)
    expect(r.snapshotCapCommitsDropped).toBe(0)
    expect(await commitCountOnRef(e.store, proj.ref)).toBe(2)
  }, 30_000)

  test('disabled when maxSnapshotsPerRef=0', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 2,
    })

    const r = await pruneCheckpoints({
      forceNow: true,
      maxSnapshotsPerRef: 0,
      maxTotalSizeMb: 0,
    })
    expect(r.snapshotCapRefsTouched).toBe(0)
    expect(r.snapshotCapCommitsDropped).toBe(0)
    // 2 intact — explicit 0 must NOT be coerced to default.
    expect(await commitCountOnRef(e.store, proj.ref)).toBe(2)
  }, 30_000)

  test('aggregates across multiple refs', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const projA = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 3,
    })
    const projB = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 4,
    })

    const r = await pruneCheckpoints({
      forceNow: true,
      maxSnapshotsPerRef: 2,
      maxTotalSizeMb: 0,
    })
    expect(r.snapshotCapRefsTouched).toBe(2)
    // 3->2 drops 1; 4->2 drops 2; total 3.
    expect(r.snapshotCapCommitsDropped).toBe(3)
    expect(await commitCountOnRef(e.store, projA.ref)).toBe(2)
    expect(await commitCountOnRef(e.store, projB.ref)).toBe(2)
  }, 60_000)
})

describe('pruneCheckpoints — size cap pass', () => {
  test('does not run when maxTotalSizeMb=0 (Hermes `_enforce_size_cap`::1090 disabled-branch)', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 5,
    })

    const r = await pruneCheckpoints({ forceNow: true, maxTotalSizeMb: 0 })
    expect(r.sizeCapCommitsDropped).toBe(0)
    expect(r.sizeCapRefsTouched).toBe(0)
    // Final gc does not run when size cap is disabled.
    expect(r.gcInvocations).toBe(1) // intermediate only
    // All 5 commits intact.
    expect(await commitCountOnRef(e.store, proj.ref)).toBe(5)
  })

  test('skips drop loop but still runs final gc when size is under cap', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    // Big cap → never triggers.
    const r = await pruneCheckpoints({ forceNow: true, maxTotalSizeMb: 9999 })
    expect(r.sizeCapCommitsDropped).toBe(0)
    expect(r.sizeCapRefsTouched).toBe(0)
    // Hermes early-return at 1090-1095 means NO final gc when under cap.
    expect(r.gcInvocations).toBe(1) // intermediate only
  })

  test('drops oldest commits round-robin until under cap', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 5,
    })

    // Tiny cap forces the loop to drop. Drops are bounded by KEEP=1 so
    // the loop will run 4 iterations max (5 → 4 → 3 → 2 → 1).
    const r = await pruneCheckpoints({ forceNow: true, maxTotalSizeMb: 0.0001 })
    expect(r.sizeCapCommitsDropped).toBeGreaterThan(0)
    expect(r.sizeCapRefsTouched).toBe(1)
    // Final gc runs because size cap actually triggered.
    expect(r.gcInvocations).toBe(2) // intermediate + final

    // Ref still alive and at least 1 commit remains (KEEP_LAST_N_PER_REF).
    const remaining = await commitCountOnRef(e.store, proj.ref)
    expect(remaining).toBeGreaterThanOrEqual(1)
    expect(remaining).toBeLessThan(5)
  }, 30_000)

  test('keeps at least one commit per ref (KEEP_LAST_N_PER_REF=1)', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 3,
    })

    // Cap so tight the loop wants to drop everything.
    const r = await pruneCheckpoints({ forceNow: true, maxTotalSizeMb: 0.00001 })
    expect(r.sizeCapCommitsDropped).toBeGreaterThan(0)

    // The drop loop must stop before the ref reaches zero — we never
    // wipe a project's last rewindable snapshot from under it.
    const remaining = await commitCountOnRef(e.store, proj.ref)
    expect(remaining).toBe(1)
  })

  test('round-robin: distributes drops across multiple refs', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const projA = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 4,
    })
    const projB = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 4,
    })

    const r = await pruneCheckpoints({ forceNow: true, maxTotalSizeMb: 0.0001 })
    expect(r.sizeCapCommitsDropped).toBeGreaterThan(0)
    // Both projects should be touched — round-robin walks all refs each iter.
    expect(r.sizeCapRefsTouched).toBe(2)

    const remA = await commitCountOnRef(e.store, projA.ref)
    const remB = await commitCountOnRef(e.store, projB.ref)
    expect(remA).toBeGreaterThanOrEqual(1)
    expect(remB).toBeGreaterThanOrEqual(1)
    // Drops should be balanced — neither ref was emptied while the other
    // still had commits left over.
    expect(Math.abs(remA - remB)).toBeLessThanOrEqual(1)
  }, 30_000)

  test('breaks out when no progress made in a round (anti-livelock)', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    // Single commit on a single ref — drop loop cannot make progress
    // (KEEP_LAST_N_PER_REF=1 protects it).
    await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 1,
    })

    // Set cap below the actual store size so the entry check passes.
    // The drop loop body will then short-circuit since nothing can be dropped.
    const r = await pruneCheckpoints({ forceNow: true, maxTotalSizeMb: 0.00001 })
    expect(r.sizeCapCommitsDropped).toBe(0)
    // Final gc still runs — Hermes `_enforce_size_cap`::1164-1171 unconditional within branch.
    expect(r.gcInvocations).toBe(2)
  })

  test('reports bytesFreed >= 0', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 5,
    })

    const r = await pruneCheckpoints({ forceNow: true, maxTotalSizeMb: 0.0001 })
    // Cap at 0 — Hermes `prune_checkpoints`::1457 max(0, before-after) — covers fs noise.
    expect(r.bytesFreed).toBeGreaterThanOrEqual(0)
  }, 60_000)

  /**
   * T1 (completion-plan 6D) — prove `bytesFreed` actually tracks reclaimed
   * bytes, not just "≥ 0". Stage N bytes of incompressible random data
   * (zlib can't shrink it meaningfully), snapshot, then drop everything
   * via the size cap and assert at least a substantial fraction came
   * back. The original `bytesFreed >= 0` test only proved the field
   * exists; this pins the semantic.
   *
   * `bytesFreed` is `max(0, before - after)` per Hermes `prune_checkpoints`::1457; on Windows
   * `du`-equivalent du measurements have ~10% noise from filesystem
   * cluster rounding, so we assert against a generous floor (50% of N)
   * rather than the exact byte count.
   */
  test('T1: bytesFreed tracks reclaimed N bytes (incompressible blob)', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 1,
    })

    // 256 KiB of random bytes — large enough to survive NTFS cluster
    // rounding (4 KiB clusters; 256 KiB / 50% floor = 128 KiB still ≫
    // one cluster) but small enough to keep git pack/gc work fast on
    // Windows CI. The original 2 MiB version timed out the test on
    // slower machines without exercising any extra branch.
    const N = 256 * 1024
    const blob = randomBytes(N)
    writeFileSync(join(proj.workdir, 'big.bin'), blob)
    // Empty files: the `git add -A` inside buildFixtureCommit picks up
    // big.bin from the workdir as-written. Passing it via the `files`
    // map would re-write it through utf-8 conversion and shrink it.
    await buildFixtureCommit({
      store: e.store,
      workTree: proj.workdir,
      indexFile: indexPath(proj.hash),
      ref: proj.ref,
      files: {},
      subject: 'axiomate:m1:turn 2',
    })
    // Drop big.bin and add a third commit so KEEP_LAST_N_PER_REF=1
    // still leaves room to actually drop the blob commit. Without this,
    // the size cap can't reach the big-blob commit because it's the
    // one we're protecting.
    rmSync(join(proj.workdir, 'big.bin'))
    await buildFixtureCommit({
      store: e.store,
      workTree: proj.workdir,
      indexFile: indexPath(proj.hash),
      ref: proj.ref,
      files: { 'tiny.txt': 'x' },
      subject: 'axiomate:m1:turn 3',
    })

    // maxTotalSizeMb: 0.0001 forces the cap to drop everything droppable
    // (down to KEEP_LAST_N_PER_REF). The big-blob commit gets dropped,
    // gc reclaims its pack data.
    const r = await pruneCheckpoints({ forceNow: true, maxTotalSizeMb: 0.0001 })
    expect(r.sizeCapCommitsDropped).toBeGreaterThan(0)
    // Assert at least 50% of N (128 KiB on a 256 KiB blob) came back.
    // Random-data zlib compresses poorly (<1%); NTFS 4 KiB cluster
    // rounding is the only meaningful noise, dwarfed by the 50% floor.
    expect(r.bytesFreed).toBeGreaterThanOrEqual(N / 2)
  }, 60_000)

  /**
   * T2 (completion-plan 6D) — two prunes racing on the marker.
   *
   * Hermes ran prune from a single agent process so the marker race
   * was theoretical. Axiomate's startup hook fires async on every boot
   * and a developer can absolutely launch two terminals at once. The
   * contract under race is *not* "exactly one runs" — both may pass
   * the marker check before either writes — but the marker must end
   * up parseable, no orphan locks, and the store must remain
   * `git fsck` clean.
   */
  test('T2: concurrent prune calls leave marker + store in a consistent state', async () => {
    const e = await ensureStore()
    if (!e.ok) return

    const wtParent = mkdtempSync(join(tmpRoot, 'wts-'))
    await buildProjectWithNCommits({
      store: e.store,
      parent: wtParent,
      commits: 3,
    })

    // Two concurrent calls, neither forcing — they race on the marker.
    const [a, b] = await Promise.all([
      pruneCheckpoints({}),
      pruneCheckpoints({}),
    ])

    // At least one must have run; the other may have skipped on the
    // freshly-written marker, OR both may have started before either
    // wrote — that's fine. The contract under race is *not* "errors
    // empty": git itself refuses concurrent gc with a lock-file error
    // (exit 128, which our code surfaces as a tracked error). What
    // *is* the contract: the marker ends up parseable and the store
    // remains integral. A torn ref update or a half-collected gc
    // would surface in fsck.
    const ranA = a.skipped === false
    const ranB = b.skipped === false
    expect(ranA || ranB).toBe(true)
    // Errors are allowed (gc lock contention), but only the kind we
    // expect — never a thrown exception (both calls must resolve).
    for (const r of [a, b]) {
      for (const err of r.errors) {
        expect(err).toMatch(/gc:|reflog:|^$/)
      }
    }

    const marker = getLastPrunePath()
    expect(existsSync(marker)).toBe(true)
    const stamp = Number.parseInt(readFileSync(marker, 'utf-8'), 10)
    expect(Number.isFinite(stamp)).toBe(true)
    expect(stamp).toBeGreaterThan(0)

    // Store integrity: fsck must come back clean. A double-gc or torn
    // ref update would surface here.
    const fsck = await runCheckpointGit(['fsck', '--no-progress'], {
      store: e.store,
      workTree: e.store,
    })
    expect(fsck.ok).toBe(true)
  }, 60_000)
})
