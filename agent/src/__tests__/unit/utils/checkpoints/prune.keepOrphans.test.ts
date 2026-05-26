/**
 * `--keep-orphans` flag — Hermes parity feature `delete_orphans=False`.
 *
 * The flag suppresses the orphan pass: refs whose workdir has vanished
 * from disk are left intact. Stale + size-cap still run. The 6C1
 * anchor pass is naturally a no-op for skipped orphans (no ref is
 * being deleted, so there's nothing to anchor before).
 *
 * Three scenarios pin the contract:
 *   1. `keepOrphans: true` skips orphan drop on a vanished workdir;
 *      a follow-up call without the flag drops it normally.
 *   2. `keepOrphans: true` does not affect the stale path.
 *   3. Default (`keepOrphans` unset / false) preserves current behavior
 *      — the orphan ref is removed and `orphanRefsSkipped === 0`.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
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
import { _resetGitAvailableCacheForTesting, runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import { indexPath, projectHash, refName } from '../../../../utils/checkpoints/paths.js'
import { pruneCheckpoints } from '../../../../utils/checkpoints/prune.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { touchProject } from '../../../../utils/checkpoints/touchProject.js'
import { buildFixtureCommit } from './fixtures.js'

let tmpRoot: string
let baseEnvBefore: string | undefined
let configEnvBefore: string | undefined

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-keeporphans-'))
  baseEnvBefore = process.env.AXIOMATE_CHECKPOINT_BASE
  configEnvBefore = process.env.AXIOMATE_CONFIG_DIR
})

afterAll(() => {
  if (baseEnvBefore === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = baseEnvBefore
  if (configEnvBefore === undefined) delete process.env.AXIOMATE_CONFIG_DIR
  else process.env.AXIOMATE_CONFIG_DIR = configEnvBefore
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  const fresh = mkdtempSync(join(tmpRoot, 'base-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(fresh, 'cp')
  process.env.AXIOMATE_CONFIG_DIR = join(fresh, 'cfg')
  mkdirSync(process.env.AXIOMATE_CONFIG_DIR, { recursive: true })
  _resetGitAvailableCacheForTesting()
})

afterEach(() => {
  _resetGitAvailableCacheForTesting()
})

interface ProjectFixture {
  hash: string
  workdir: string
  ref: string
  sha1: string
  sha2: string
  sha3: string
}

async function buildThreeCommitProject(args: {
  store: string
  parent: string
}): Promise<ProjectFixture> {
  const workdir = mkdtempSync(join(args.parent, 'wt-'))
  await touchProject(workdir)
  const hash = projectHash(workdir)
  const ref = refName(hash)
  const idx = indexPath(hash)
  const sha1 = await buildFixtureCommit({
    store: args.store, workTree: workdir, indexFile: idx, ref,
    files: { 'a.txt': 'one' }, subject: 'turn 1',
  })
  const sha2 = await buildFixtureCommit({
    store: args.store, workTree: workdir, indexFile: idx, ref,
    files: { 'a.txt': 'two' }, subject: 'turn 2',
  })
  const sha3 = await buildFixtureCommit({
    store: args.store, workTree: workdir, indexFile: idx, ref,
    files: { 'a.txt': 'three' }, subject: 'turn 3',
  })
  return { hash, workdir, ref, sha1, sha2, sha3 }
}

async function refResolves(store: string, ref: string): Promise<string | null> {
  const r = await runCheckpointGit(
    ['rev-parse', '--verify', `${ref}^{commit}`],
    { store, workTree: store, allowedExitCodes: new Set([0, 128]) },
  )
  if (r.ok === false || r.code !== 0) return null
  const sha = r.stdout.trim()
  return sha.length > 0 ? sha : null
}

describe('pruneCheckpoints — --keep-orphans flag', () => {
  test('1. keepOrphans=true skips orphan drop; follow-up without flag drops normally', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    rmSync(proj.workdir, { recursive: true, force: true })

    // First call with --keep-orphans: ref must survive, counter increments.
    const r1 = await pruneCheckpoints({ forceNow: true, keepOrphans: true })
    expect(r1.gitMissing).toBe(false)
    expect(r1.orphanRefsRemoved).toBe(0)
    expect(r1.orphanRefsSkipped).toBe(1)
    expect(r1.keepRefsAnchored).toBe(0)
    expect(await refResolves(e.store, proj.ref)).toBe(proj.sha3)

    // Second call without the flag: orphan pass actually runs now.
    const r2 = await pruneCheckpoints({ forceNow: true })
    expect(r2.orphanRefsRemoved).toBe(1)
    expect(r2.orphanRefsSkipped).toBe(0)
    expect(await refResolves(e.store, proj.ref)).toBeNull()
  })

  test('2. keepOrphans does not affect the stale path', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    // Workdir intact; backdate last_touch past the retention window.
    const metaPath = join(e.store, 'projects', `${proj.hash}.json`)
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    meta.last_touch = Math.floor(Date.now() / 1000) - 30 * 86400
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    const r = await pruneCheckpoints({
      forceNow: true,
      keepOrphans: true,
      retentionDays: 14,
    })
    expect(r.staleRefsRemoved).toBe(1)
    expect(r.orphanRefsRemoved).toBe(0)
    expect(r.orphanRefsSkipped).toBe(0)
    expect(await refResolves(e.store, proj.ref)).toBeNull()
  })

  test('3. default (keepOrphans unset) drops orphan ref as before', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    rmSync(proj.workdir, { recursive: true, force: true })
    const r = await pruneCheckpoints({ forceNow: true })

    expect(r.orphanRefsRemoved).toBe(1)
    expect(r.orphanRefsSkipped).toBe(0)
    expect(await refResolves(e.store, proj.ref)).toBeNull()
  })
})
