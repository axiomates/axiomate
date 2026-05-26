import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import { indexPath, projectHash, refName } from '../../../../utils/checkpoints/paths.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { pruneRefToMaxN } from '../../../../utils/checkpoints/pruneRefToMaxN.js'
import { buildFixtureCommit } from './fixtures.js'

let tmpRoot: string
let workTree: string
let storeDir: string
let indexFile: string
let ref: string
let originalBase: string | undefined

beforeAll(() => {
  originalBase = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (originalBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalBase
})

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-prune-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
  storeDir = r.store
  const hash = projectHash(workTree)
  indexFile = indexPath(hash)
  ref = refName(hash)
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function commitCount(): Promise<number> {
  const r = await runCheckpointGit(['rev-list', '--count', ref], {
    store: storeDir,
    workTree,
    allowedExitCodes: new Set([128]),
  })
  if (r.ok === false) return 0
  return Number.parseInt(r.stdout.trim(), 10) || 0
}

async function commitSubjects(): Promise<string[]> {
  const r = await runCheckpointGit(
    ['log', '--format=%s', '--reverse', ref],
    { store: storeDir, workTree, allowedExitCodes: new Set([128]) },
  )
  if (r.ok === false) return []
  return r.stdout.split('\n').filter(s => s.length > 0)
}

async function makeNCommits(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await buildFixtureCommit({
      store: storeDir,
      workTree,
      indexFile,
      ref,
      files: { 'a.txt': `content-${i}` },
      subject: `axiomate:m${i}:turn ${i}`,
    })
  }
}

describe('pruneRefToMaxN — short-circuits', () => {
  test('returns null when ref does not exist', async () => {
    const result = await pruneRefToMaxN({
      store: storeDir,
      workTree,
      ref,
      maxN: 100,
    })
    expect(result).toBeNull()
  })

  test('returns null when count is exactly at the cap', async () => {
    await makeNCommits(5)
    expect(await commitCount()).toBe(5)

    const result = await pruneRefToMaxN({
      store: storeDir,
      workTree,
      ref,
      maxN: 5,
    })
    expect(result).toBeNull()
    expect(await commitCount()).toBe(5)
  })

  test('returns null when count is below the cap', async () => {
    await makeNCommits(3)
    const result = await pruneRefToMaxN({
      store: storeDir,
      workTree,
      ref,
      maxN: 100,
    })
    expect(result).toBeNull()
    expect(await commitCount()).toBe(3)
  })

  test('returns null when maxN <= 0 (no rebuild to empty)', async () => {
    await makeNCommits(5)
    const result = await pruneRefToMaxN({
      store: storeDir,
      workTree,
      ref,
      maxN: 0,
    })
    expect(result).toBeNull()
    expect(await commitCount()).toBe(5)
  })
})

describe('pruneRefToMaxN — actual prune', () => {
  test('rebuilds ref to last N commits, dropping the rest', async () => {
    await makeNCommits(10)
    expect(await commitCount()).toBe(10)
    const before = await commitSubjects()

    const result = await pruneRefToMaxN({
      store: storeDir,
      workTree,
      ref,
      maxN: 4,
    })

    expect(result).toBe(4)
    expect(await commitCount()).toBe(4)
    const after = await commitSubjects()
    // Subjects should be the LAST 4 of the original 10, in chronological order.
    expect(after).toEqual(before.slice(-4))
  }, 60_000)

  test('preserves subject content (so messageId parsing still works)', async () => {
    // The whole point of structured subjects (Decision #14) — prune
    // must not lose them. We assert by parsing back a known messageId.
    await makeNCommits(8)
    await pruneRefToMaxN({ store: storeDir, workTree, ref, maxN: 3 })

    const subjects = await commitSubjects()
    // Last 3 of {m0..m7} = m5, m6, m7.
    expect(subjects).toEqual([
      'axiomate:m5:turn 5',
      'axiomate:m6:turn 6',
      'axiomate:m7:turn 7',
    ])
  })

  test('chain after prune is linear (each commit has exactly one parent except the first)', async () => {
    await makeNCommits(7)
    await pruneRefToMaxN({ store: storeDir, workTree, ref, maxN: 3 })

    // %P = parent shas, space-separated, oldest → newest with --reverse.
    // First commit has empty parent line — keep blanks via slice.
    const r = await runCheckpointGit(
      ['log', '--format=%P', '--reverse', ref],
      { store: storeDir, workTree },
    )
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    // Strip a single trailing newline; preserve blank lines in the middle.
    const stripped = r.stdout.replace(/\n$/, '')
    const parents = stripped.split('\n')
    expect(parents).toHaveLength(3)
    // First commit: no parents (empty line). Rest: one parent each.
    expect(parents[0]).toBe('')
    expect(parents[1].split(' ').length).toBe(1)
    expect(parents[2].split(' ').length).toBe(1)
  })

  test('tree blobs are reused (no duplicate blob creation in rebuild)', async () => {
    // Each commit's tree references the SAME content-addressed blob
    // for `a.txt` content `content-0`..`content-9`. After prune, the
    // kept commits reference the same blobs they always did — we want
    // the reference to be the same, not a new blob with the same hash
    // (which would mean we're paying double IO).
    //
    // Easiest assertion: the `^{tree}` of the new tip equals the tree
    // of the original tip (same content → same tree → same SHA).
    await makeNCommits(10)
    const oldTip = await runCheckpointGit(
      ['rev-parse', `${ref}^{tree}`],
      { store: storeDir, workTree },
    )
    expect(oldTip.ok).toBe(true)
    if (oldTip.ok === false) return
    const oldTreeSha = oldTip.stdout.trim()

    await pruneRefToMaxN({ store: storeDir, workTree, ref, maxN: 4 })

    const newTip = await runCheckpointGit(
      ['rev-parse', `${ref}^{tree}`],
      { store: storeDir, workTree },
    )
    expect(newTip.ok).toBe(true)
    if (newTip.ok === false) return
    expect(newTip.stdout.trim()).toBe(oldTreeSha)
  })
})
