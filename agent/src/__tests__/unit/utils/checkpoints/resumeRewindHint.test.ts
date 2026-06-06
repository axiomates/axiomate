/**
 * Behavior tests for `computeResumeRewindHint`.
 *
 * Four outcomes, plus the silence cases:
 *   - reachable last snapshot → info hint
 *   - unreachable last snapshot (ref rolled back past it) → warning hint
 *   - reachable-other-worktree → warning hint mentioning the foreign workdir
 *   - empty snapshots list → null (no hint)
 *   - malformed gitHash on the last snapshot → null (no hint)
 *
 * The `unknown` → null outcome is exercised implicitly via the malformed
 * hash path (validateCommitHash rejects it before any git spawn).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
import type { UUID } from 'crypto'
import type { FileHistorySnapshot } from '../../../../utils/fileHistory.js'
import { _resetGitAvailableCacheForTesting, runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import { indexPath, projectHash, refName } from '../../../../utils/checkpoints/paths.js'
import { computeResumeRewindHint } from '../../../../utils/checkpoints/resumeRewindHint.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { buildFixtureCommit } from './fixtures.js'

const GIT_TEST_TIMEOUT_MS = 60_000

let tmpRoot: string
let baseEnvBefore: string | undefined

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-rrh-'))
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
  _resetGitAvailableCacheForTesting()
})

afterEach(() => {
  delete process.env.AXIOMATE_CHECKPOINT_BASE
})

async function bootstrap(): Promise<{
  workdir: string
  hash: string
  ref: string
  store: string
}> {
  const ensured = await ensureStore()
  if (ensured.ok === false) throw new Error('ensureStore failed')
  const workdir = mkdtempSync(join(tmpRoot, 'wt-'))
  const hash = projectHash(workdir)
  return { workdir, hash, ref: refName(hash), store: ensured.store }
}

function snapshot(gitHash: string, messageId = 'mid'): FileHistorySnapshot {
  return {
    messageId: messageId as UUID,
    gitHash,
    addedTrackedFiles: [],
    timestamp: new Date(),
  }
}

describe('computeResumeRewindHint', () => {
  test('reachable last snapshot → info hint', async () => {
    const p = await bootstrap()
    const sha = await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'a.txt': 'x\n' },
      subject: 's',
    })
    const r = await computeResumeRewindHint({
      workdir: p.workdir,
      snapshots: [snapshot(sha)],
    })
    expect(r).not.toBeNull()
    expect(r?.severity).toBe('info')
    expect(r?.text).toMatch(/rewind/i)
  }, GIT_TEST_TIMEOUT_MS)

  test('unreachable last snapshot → warning hint', async () => {
    const p = await bootstrap()
    const sha1 = await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'a.txt': 'v1\n' },
      subject: 's1',
    })
    const sha2 = await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'a.txt': 'v2\n' },
      subject: 's2',
    })
    // Roll the ref back so sha2 is detached.
    await runCheckpointGit(
      ['update-ref', p.ref, sha1],
      { store: p.store, workTree: p.workdir, indexFile: indexPath(p.hash) },
    )
    const r = await computeResumeRewindHint({
      workdir: p.workdir,
      snapshots: [snapshot(sha2)],
    })
    expect(r).not.toBeNull()
    expect(r?.severity).toBe('warning')
    expect(r?.text).toMatch(/pruned|rewind/i)
  }, GIT_TEST_TIMEOUT_MS)

  test('6B: hash anchored only by another workdir → warning naming that workdir', async () => {
    // Project A holds the snapshot; user resumes that session sitting
    // in project B (e.g. same repo, different absolute path).
    const a = await bootstrap()
    const b = await bootstrap()
    writeProjectMeta(a)
    writeProjectMeta(b)
    const shaA = await buildFixtureCommit({
      store: a.store,
      workTree: a.workdir,
      indexFile: indexPath(a.hash),
      ref: a.ref,
      files: { 'a.txt': 'a\n' },
      subject: 'snap from a',
    })
    await buildFixtureCommit({
      store: b.store,
      workTree: b.workdir,
      indexFile: indexPath(b.hash),
      ref: b.ref,
      files: { 'b.txt': 'b\n' },
      subject: 'snap from b',
    })
    const r = await computeResumeRewindHint({
      workdir: b.workdir,
      snapshots: [snapshot(shaA)],
    })
    expect(r).not.toBeNull()
    expect(r?.severity).toBe('warning')
    expect(r?.text).toContain(a.workdir)
    expect(r?.text).toMatch(/different workdir|cd into/i)
  }, GIT_TEST_TIMEOUT_MS)

  test('empty snapshots list → null (no hint)', async () => {
    const p = await bootstrap()
    const r = await computeResumeRewindHint({
      workdir: p.workdir,
      snapshots: [],
    })
    expect(r).toBeNull()
  })

  test('malformed gitHash on last snapshot → null (no hint)', async () => {
    const p = await bootstrap()
    const r = await computeResumeRewindHint({
      workdir: p.workdir,
      snapshots: [snapshot('not-a-hash')],
    })
    expect(r).toBeNull()
  })

  test('only the last snapshot is probed (earlier rows ignored)', async () => {
    // If older row reachability mattered, this test would flip — but the
    // contract pins probe to snapshots[snapshots.length - 1]. A reachable
    // tail and a (fake / cleared) earlier row should still produce info.
    const p = await bootstrap()
    const sha = await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'a.txt': 'x\n' },
      subject: 's',
    })
    const r = await computeResumeRewindHint({
      workdir: p.workdir,
      snapshots: [snapshot('a'.repeat(40), 'old'), snapshot(sha, 'new')],
    })
    expect(r?.severity).toBe('info')
  }, GIT_TEST_TIMEOUT_MS)
})

/**
 * Helper: write a minimal `projects/<hash16>.json` so the 6B
 * cross-worktree scan can locate this project. Mirrors the same helper
 * in `findReachableSnapshot.test.ts` — kept duplicated rather than
 * extracted because both test files are the only callers and the
 * fixture surface is intentionally small.
 */
function writeProjectMeta(p: { store: string; hash: string; workdir: string }): void {
  const path = join(p.store, 'projects', `${p.hash}.json`)
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(
    path,
    JSON.stringify({ workdir: p.workdir, created_at: now, last_touch: now }),
  )
}
