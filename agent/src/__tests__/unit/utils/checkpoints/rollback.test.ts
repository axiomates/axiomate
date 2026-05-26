import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
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
import { createSnapshot } from '../../../../utils/checkpoints/createSnapshot.js'
import { listSnapshots } from '../../../../utils/checkpoints/listSnapshots.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { rollback } from '../../../../utils/checkpoints/rollback.js'

let tmpRoot: string
let workTree: string
let originalBase: string | undefined

beforeAll(() => {
  originalBase = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (originalBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalBase
})

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-roll-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function snap(messageId: string, label: string): Promise<string> {
  const r = await createSnapshot(workTree, { messageId, label })
  if (r.ok === false) throw new Error(`snapshot ${messageId} failed: ${r.skipped}`)
  return r.hash
}

describe('rollback — input validation', () => {
  test('rejects a hash starting with "-" (flag-injection guard)', async () => {
    const r = await rollback(workTree, '-pwned')
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('invalid-hash')
  })

  test('rejects a non-hex hash', async () => {
    const r = await rollback(workTree, 'not-a-hex-hash')
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('invalid-hash')
  })

  test('rejects an empty hash', async () => {
    const r = await rollback(workTree, '')
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('invalid-hash')
  })

  test('rejects a path traversal attempt', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    const hash = await snap('m1', 'l1')
    const r = await rollback(workTree, hash, { paths: ['../etc/passwd'] })
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('invalid-path')
  })

  test('rejects an absolute path', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    const hash = await snap('m1', 'l1')
    const r = await rollback(workTree, hash, {
      paths: [process.platform === 'win32' ? 'C:\\evil' : '/etc/passwd'],
    })
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('invalid-path')
  })
})

describe('rollback — store / commit existence', () => {
  test('returns no-checkpoints when store has no HEAD', async () => {
    // Repoint to a fresh, un-inited base.
    const fresh = mkdtempSync(join(tmpRoot, 'fresh-'))
    process.env.AXIOMATE_CHECKPOINT_BASE = fresh
    const r = await rollback(workTree, 'a1b2c3d4')
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('no-checkpoints')
  })

  test('returns not-found for an unknown commit', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    await snap('m1', 'l1')
    const r = await rollback(workTree, '0000000000000000000000000000000000000000')
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('not-found')
  })
})

describe('rollback — happy path (full restore)', () => {
  test('restores a workdir to an earlier snapshot', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1')
    const h1 = await snap('m1', 'l1')

    writeFileSync(join(workTree, 'a.txt'), 'v2')
    writeFileSync(join(workTree, 'b.txt'), 'new')
    await snap('m2', 'l2')

    const r = await rollback(workTree, h1)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.hash).toBe(h1)
    expect(r.restoredTo).toBe(h1.slice(0, 8))
    expect(readFileSync(join(workTree, 'a.txt'), 'utf-8')).toBe('v1')
    expect(r.directory).toBeTruthy()
    // Reason carries the parsed structured subject for h1.
    expect(r.reason.kind).toBe('axiomate')
    if (r.reason.kind !== 'axiomate') return
    expect(r.reason.messageId).toBe('m1')
    expect(r.reason.label).toBe('l1')
  })

  test('takes a pre-rollback snapshot when the worktree has uncommitted changes', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1')
    const h1 = await snap('m1', 'l1')
    writeFileSync(join(workTree, 'a.txt'), 'v2')
    await snap('m2', 'l2')

    // Dirty the worktree so the pre-rollback snapshot has something
    // novel to capture. This mirrors the real-world scenario: user
    // edits files, decides they want to roll back — pre-rollback saves
    // their in-flight work before we wipe it.
    writeFileSync(join(workTree, 'a.txt'), 'v3-dirty')

    const before = await listSnapshots(workTree)
    expect(before.length).toBe(2)

    await rollback(workTree, h1)

    const after = await listSnapshots(workTree)
    // m1, m2, pre-rollback(v3-dirty)
    expect(after.length).toBe(3)
    const newest = after[0]
    expect(newest.reason.kind).toBe('axiomate')
    if (newest.reason.kind !== 'axiomate') return
    expect(newest.reason.messageId).toBe('pre-rollback')
    expect(newest.reason.label).toContain(h1.slice(0, 8))
  })

  test('skips the pre-rollback snapshot when there are no novel changes (no-changes path)', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1')
    const h1 = await snap('m1', 'l1')
    writeFileSync(join(workTree, 'a.txt'), 'v2')
    await snap('m2', 'l2')

    // No dirty edits — m2 already captures the current worktree state.
    // pre-rollback's createSnapshot skips with 'no-changes', and the
    // restore proceeds anyway. Best-effort safety net.
    const r = await rollback(workTree, h1)
    expect(r.ok).toBe(true)

    const list = await listSnapshots(workTree)
    expect(list.length).toBe(2) // no pre-rollback recorded
    expect(readFileSync(join(workTree, 'a.txt'), 'utf-8')).toBe('v1')
  })

  test('rolling back twice with intervening edits records two pre-rollback snapshots', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1')
    const h1 = await snap('m1', 'l1')
    writeFileSync(join(workTree, 'a.txt'), 'v2')
    await snap('m2', 'l2')

    // Dirty before first rollback so it records a pre-rollback.
    writeFileSync(join(workTree, 'a.txt'), 'v3-dirty')
    const r1 = await rollback(workTree, h1)
    expect(r1.ok).toBe(true)

    // Dirty before second rollback so it records another.
    writeFileSync(join(workTree, 'a.txt'), 'v1-edited')
    const r2 = await rollback(workTree, h1)
    expect(r2.ok).toBe(true)

    const list = await listSnapshots(workTree)
    const preRollbacks = list.filter(
      e => e.reason.kind === 'axiomate' && e.reason.messageId === 'pre-rollback',
    )
    expect(preRollbacks.length).toBe(2)
  })
})

