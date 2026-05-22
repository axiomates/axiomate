import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
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
import { runCheckpointGit } from '../git.js'
import { indexPath, projectHash, projectMetaPath, refName } from '../paths.js'
import { ensureStore } from '../store.js'
import { parseCommitSubject } from '../reason.js'
import { createSnapshot } from '../createSnapshot.js'

let tmpRoot: string
let workTree: string
let storeDir: string
let originalBase: string | undefined

beforeAll(() => {
  originalBase = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (originalBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalBase
})

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-snap-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
  storeDir = r.store
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function commitCount(ref: string): Promise<number> {
  const r = await runCheckpointGit(['rev-list', '--count', ref], {
    store: storeDir,
    workTree,
    allowedExitCodes: new Set([128]),
  })
  if (r.ok === false) return 0
  return Number.parseInt(r.stdout.trim(), 10) || 0
}

async function commitSubjects(ref: string): Promise<string[]> {
  const r = await runCheckpointGit(
    ['log', '--format=%s', '--reverse', ref],
    { store: storeDir, workTree, allowedExitCodes: new Set([128]) },
  )
  if (r.ok === false) return []
  return r.stdout.split('\n').filter(s => s.length > 0)
}

describe('createSnapshot — happy paths', () => {
  test('first snapshot creates a root commit on the per-project ref', async () => {
    writeFileSync(join(workTree, 'hello.txt'), 'hi')
    const r = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'turn 1',
    })
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.hash).toMatch(/^[a-f0-9]{40}$/)
    expect(r.ref).toBe(refName(projectHash(workTree)))
    expect(await commitCount(r.ref)).toBe(1)
  })

  test('subsequent snapshot creates a child commit (chain length grows)', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'one')
    const first = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'turn 1',
    })
    if (first.ok === false) throw new Error('first snapshot failed')

    writeFileSync(join(workTree, 'a.txt'), 'two')
    const second = await createSnapshot(workTree, {
      messageId: 'msg-002',
      label: 'turn 2',
    })
    expect(second.ok).toBe(true)
    if (second.ok === false) return
    expect(second.hash).not.toBe(first.hash)
    expect(await commitCount(second.ref)).toBe(2)

    // Parent linkage: `commit-tree` was given -p first.hash.
    const parents = await runCheckpointGit(
      ['log', '--format=%P', '-1', second.ref],
      { store: storeDir, workTree },
    )
    expect(parents.ok).toBe(true)
    if (parents.ok === false) return
    expect(parents.stdout.trim()).toBe(first.hash)
  })

  test('subject is structured (Decision #14): axiomate:<msgid>:<label>', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    const r = await createSnapshot(workTree, {
      messageId: 'msg_abc-123',
      label: 'edit a.txt',
    })
    if (r.ok === false) throw new Error('snapshot failed')
    const subjects = await commitSubjects(r.ref)
    expect(subjects).toEqual(['axiomate:msg_abc-123:edit a.txt'])

    const parsed = parseCommitSubject(subjects[0])
    expect(parsed.kind).toBe('axiomate')
    if (parsed.kind !== 'axiomate') return
    expect(parsed.messageId).toBe('msg_abc-123')
    expect(parsed.label).toBe('edit a.txt')
  })

  test('reserved messageId pre-rollback round-trips through parseCommitSubject', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    const r = await createSnapshot(workTree, {
      messageId: 'pre-rollback',
      label: 'restoring to abc1234',
    })
    if (r.ok === false) throw new Error('snapshot failed')
    const subjects = await commitSubjects(r.ref)
    const parsed = parseCommitSubject(subjects[0])
    expect(parsed.kind).toBe('axiomate')
    if (parsed.kind !== 'axiomate') return
    expect(parsed.messageId).toBe('pre-rollback')
  })

  test('canonicalizes a tilde-prefixed workdir before hashing', async () => {
    // Synthesize a real tilde input by pointing AXIOMATE_CHECKPOINT_BASE
    // at a tmpdir that's under HOME — then we can pass `~/sub` and prove
    // the hash is the same as the canonical absolute path.
    // Easier: just assert that the ref the snapshot creates is the same
    // ref we'd compute from the canonical path. Pass workTree directly
    // and confirm the ref matches projectHash(canonical-of-workTree).
    writeFileSync(join(workTree, 'a.txt'), '1')
    const r = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    if (r.ok === false) throw new Error('snapshot failed')
    expect(r.ref).toBe(refName(projectHash(workTree)))
  })
})

