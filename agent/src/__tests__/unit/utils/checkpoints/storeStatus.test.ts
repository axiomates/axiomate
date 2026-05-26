/**
 * Behavior tests for `storeStatus` — the read-only summary that backs
 * Phase 5's `/checkpoints` slash command and CLI status subcommand.
 *
 * Coverage:
 *   - empty / nonexistent base → zeroed report (don't crash on fresh install)
 *   - store dir but no HEAD → still safe (init-in-progress race)
 *   - happy path: 2 projects, varying snapshot counts, sizes accumulate
 *   - workdir-removed → `exists: false` for that project, others fine
 *   - bad ref name in projects/*.json shouldn't take down the whole report
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
import { _resetGitAvailableCacheForTesting } from '../../../../utils/checkpoints/git.js'
import {
  getStoreDir,
  indexPath,
  projectHash,
  projectMetaPath,
  refName,
} from '../../../../utils/checkpoints/paths.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { storeStatus } from '../../../../utils/checkpoints/storeStatus.js'
import { touchProject } from '../../../../utils/checkpoints/touchProject.js'
import { buildFixtureCommit } from './fixtures.js'

let tmpRoot: string
let baseEnvBefore: string | undefined

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-storestatus-'))
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

describe('storeStatus — fresh install', () => {
  test('nonexistent base returns zeroed report without throwing', async () => {
    rmSync(process.env.AXIOMATE_CHECKPOINT_BASE!, {
      recursive: true,
      force: true,
    })
    const report = await storeStatus()
    expect(report.project_count).toBe(0)
    expect(report.projects).toEqual([])
    expect(report.store_size_bytes).toBe(0)
    expect(report.total_size_bytes).toBe(0)
    expect(report.base).toBe(process.env.AXIOMATE_CHECKPOINT_BASE)
  })

  test('base exists but no store yet returns zeroed report', async () => {
    const report = await storeStatus()
    expect(report.project_count).toBe(0)
    expect(report.projects).toEqual([])
    expect(report.store_size_bytes).toBe(0)
  })

  test('store dir but no HEAD (init-in-progress race) returns zeroed report', async () => {
    mkdirSync(getStoreDir(), { recursive: true })
    const report = await storeStatus()
    expect(report.project_count).toBe(0)
    expect(report.projects).toEqual([])
    expect(report.store_size_bytes).toBeGreaterThanOrEqual(0)
  })
})

describe('storeStatus — populated store', () => {
  test('two projects with different snapshot counts report correct commits + workdirs', async () => {
    const init = await ensureStore()
    expect(init.ok).toBe(true)
    const store = getStoreDir()

    const wt1 = mkdtempSync(join(tmpRoot, 'wt1-'))
    const wt2 = mkdtempSync(join(tmpRoot, 'wt2-'))
    const h1 = projectHash(wt1)
    const h2 = projectHash(wt2)

    await touchProject(wt1)
    await touchProject(wt2)

    // wt1: 3 commits. wt2: 1 commit.
    for (let i = 0; i < 3; i++) {
      await buildFixtureCommit({
        store,
        workTree: wt1,
        indexFile: indexPath(h1),
        ref: refName(h1),
        files: { 'a.txt': `v${i}` },
        subject: `axiomate:edit:t${i}`,
      })
    }
    await buildFixtureCommit({
      store,
      workTree: wt2,
      indexFile: indexPath(h2),
      ref: refName(h2),
      files: { 'b.txt': 'only' },
      subject: 'axiomate:edit:t0',
    })

    const report = await storeStatus()
    expect(report.project_count).toBe(2)

    const byHash = new Map(report.projects.map(p => [p.hash, p]))
    expect(byHash.get(h1)?.commits).toBe(3)
    expect(byHash.get(h2)?.commits).toBe(1)
    expect(byHash.get(h1)?.workdir).toBe(wt1)
    expect(byHash.get(h2)?.workdir).toBe(wt2)
    expect(byHash.get(h1)?.exists).toBe(true)
    expect(byHash.get(h2)?.exists).toBe(true)

    expect(report.store_size_bytes).toBeGreaterThan(0)
    expect(report.total_size_bytes).toBeGreaterThanOrEqual(report.store_size_bytes)
  })

  test('removed workdir surfaces as exists=false; others still report exists=true', async () => {
    const init = await ensureStore()
    expect(init.ok).toBe(true)
    const store = getStoreDir()

    const live = mkdtempSync(join(tmpRoot, 'live-'))
    const gone = mkdtempSync(join(tmpRoot, 'gone-'))
    const hLive = projectHash(live)
    const hGone = projectHash(gone)

    await touchProject(live)
    await touchProject(gone)
    await buildFixtureCommit({
      store,
      workTree: live,
      indexFile: indexPath(hLive),
      ref: refName(hLive),
      files: { 'a.txt': 'a' },
      subject: 'axiomate:edit:t0',
    })
    await buildFixtureCommit({
      store,
      workTree: gone,
      indexFile: indexPath(hGone),
      ref: refName(hGone),
      files: { 'b.txt': 'b' },
      subject: 'axiomate:edit:t0',
    })

    rmSync(gone, { recursive: true, force: true })

    const report = await storeStatus()
    const byHash = new Map(report.projects.map(p => [p.hash, p]))
    expect(byHash.get(hLive)?.exists).toBe(true)
    expect(byHash.get(hGone)?.exists).toBe(false)
    // Both projects must still appear — exists=false does NOT drop the row.
    expect(report.project_count).toBe(2)
  })

  test('malformed projects/*.json file is skipped, valid neighbors still reported', async () => {
    const init = await ensureStore()
    expect(init.ok).toBe(true)
    const store = getStoreDir()

    const wt = mkdtempSync(join(tmpRoot, 'good-'))
    const h = projectHash(wt)
    await touchProject(wt)
    await buildFixtureCommit({
      store,
      workTree: wt,
      indexFile: indexPath(h),
      ref: refName(h),
      files: { 'a.txt': 'a' },
      subject: 'axiomate:edit:t0',
    })

    // Drop a malformed sibling meta file.
    const badHash = '0123456789abcdef'
    writeFileSync(projectMetaPath(badHash), '{not valid json')

    const report = await storeStatus()
    expect(report.project_count).toBe(1)
    expect(report.projects[0]?.hash).toBe(h)
  })

  test('project with no ref yet (touched but never snapshotted) reports commits=0', async () => {
    const init = await ensureStore()
    expect(init.ok).toBe(true)

    const wt = mkdtempSync(join(tmpRoot, 'untouched-'))
    await touchProject(wt)
    // Deliberately no buildFixtureCommit — ref doesn't exist.

    const report = await storeStatus()
    expect(report.project_count).toBe(1)
    expect(report.projects[0]?.commits).toBe(0)
    expect(report.projects[0]?.exists).toBe(true)
  })
})
