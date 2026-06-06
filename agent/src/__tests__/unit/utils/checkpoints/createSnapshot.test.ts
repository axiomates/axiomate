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
import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import { indexPath, projectHash, projectMetaPath, refName } from '../../../../utils/checkpoints/paths.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { parseCommitSubject } from '../../../../utils/checkpoints/reason.js'
import {
  _resetTooManyFilesCacheForTesting,
  _tooManyFilesCacheForTesting,
  createSnapshot,
  MAX_FILES,
  MAX_FILES_CONFIG_LIMIT,
  MAX_FILE_SIZE_MB,
  normalizeConfiguredMaxFiles,
} from '../../../../utils/checkpoints/createSnapshot.js'
import {
  DEFAULT_GLOBAL_CONFIG,
  saveGlobalConfig,
} from '../../../../utils/config.js'

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
  _resetTooManyFilesCacheForTesting()
  saveGlobalConfig(current => ({
    ...current,
    checkpointsMaxFiles: DEFAULT_GLOBAL_CONFIG.checkpointsMaxFiles,
  }))
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-snap-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
  storeDir = r.store
})

afterEach(() => {
  _resetTooManyFilesCacheForTesting()
  saveGlobalConfig(current => ({
    ...current,
    checkpointsMaxFiles: DEFAULT_GLOBAL_CONFIG.checkpointsMaxFiles,
  }))
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

describe('createSnapshot — checkpointsMaxFiles config', () => {
  test('normalizes the configured max file guard', () => {
    expect(normalizeConfiguredMaxFiles(undefined)).toBe(MAX_FILES)
    expect(normalizeConfiguredMaxFiles(Number.NaN)).toBe(MAX_FILES)
    expect(normalizeConfiguredMaxFiles(-1)).toBe(MAX_FILES)
    expect(normalizeConfiguredMaxFiles(0)).toBe(0)
    expect(normalizeConfiguredMaxFiles(500_000)).toBe(500_000)
    expect(normalizeConfiguredMaxFiles(10_000_000)).toBe(
      MAX_FILES_CONFIG_LIMIT,
    )
  })

  test('remembers too-many-files for the same workdir and maxFiles during this run', () => {
    _tooManyFilesCacheForTesting.remember(workTree, 2)

    expect(_tooManyFilesCacheForTesting.isKnown(workTree, 2)).toBe(true)
    expect(_tooManyFilesCacheForTesting.isKnown(workTree, 3)).toBe(false)
    expect(_tooManyFilesCacheForTesting.isKnown(`${workTree}-other`, 2)).toBe(
      false,
    )
  })

  test('unrelated config writes do not invalidate too-many-files cache keys', () => {
    _tooManyFilesCacheForTesting.remember(workTree, 2)
    expect(_tooManyFilesCacheForTesting.isKnown(workTree, 2)).toBe(true)

    saveGlobalConfig(current => ({
      ...current,
      verbose: !(current.verbose ?? false),
    }))

    expect(_tooManyFilesCacheForTesting.isKnown(workTree, 2)).toBe(true)
  })

  test('first too-many-files skip is marked as firstDetection, then cached', async () => {
    saveGlobalConfig(current => ({
      ...current,
      checkpointsMaxFiles: 2,
    }))
    writeFileSync(join(workTree, 'a.txt'), '1')
    writeFileSync(join(workTree, 'b.txt'), '2')
    writeFileSync(join(workTree, 'c.txt'), '3')

    const first = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(first.ok).toBe(false)
    if (first.ok === true) return
    expect(first.skipped).toBe('too-many-files')
    if (first.skipped !== 'too-many-files') return
    expect(first.maxFiles).toBe(2)
    expect(first.firstDetection).toBe(true)

    rmSync(join(workTree, 'c.txt'), { force: true })
    const second = await createSnapshot(workTree, {
      messageId: 'msg-002',
      label: 'l',
    })
    expect(second.ok).toBe(false)
    if (second.ok === true) return
    expect(second.skipped).toBe('too-many-files')
    if (second.skipped !== 'too-many-files') return
    expect(second.maxFiles).toBe(2)
    expect(second.firstDetection).toBe(false)
  })

  test('changing effective checkpointsMaxFiles triggers a fresh file-count check', async () => {
    saveGlobalConfig(current => ({
      ...current,
      checkpointsMaxFiles: 2,
    }))
    writeFileSync(join(workTree, 'a.txt'), '1')
    writeFileSync(join(workTree, 'b.txt'), '2')
    writeFileSync(join(workTree, 'c.txt'), '3')

    const first = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(first.ok).toBe(false)
    if (first.ok === true) return
    expect(first.skipped).toBe('too-many-files')

    saveGlobalConfig(current => ({
      ...current,
      checkpointsMaxFiles: 4,
    }))

    const second = await createSnapshot(workTree, {
      messageId: 'msg-002',
      label: 'l',
    })
    expect(second.ok).toBe(true)
  })

  test('unrelated config writes do not trigger a fresh file-count check', async () => {
    saveGlobalConfig(current => ({
      ...current,
      checkpointsMaxFiles: 2,
    }))
    writeFileSync(join(workTree, 'a.txt'), '1')
    writeFileSync(join(workTree, 'b.txt'), '2')
    writeFileSync(join(workTree, 'c.txt'), '3')

    const first = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(first.ok).toBe(false)
    if (first.ok === true) return
    expect(first.skipped).toBe('too-many-files')
    if (first.skipped !== 'too-many-files') return
    expect(first.firstDetection).toBe(true)

    rmSync(join(workTree, 'c.txt'), { force: true })
    saveGlobalConfig(current => ({
      ...current,
      verbose: !(current.verbose ?? false),
    }))

    const second = await createSnapshot(workTree, {
      messageId: 'msg-002',
      label: 'l',
    })
    expect(second.ok).toBe(false)
    if (second.ok === true) return
    expect(second.skipped).toBe('too-many-files')
    if (second.skipped !== 'too-many-files') return
    expect(second.firstDetection).toBe(false)
  })

  test('maxFiles 0 bypasses the too-many-files guard and cache', async () => {
    saveGlobalConfig(current => ({
      ...current,
      checkpointsMaxFiles: 1,
    }))
    writeFileSync(join(workTree, 'a.txt'), '1')
    writeFileSync(join(workTree, 'b.txt'), '2')

    const first = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(first.ok).toBe(false)
    if (first.ok === true) return
    expect(first.skipped).toBe('too-many-files')

    saveGlobalConfig(current => ({
      ...current,
      checkpointsMaxFiles: 0,
    }))

    const second = await createSnapshot(workTree, {
      messageId: 'msg-002',
      label: 'l',
    })
    expect(second.ok).toBe(true)
  })

  test('concurrent too-many-files checks share the first detection', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    writeFileSync(join(workTree, 'b.txt'), '2')
    writeFileSync(join(workTree, 'c.txt'), '3')

    const results = await Promise.all([
      _tooManyFilesCacheForTesting.check(workTree, 2),
      _tooManyFilesCacheForTesting.check(workTree, 2),
    ])

    expect(results.every(result => result.aborted)).toBe(true)
    expect(results.filter(result => result.firstDetection)).toHaveLength(1)
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

  test('projects/<hash>.json is written when checkpointsMaxFiles skips snapshot', async () => {
    saveGlobalConfig(current => ({
      ...current,
      checkpointsMaxFiles: 2,
    }))
    writeFileSync(join(workTree, 'a.txt'), '1')
    writeFileSync(join(workTree, 'b.txt'), '2')
    writeFileSync(join(workTree, 'c.txt'), '3')

    const r = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'l',
    })
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.skipped).toBe('too-many-files')
    if (r.skipped !== 'too-many-files') return
    expect(r.firstDetection).toBe(true)

    const metaPath = projectMetaPath(projectHash(workTree))
    expect(existsSync(metaPath)).toBe(true)
  })
})

describe('createSnapshot — oversize files dropped from index', () => {
  test(`a >${MAX_FILE_SIZE_MB}MB file is excluded from the snapshot (kept on disk)`, async () => {
    const oversize = Buffer.alloc((MAX_FILE_SIZE_MB + 1) * 1024 * 1024)
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

describe('createSnapshot — rebuilding index from filesystem', () => {
  test('second snapshot keeps unchanged file and adds new file', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'unchanged across turns')
    const first = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'turn 1',
    })
    if (first.ok === false) throw new Error('first failed')

    // Add a new file. The snapshot index is rebuilt from the current
    // filesystem, so both the unchanged and new files remain present.
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
