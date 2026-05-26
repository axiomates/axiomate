/**
 * Behavior tests for `findReachableSnapshot` (6A + 6B).
 *
 * Five scenarios:
 *   1. Reachable (tip): gitHash is the tip of the project's ref — must
 *      return `{ kind: 'reachable' }`.
 *   2. Reachable (ancestor): gitHash is an older commit on the same
 *      ref — also `{ kind: 'reachable' }`.
 *   3. Unreachable (orphaned by prune): build N commits, then
 *      `update-ref` the project ref backwards so older commit objects
 *      exist but are no longer ancestors. Must return
 *      `{ kind: 'unreachable' }`.
 *   4. 6B cross-worktree: gitHash is anchored only by another
 *      project's ref → `{ kind: 'reachable-other-worktree', workdir }`.
 *   5. 6B miss: object doesn't exist anywhere → `unreachable`.
 *   6. Validation / empty-ref edge cases (hash flag rejection, no-ref-yet).
 *
 * All tests use a real shadow git store via `AXIOMATE_CHECKPOINT_BASE`
 * redirect so the cat-file / merge-base codepaths are exercised end
 * to end against actual git.
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
import { findReachableSnapshot } from '../../../../utils/checkpoints/findReachableSnapshot.js'
import { _resetGitAvailableCacheForTesting } from '../../../../utils/checkpoints/git.js'
import { indexPath, projectHash, refName } from '../../../../utils/checkpoints/paths.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import { buildFixtureCommit } from './fixtures.js'

let tmpRoot: string
let baseEnvBefore: string | undefined

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-reach-'))
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

async function bootstrapProject(name: string): Promise<{
  workdir: string
  hash: string
  ref: string
  store: string
}> {
  const ensured = await ensureStore()
  if (ensured.ok === false) throw new Error('ensureStore failed in setup')
  const workdir = mkdtempSync(join(tmpRoot, `wt-${name}-`))
  const hash = projectHash(workdir)
  const ref = refName(hash)
  return { workdir, hash, ref, store: ensured.store }
}

describe('findReachableSnapshot', () => {
  test('reachable: tip-of-ref hash returns reachable', async () => {
    const p = await bootstrapProject('a')
    const sha = await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'foo.txt': 'one\n' },
      subject: 'snap 1',
    })
    const r = await findReachableSnapshot({
      workdir: p.workdir,
      gitHash: sha,
    })
    expect(r).toEqual({ kind: 'reachable' })
  })

  test('reachable: ancestor (not tip) still resolves reachable', async () => {
    const p = await bootstrapProject('b')
    const sha1 = await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'foo.txt': 'v1\n' },
      subject: 'snap 1',
    })
    await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'foo.txt': 'v2\n' },
      subject: 'snap 2',
    })
    const r = await findReachableSnapshot({
      workdir: p.workdir,
      gitHash: sha1,
    })
    expect(r).toEqual({ kind: 'reachable' })
  })

  test('unreachable: detached commit (ref rolled back, no other ref anchors it)', async () => {
    const p = await bootstrapProject('c')
    const sha1 = await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'foo.txt': 'v1\n' },
      subject: 'snap 1',
    })
    const sha2 = await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'foo.txt': 'v2\n' },
      subject: 'snap 2',
    })
    await runCheckpointGit(
      ['update-ref', p.ref, sha1],
      { store: p.store, workTree: p.workdir, indexFile: indexPath(p.hash) },
    )
    const r = await findReachableSnapshot({
      workdir: p.workdir,
      gitHash: sha2,
    })
    expect(r).toEqual({ kind: 'unreachable' })
  })

  test('6B: hash anchored only by another project ref returns reachable-other-worktree with that workdir', async () => {
    const a = await bootstrapProject('cross-a')
    const b = await bootstrapProject('cross-b')
    // Both projects must have a `projects/<hash16>.json` for the scan to
    // find them — `buildFixtureCommit` writes commits to the ref but
    // doesn't touch the metadata file. Write minimal metas explicitly.
    writeProjectMeta(a)
    writeProjectMeta(b)
    const shaA = await buildFixtureCommit({
      store: a.store,
      workTree: a.workdir,
      indexFile: indexPath(a.hash),
      ref: a.ref,
      files: { 'foo.txt': 'a\n' },
      subject: 'a snap',
    })
    await buildFixtureCommit({
      store: b.store,
      workTree: b.workdir,
      indexFile: indexPath(b.hash),
      ref: b.ref,
      files: { 'foo.txt': 'b\n' },
      subject: 'b snap',
    })
    // Querying from B's workdir for A's hash: in-project ref doesn't
    // anchor it, but A's ref does.
    const r = await findReachableSnapshot({
      workdir: b.workdir,
      gitHash: shaA,
    })
    expect(r).toEqual({ kind: 'reachable-other-worktree', workdir: a.workdir })
  })

  test('6B: object exists nowhere → unreachable (no foreign anchor found)', async () => {
    const a = await bootstrapProject('miss-a')
    const b = await bootstrapProject('miss-b')
    writeProjectMeta(a)
    writeProjectMeta(b)
    await buildFixtureCommit({
      store: a.store,
      workTree: a.workdir,
      indexFile: indexPath(a.hash),
      ref: a.ref,
      files: { 'foo.txt': 'a\n' },
      subject: 'a snap',
    })
    // 40-hex that's not anywhere in either ref. Step 1 cat-file -e
    // returns 1 → unreachable directly, scan never runs.
    const r = await findReachableSnapshot({
      workdir: b.workdir,
      gitHash: 'a'.repeat(40),
    })
    expect(r).toEqual({ kind: 'unreachable' })
  })

  test('malformed gitHash returns unknown without spawning git', async () => {
    const p = await bootstrapProject('mal')
    await buildFixtureCommit({
      store: p.store,
      workTree: p.workdir,
      indexFile: indexPath(p.hash),
      ref: p.ref,
      files: { 'a.txt': 'x' },
      subject: 's',
    })
    expect(
      await findReachableSnapshot({ workdir: p.workdir, gitHash: '-p' }),
    ).toEqual({ kind: 'unknown' })
    expect(
      await findReachableSnapshot({ workdir: p.workdir, gitHash: 'xyz' }),
    ).toEqual({ kind: 'unknown' })
    expect(
      await findReachableSnapshot({ workdir: p.workdir, gitHash: '' }),
    ).toEqual({ kind: 'unknown' })
  })

  test('no project ref yet → unreachable, not unknown', async () => {
    const p = await bootstrapProject('empty')
    const r = await findReachableSnapshot({
      workdir: p.workdir,
      gitHash: 'a'.repeat(40),
    })
    expect(r).toEqual({ kind: 'unreachable' })
  })
})

/**
 * Helper: write a minimal `projects/<hash16>.json` so the 6B scan can
 * find this project. Real `touchProject` does this through the store
 * API; the fixture commits skip it because pre-6B tests didn't need it.
 */
function writeProjectMeta(p: { store: string; hash: string; workdir: string }): void {
  const path = join(p.store, 'projects', `${p.hash}.json`)
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(
    path,
    JSON.stringify({ workdir: p.workdir, created_at: now, last_touch: now }),
  )
}