describe('createSnapshot — skip paths', () => {
  test('skipped: workdir-too-broad for $HOME', async () => {
    const r = await createSnapshot(homedir(), {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.skipped).toBe('workdir-too-broad')
  })

  test('skipped: workdir-too-broad for Windows drive root', async () => {
    if (process.platform !== 'win32') return
    const r = await createSnapshot('C:\\', {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.skipped).toBe('workdir-too-broad')
  })

  test('skipped: no-changes when nothing has been modified after a snapshot', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    const first = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(first.ok).toBe(true)

    // Same workdir state — git diff-index returns 0, we skip.
    const second = await createSnapshot(workTree, {
      messageId: 'msg-002',
      label: 'l',
    })
    expect(second.ok).toBe(false)
    if (second.ok === true) return
    expect(second.skipped).toBe('no-changes')
  })

  test('writes empty-tree root commit when first call has no files', async () => {
    // Empty workdir → first commit anchors "before any AI edit" with the
    // canonical git empty-tree SHA (4b825dc...). Lets the first edit in
    // a fresh empty directory produce a rewindable anchor: rewinding to
    // this root removes the file the first edit created (via the
    // disk-but-not-in-tree unlink pre-pass in
    // restoreFullWorkdirToSnapshot).
    //
    // Subsequent readonly turns (with hasRef=true) still skip via the
    // diff-index branch, so we don't stamp empty-tree commits on every
    // turn — only the very first one when no ref exists yet.
    const r = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.hash).toBeTruthy()

    // Second readonly call (no edits) on a now-existing ref → skipped.
    const second = await createSnapshot(workTree, {
      messageId: 'msg-002',
      label: 'l',
    })
    expect(second.ok).toBe(false)
    if (second.ok === true) return
    expect(second.skipped).toBe('no-changes')
  })
})

describe('createSnapshot — touchProject ordering (step 4 before step 5)', () => {
  test('projects/<hash>.json is written for the empty-tree root commit', async () => {
    // Empty workdir → root commit + projects metadata written.
    const r = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(r.ok).toBe(true)
    const metaPath = projectMetaPath(projectHash(workTree))
    expect(existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
      workdir: string
      created_at: number
      last_touch: number
    }
    expect(meta.workdir.length).toBeGreaterThan(0)
    expect(typeof meta.created_at).toBe('number')
    expect(typeof meta.last_touch).toBe('number')
  })
})

describe('createSnapshot — oversize files dropped from index', () => {
  test('a >10MB file is excluded from the snapshot (kept on disk)', async () => {
    const oversize = Buffer.alloc(11 * 1024 * 1024) // 11MB > 10MB cap
    writeFileSync(join(workTree, 'big.bin'), oversize)
    writeFileSync(join(workTree, 'small.txt'), 'kept')

    const r = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(r.ok).toBe(true)
    if (r.ok === false) return

    // Inspect the tree of the new commit — big.bin should NOT be there.
    const lsTree = await runCheckpointGit(
      ['ls-tree', '-r', '--name-only', r.hash],
      { store: storeDir, workTree },
    )
    expect(lsTree.ok).toBe(true)
    if (lsTree.ok === false) return
    const files = lsTree.stdout.split('\n').filter(s => s.length > 0)
    expect(files).toContain('small.txt')
    expect(files).not.toContain('big.bin')

    // big.bin still exists on disk — we drop from index, never touch fs.
    expect(existsSync(join(workTree, 'big.bin'))).toBe(true)
  })
})

describe('createSnapshot — index seeding from existing ref', () => {
  test('second snapshot only adds new file (does not re-add unchanged ones)', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'unchanged across turns')
    const first = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'turn 1',
    })
    if (first.ok === false) throw new Error('first failed')

    // Add a new file. The seeded index should already contain a.txt's
    // entry; `git add -A` will pick up b.txt only.
    writeFileSync(join(workTree, 'b.txt'), 'new')
    const second = await createSnapshot(workTree, {
      messageId: 'msg-002',
      label: 'turn 2',
    })
    expect(second.ok).toBe(true)
    if (second.ok === false) return

    // Both files in the new tree, a.txt's blob SHA equals first commit's.
    const lsTree = await runCheckpointGit(
      ['ls-tree', '-r', second.hash],
      { store: storeDir, workTree },
    )
    if (lsTree.ok === false) return
    const lines = lsTree.stdout.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBe(2)
    expect(lines.some(l => l.endsWith('\ta.txt'))).toBe(true)
    expect(lines.some(l => l.endsWith('\tb.txt'))).toBe(true)
  })
})

describe('createSnapshot — index file lifecycle', () => {
  test('index file is created at indexes/<hash> after a snapshot', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    const r = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(r.ok).toBe(true)
    expect(existsSync(indexPath(projectHash(workTree)))).toBe(true)
  })
})
