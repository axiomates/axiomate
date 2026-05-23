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
import { createSnapshot } from '../createSnapshot.js'
import { ensureStore } from '../store.js'
import { listSnapshots } from '../listSnapshots.js'

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-list-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('listSnapshots — empty / missing-state paths', () => {
  test('returns [] when store has no HEAD yet', async () => {
    // Point base at a fresh dir that has not been ensureStore'd. We
    // achieve this by mutating the env override mid-test — listSnapshots
    // re-reads it on every call.
    const fresh = mkdtempSync(join(tmpRoot, 'fresh-'))
    process.env.AXIOMATE_CHECKPOINT_BASE = fresh
    const result = await listSnapshots(workTree)
    expect(result).toEqual([])
  })

  test('returns [] when ref does not exist (store inited but no commits for this project)', async () => {
    const result = await listSnapshots(workTree)
    expect(result).toEqual([])
  })

  test('returns [] when limit is 0 or negative', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    await createSnapshot(workTree, { messageId: 'm1', label: 'l1' })

    expect(await listSnapshots(workTree, { limit: 0 })).toEqual([])
    expect(await listSnapshots(workTree, { limit: -5 })).toEqual([])
  })
})

describe('listSnapshots — one snapshot', () => {
  test('returns a single entry with parsed reason', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    const snap = await createSnapshot(workTree, {
      messageId: 'msg-001',
      label: 'first turn',
    })
    if (snap.ok === false) throw new Error('snapshot failed')

    const list = await listSnapshots(workTree)
    expect(list.length).toBe(1)
    const e = list[0]
    expect(e.hash).toBe(snap.hash)
    expect(e.shortHash.length).toBeGreaterThan(0)
    expect(e.shortHash.length).toBeLessThan(e.hash.length)
    expect(e.subject).toBe('axiomate:msg-001:first turn')
    expect(e.reason.kind).toBe('axiomate')
    if (e.reason.kind !== 'axiomate') return
    expect(e.reason.messageId).toBe('msg-001')
    expect(e.reason.label).toBe('first turn')

    // Default (`withBodies: false`) leaves body empty.
    expect(e.body).toBe('')

    // ISO 8601 with T and timezone offset.
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

    // Root commit's batched `git log --shortstat` reports its full-tree
    // diff (vs empty) — so a single-file root commit shows that file
    // changed. Previous per-row implementation ran `git diff <hash>~1`
    // which errors on root and left stats at 0; the batched form is
    // strictly more informative.
    expect(e.filesChanged).toBe(1)
    expect(e.insertions).toBeGreaterThan(0)
  })
})

describe('listSnapshots — many snapshots', () => {
  test('returns newest-first', async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(workTree, 'a.txt'), `content-${i}`)
      await createSnapshot(workTree, {
        messageId: `m${i}`,
        label: `turn ${i}`,
      })
    }

    const list = await listSnapshots(workTree)
    expect(list.length).toBe(5)
    const messageIds = list.map(e =>
      e.reason.kind === 'axiomate' ? e.reason.messageId : 'raw',
    )
    // newest first → m4, m3, m2, m1, m0
    expect(messageIds).toEqual(['m4', 'm3', 'm2', 'm1', 'm0'])
  })

  test('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(workTree, 'a.txt'), `content-${i}`)
      await createSnapshot(workTree, {
        messageId: `m${i}`,
        label: `turn ${i}`,
      })
    }
    const list = await listSnapshots(workTree, { limit: 2 })
    expect(list.length).toBe(2)
    const messageIds = list.map(e =>
      e.reason.kind === 'axiomate' ? e.reason.messageId : 'raw',
    )
    expect(messageIds).toEqual(['m4', 'm3'])
  })

  test('stat fields populated for non-root commits', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'one\n')
    await createSnapshot(workTree, { messageId: 'm0', label: 'l0' })
    writeFileSync(join(workTree, 'a.txt'), 'one\ntwo\nthree\n')
    await createSnapshot(workTree, { messageId: 'm1', label: 'l1' })

    const list = await listSnapshots(workTree)
    expect(list.length).toBe(2)
    // newest first → m1 (delta), m0 (root, full-tree diff vs empty)
    const m1 = list[0]
    const m0 = list[1]
    expect(m1.filesChanged).toBe(1)
    expect(m1.insertions).toBe(2) // two new lines
    // Batched git log --shortstat reports root commit's full-tree diff
    // (vs empty); previous per-row diff <hash>~1 errored on root and
    // left stats at 0. The new value is more informative.
    expect(m0.filesChanged).toBe(1)
    expect(m0.insertions).toBe(1)
  })

  test('withStats: false skips per-commit diff invocations', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'one\n')
    await createSnapshot(workTree, { messageId: 'm0', label: 'l0' })
    writeFileSync(join(workTree, 'a.txt'), 'one\ntwo\n')
    await createSnapshot(workTree, { messageId: 'm1', label: 'l1' })

    const list = await listSnapshots(workTree, { withStats: false })
    expect(list.length).toBe(2)
    for (const e of list) {
      expect(e.filesChanged).toBe(0)
      expect(e.insertions).toBe(0)
      expect(e.deletions).toBe(0)
    }
  })
})