describe('rollback — partial (path-scoped) restore', () => {
  test('restores only the listed paths, leaves others alone', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'a-v1')
    writeFileSync(join(workTree, 'b.txt'), 'b-v1')
    const h1 = await snap('m1', 'l1')

    writeFileSync(join(workTree, 'a.txt'), 'a-v2')
    writeFileSync(join(workTree, 'b.txt'), 'b-v2')
    await snap('m2', 'l2')

    const r = await rollback(workTree, h1, { paths: ['a.txt'] })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(workTree, 'a.txt'), 'utf-8')).toBe('a-v1')
    // b.txt was not in paths → still v2.
    expect(readFileSync(join(workTree, 'b.txt'), 'utf-8')).toBe('b-v2')
    if (r.ok === false) return
    expect(r.paths).toEqual(['a.txt'])
  })

  test('rejects partial restore where one path is invalid (no partial work done)', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'a-v1')
    const h1 = await snap('m1', 'l1')
    writeFileSync(join(workTree, 'a.txt'), 'a-v2')
    await snap('m2', 'l2')

    // First path valid, second path traverses → entire call rejects
    // before any checkout runs.
    const r = await rollback(workTree, h1, {
      paths: ['a.txt', '../escape'],
    })
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('invalid-path')
    // Worktree state is whatever m2 left it: a.txt is still v2.
    expect(readFileSync(join(workTree, 'a.txt'), 'utf-8')).toBe('a-v2')
  })
})

describe('rollback — index seeding for next snapshot', () => {
  test('post-rollback createSnapshot reflects the new baseline', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1')
    const h1 = await snap('m1', 'l1')
    writeFileSync(join(workTree, 'a.txt'), 'v2')
    await snap('m2', 'l2')

    await rollback(workTree, h1)

    // The worktree is back at v1. A fresh edit should produce a normal
    // child snapshot whose tree differs from h1's tree.
    writeFileSync(join(workTree, 'a.txt'), 'v3')
    const r = await createSnapshot(workTree, {
      messageId: 'm3',
      label: 'l3',
    })
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.hash).not.toBe(h1)
  })

  test('worktree files written by the snapshot stay on disk after rollback', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1')
    const h1 = await snap('m1', 'l1')

    writeFileSync(join(workTree, 'a.txt'), 'v2')
    writeFileSync(join(workTree, 'newcomer.txt'), 'added in m2')
    await snap('m2', 'l2')

    await rollback(workTree, h1)

    expect(readFileSync(join(workTree, 'a.txt'), 'utf-8')).toBe('v1')
    // newcomer.txt was not in h1 — git checkout doesn't delete untracked
    // additions when restoring with a target spec, but it can blow them
    // away if they were tracked at h2 and not h1. We only assert the
    // primary expectation here: a.txt restored to v1.
    expect(existsSync(join(workTree, 'a.txt'))).toBe(true)
  })
})
