/**
 * 6C1 — anchor-keep refs in `pruneCheckpoints`.
 *
 * Six scenarios cover the contract:
 *   1. Anchor on orphan: workdir gone, recent session JSONL references a
 *      reachable hash → keep-ref written at tip, project ref dropped,
 *      every commit on the chain remains reachable via the keep-ref.
 *   2. Anchor on stale: workdir intact, last_touch beyond retention →
 *      same anchoring outcome.
 *   3. Expire dead keep-ref: pre-write `_keep/<hash>/<sid>` whose JSONL
 *      doesn't exist → prune deletes it, `report.keepRefsExpired === 1`.
 *   4. No recent sessions → no anchor: orphan project with no JSONL →
 *      ref dropped, no keep-ref written.
 *   5. Foreign hash skipped: JSONL references a 40-hex hash that's NOT
 *      in the dying ref's history → no keep-ref written.
 *   6. listProjectRefs filters `_keep/`: pre-seed a `_keep/` ref then
 *      run a size-cap-touching prune → the keep-ref is not treated as
 *      a project ref (no rotation, no error).
 *
 * Each test gets its own AXIOMATE_CHECKPOINT_BASE + AXIOMATE_CONFIG_DIR
 * so the session-storage scan finds only the JSONLs we wrote.
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
import {
  indexPath,
  KEEP_REF_PREFIX,
  keepRefName,
  projectHash,
  refName,
} from '../../../../utils/checkpoints/paths.js'
import { pruneCheckpoints } from '../../../../utils/checkpoints/prune.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { touchProject } from '../../../../utils/checkpoints/touchProject.js'
import { sanitizePath } from '../../../../utils/path.js'
import { buildFixtureCommit } from './fixtures.js'

let tmpRoot: string
let baseEnvBefore: string | undefined
let configEnvBefore: string | undefined
const CHECKPOINT_TEST_TIMEOUT_MS = 30_000

function checkpointTest(
  name: string,
  fn: () => void | Promise<void>,
): void {
  test(name, fn, CHECKPOINT_TEST_TIMEOUT_MS)
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-keep-'))
  baseEnvBefore = process.env.AXIOMATE_CHECKPOINT_BASE
  configEnvBefore = process.env.AXIOMATE_CONFIG_DIR
})

afterAll(() => {
  if (baseEnvBefore === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = baseEnvBefore
  if (configEnvBefore === undefined) delete process.env.AXIOMATE_CONFIG_DIR
  else process.env.AXIOMATE_CONFIG_DIR = configEnvBefore
  rmSync(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
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

/**
 * Write a minimal session JSONL containing `file-history-snapshot`
 * entries for each provided gitHash. Returns the JSONL path.
 */