describe('listSnapshots — subject parsing edge cases', () => {
  test('label containing : still parses (only first two : are separators)', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    await createSnapshot(workTree, {
      messageId: 'mid',
      label: 'edit src/foo.ts: line 12',
    })
    const list = await listSnapshots(workTree)
    expect(list.length).toBe(1)
    if (list[0].reason.kind !== 'axiomate') throw new Error('expected axiomate')
    expect(list[0].reason.label).toBe('edit src/foo.ts: line 12')
  })

  test('non-conforming subject (raw) round-trips with kind: raw', async () => {
    // Bypass createSnapshot — write a raw subject directly via plumbing.
    const { runCheckpointGit } = await import('../git.js')
    const { projectHash, refName, indexPath } = await import('../paths.js')
    const hash = projectHash(workTree)
    const ref = refName(hash)
    const indexFile = indexPath(hash)
    const r = await ensureStore()
    if (r.ok === false) throw new Error('ensure failed')
    const store = r.store

    writeFileSync(join(workTree, 'a.txt'), '1')
    const add = await runCheckpointGit(['add', '-A'], {
      store,
      workTree,
      indexFile,
    })
    if (add.ok === false) throw new Error('add failed')
    const writeTree = await runCheckpointGit(['write-tree'], {
      store,
      workTree,
      indexFile,
    })
    if (writeTree.ok === false) throw new Error('write-tree failed')
    const ct = await runCheckpointGit(
      [
        'commit-tree',
        writeTree.stdout.trim(),
        '-m',
        'manual commit no prefix',
        '--no-gpg-sign',
      ],
      { store, workTree, indexFile },
    )
    if (ct.ok === false) throw new Error('commit-tree failed')
    const upd = await runCheckpointGit(
      ['update-ref', ref, ct.stdout.trim()],
      { store, workTree, indexFile },
    )
    if (upd.ok === false) throw new Error('update-ref failed')

    const list = await listSnapshots(workTree)
    expect(list.length).toBe(1)
    expect(list[0].reason.kind).toBe('raw')
    if (list[0].reason.kind !== 'raw') return
    expect(list[0].reason.subject).toBe('manual commit no prefix')
  })
})

describe('listSnapshots — withBodies', () => {
  test('returns commit body when withBodies: true', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    await createSnapshot(workTree, {
      messageId: 'msg-bod',
      label: 'lbl',
      bodyText: 'rename this function please',
    })

    const list = await listSnapshots(workTree, { withBodies: true })
    expect(list.length).toBe(1)
    expect(list[0].body).toBe('rename this function please')
    // Default still leaves body empty.
    const listNoBodies = await listSnapshots(workTree)
    expect(listNoBodies[0].body).toBe('')
  })

  test('subject containing | parses correctly with withBodies', async () => {
    // The withBodies path uses SOH (\x01) as field separator instead
    // of `|`, so subjects with `|` characters round-trip cleanly —
    // pinning that this path is `|`-safe even though the legacy path
    // had to splitMax to preserve them.
    writeFileSync(join(workTree, 'a.txt'), '1')
    await createSnapshot(workTree, {
      messageId: 'msg-pipe',
      label: 'edit a|b',
      bodyText: 'first | second | third',
    })
    const list = await listSnapshots(workTree, { withBodies: true })
    expect(list.length).toBe(1)
    expect(list[0].body).toBe('first | second | third')
    if (list[0].reason.kind === 'axiomate') {
      expect(list[0].reason.label).toBe('edit a|b')
    }
  })

  test('multiline body preserved up to trailing whitespace', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    await createSnapshot(workTree, {
      messageId: 'msg-multi',
      label: 'lbl',
      bodyText: 'line1\nline2\nline3',
    })
    const list = await listSnapshots(workTree, { withBodies: true })
    expect(list.length).toBe(1)
    expect(list[0].body).toBe('line1\nline2\nline3')
  })

  test('empty body when no bodyText given', async () => {
    writeFileSync(join(workTree, 'a.txt'), '1')
    await createSnapshot(workTree, { messageId: 'msg-no-body', label: 'lbl' })
    const list = await listSnapshots(workTree, { withBodies: true })
    expect(list.length).toBe(1)
    expect(list[0].body).toBe('')
  })
})
