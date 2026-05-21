/**
 * Behavior tests for `computeResumeRewindHint`.
 *
 * Three outcomes, plus the silence cases:
 *   - reachable last snapshot → info hint
 *   - unreachable last snapshot (ref rolled back past it) → warning hint
 *   - empty snapshots list → null (no hint)
 *   - malformed gitHash on the last snapshot → null (no hint)
 *
 * The `unknown` → null outcome is exercised implicitly via the malformed
 * hash path (validateCommitHash rejects it before any git spawn).
 */

import { mkdtempSync, rmSync } from 'fs'
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
import { setIsInteractive } from '../../../bootstrap/state.js'
import type { FileHistorySnapshot } from '../../fileHistory.js'
import { _resetGitAvailableCacheForTesting, runCheckpointGit } from '../git.js'
import { indexPath, projectHash, refName } from '../paths.js'
import { computeResumeRewindHint } from '../resumeRewindHint.js'
import { ensureStore } from '../store.js'
import { buildFixtureCommit } from './fixtures.js'

let tmpRoot: string
let baseEnvBefore: string | undefined

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-rrh-'))
  baseEnvBefore = process.env.AXIOMATE_CHECKPOINT_BASE
  // Match REPL path so fileHistoryEnabled() returns true under vitest.
  setIsInteractive(true)
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
  })

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
  })

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
  })
})