function writeSessionJsonl(args: {
  workdir: string
  sessionId: string
  hashes: readonly string[]
}): string {
  const dir = join(
    process.env.AXIOMATE_CONFIG_DIR!,
    'projects',
    sanitizePath(args.workdir),
  )
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${args.sessionId}.jsonl`)
  const lines = args.hashes.map((h, i) =>
    JSON.stringify({
      type: 'file-history-snapshot',
      snapshot: {
        messageId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        gitHash: h,
        addedTrackedFiles: [],
        timestamp: new Date().toISOString(),
      },
    }),
  )
  writeFileSync(path, lines.join('\n') + '\n')
  return path
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

async function isAncestor(args: {
  store: string; ancestor: string; descendant: string
}): Promise<boolean> {
  const r = await runCheckpointGit(
    ['merge-base', '--is-ancestor', args.ancestor, args.descendant],
    { store: args.store, workTree: args.store, allowedExitCodes: new Set([0, 1]) },
  )
  if (r.ok === false) return false
  return r.code === 0
}

describe('pruneCheckpoints — 6C1 anchor-keep refs', () => {
  checkpointTest('1. anchor on orphan workdir', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    writeSessionJsonl({
      workdir: proj.workdir,
      sessionId: 'sess-orphan',
      hashes: [proj.sha2],
    })

    rmSync(proj.workdir, { recursive: true, force: true })
    const r = await pruneCheckpoints({ forceNow: true })

    expect(r.gitMissing).toBe(false)
    expect(r.orphanRefsRemoved).toBe(1)
    expect(r.keepRefsAnchored).toBe(1)
    expect(r.sessionsScanned).toBeGreaterThanOrEqual(1)

    expect(await refResolves(e.store, proj.ref)).toBeNull()

    const keep = keepRefName(proj.hash, 'sess-orphan')
    const keepTip = await refResolves(e.store, keep)
    expect(keepTip).toBe(proj.sha3)

    for (const sha of [proj.sha1, proj.sha2, proj.sha3]) {
      expect(await isAncestor({ store: e.store, ancestor: sha, descendant: keep })).toBe(true)
    }

    const fsck = await runCheckpointGit(
      ['fsck', '--no-progress'],
      { store: e.store, workTree: e.store },
    )
    expect(fsck.ok).toBe(true)
  })

  checkpointTest('2. anchor on stale ref (workdir intact)', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    writeSessionJsonl({
      workdir: proj.workdir,
      sessionId: 'sess-stale',
      hashes: [proj.sha1],
    })

    // Backdate touchProject's last_touch.
    const metaPath = join(e.store, 'projects', `${proj.hash}.json`)
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    meta.last_touch = Math.floor(Date.now() / 1000) - 30 * 86400
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    const r = await pruneCheckpoints({ forceNow: true, retentionDays: 14 })

    expect(r.staleRefsRemoved).toBe(1)
    expect(r.keepRefsAnchored).toBe(1)
    expect(await refResolves(e.store, proj.ref)).toBeNull()
    const keepTip = await refResolves(e.store, keepRefName(proj.hash, 'sess-stale'))
    expect(keepTip).toBe(proj.sha3)
  })

  checkpointTest('3. expire dead keep-ref whose JSONL is gone', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    // Pre-seed a keep-ref whose JSONL doesn't exist.
    const deadKeep = keepRefName(proj.hash, 'sess-dead')
    const upR = await runCheckpointGit(
      ['update-ref', deadKeep, proj.sha2],
      { store: e.store, workTree: e.store },
    )
    expect(upR.ok).toBe(true)
    expect(await refResolves(e.store, deadKeep)).toBe(proj.sha2)

    const r = await pruneCheckpoints({ forceNow: true })
    expect(r.keepRefsExpired).toBeGreaterThanOrEqual(1)
    expect(await refResolves(e.store, deadKeep)).toBeNull()
  })

  checkpointTest('4. no recent sessions → orphan ref dropped, no keep-ref written', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    rmSync(proj.workdir, { recursive: true, force: true })
    const r = await pruneCheckpoints({ forceNow: true })

    expect(r.orphanRefsRemoved).toBe(1)
    expect(r.keepRefsAnchored).toBe(0)

    // No keep-refs under this project.
    const lr = await runCheckpointGit(
      ['for-each-ref', '--format=%(refname)', `${KEEP_REF_PREFIX}/${proj.hash}`],
      { store: e.store, workTree: e.store, allowedExitCodes: new Set([0, 128]) },
    )
    expect(lr.ok).toBe(true)
    expect(lr.stdout.trim()).toBe('')
  })

  checkpointTest('5. foreign hash in session JSONL → no spurious anchor', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    writeSessionJsonl({
      workdir: proj.workdir,
      sessionId: 'sess-foreign',
      hashes: ['a'.repeat(40)], // not in this ref's history
    })

    rmSync(proj.workdir, { recursive: true, force: true })
    const r = await pruneCheckpoints({ forceNow: true })

    expect(r.orphanRefsRemoved).toBe(1)
    expect(r.keepRefsAnchored).toBe(0)
    expect(await refResolves(e.store, keepRefName(proj.hash, 'sess-foreign'))).toBeNull()
  })

  checkpointTest('6. listProjectRefs filters _keep/ — keep-refs survive size-cap pass', async () => {
    const e = await ensureStore()
    if (!e.ok) throw new Error('ensureStore failed')
    const wts = mkdtempSync(join(tmpRoot, 'wts-'))
    const proj = await buildThreeCommitProject({ store: e.store, parent: wts })

    writeSessionJsonl({
      workdir: proj.workdir,
      sessionId: 'sess-live',
      hashes: [proj.sha2],
    })

    // Pre-seed a keep-ref. workdir intact, last_touch fresh — neither
    // orphan nor stale will fire on the project; size-cap iterates
    // listProjectRefs, which must filter the keep-ref out.
    const keep = keepRefName(proj.hash, 'sess-live')
    const upR = await runCheckpointGit(
      ['update-ref', keep, proj.sha3],
      { store: e.store, workTree: e.store },
    )
    expect(upR.ok).toBe(true)

    // Force size cap to attempt to bite (cap below current store size).
    const r = await pruneCheckpoints({
      forceNow: true,
      maxTotalSizeMb: 0.0001,
      retentionDays: 365,
    })

    // Keep-ref must still resolve at sha3.
    expect(await refResolves(e.store, keep)).toBe(proj.sha3)
    // Errors should not mention the keep-ref namespace specifically.
    for (const err of r.errors) {
      expect(err.includes('_keep')).toBe(false)
    }
  })
})
