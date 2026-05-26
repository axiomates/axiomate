import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import { indexPath, projectHash } from '../../../../utils/checkpoints/paths.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { dropOversizeFromIndex } from '../../../../utils/checkpoints/dropOversizeFromIndex.js'

let tmpRoot: string
let workTree: string
let storeDir: string
let indexFile: string
let originalBase: string | undefined

beforeAll(() => {
  originalBase = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (originalBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalBase
})

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-drop-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
  storeDir = r.store
  indexFile = indexPath(projectHash(workTree))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function stageAll(): Promise<void> {
  const r = await runCheckpointGit(['add', '-A'], {
    store: storeDir,
    workTree,
    indexFile,
  })
  if (r.ok === false) throw new Error(`git add -A failed: ${r.message}`)
}

async function lsCached(): Promise<string[]> {
  const r = await runCheckpointGit(['ls-files', '--cached'], {
    store: storeDir,
    workTree,
    indexFile,
  })
  if (r.ok === false) throw new Error(`ls-files failed: ${r.message}`)
  return r.stdout.split('\n').filter(p => p.length > 0)
}

describe('dropOversizeFromIndex', () => {
  test('removes a single oversize file from the index, keeps small ones', async () => {
    writeFileSync(join(workTree, 'small.txt'), 'tiny')
    // 2MB binary file with cap at 1MB.
    writeFileSync(join(workTree, 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
    await stageAll()

    expect((await lsCached()).sort()).toEqual(['big.bin', 'small.txt'])

    const dropped = await dropOversizeFromIndex({
      store: storeDir,
      workTree,
      indexFile,
      maxFileSizeMb: 1,
    })
    expect(dropped).toBe(1)
    expect((await lsCached()).sort()).toEqual(['small.txt'])
  })

  test('removes multiple oversize files in one pass', async () => {
    writeFileSync(join(workTree, 'a.bin'), Buffer.alloc(2 * 1024 * 1024))
    writeFileSync(join(workTree, 'b.bin'), Buffer.alloc(2 * 1024 * 1024))
    writeFileSync(join(workTree, 'c.bin'), Buffer.alloc(2 * 1024 * 1024))
    writeFileSync(join(workTree, 'small.txt'), 'tiny')
    await stageAll()

    const dropped = await dropOversizeFromIndex({
      store: storeDir,
      workTree,
      indexFile,
      maxFileSizeMb: 1,
    })
    expect(dropped).toBe(3)
    expect((await lsCached())).toEqual(['small.txt'])
  })

  test('returns 0 when nothing is oversize', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'one')
    writeFileSync(join(workTree, 'b.txt'), 'two')
    await stageAll()

    const dropped = await dropOversizeFromIndex({
      store: storeDir,
      workTree,
      indexFile,
      maxFileSizeMb: 1,
    })
    expect(dropped).toBe(0)
    expect((await lsCached()).sort()).toEqual(['a.txt', 'b.txt'])
  })

  test('returns 0 when index is empty', async () => {
    // No stageAll() — index is fresh. But git ls-files on a never-touched
    // index returns empty stdout, which our short-circuit handles.
    const dropped = await dropOversizeFromIndex({
      store: storeDir,
      workTree,
      indexFile,
      maxFileSizeMb: 1,
    })
    expect(dropped).toBe(0)
  })

  test('short-circuits when maxFileSizeMb <= 0 (Hermes "disabled" sentinel)', async () => {
    writeFileSync(join(workTree, 'big.bin'), Buffer.alloc(5 * 1024 * 1024))
    await stageAll()

    const dropped = await dropOversizeFromIndex({
      store: storeDir,
      workTree,
      indexFile,
      maxFileSizeMb: 0,
    })
    expect(dropped).toBe(0)
    expect((await lsCached())).toEqual(['big.bin'])
  })

  test('exact-size files (== cap) are kept, only > cap dropped', async () => {
    // 1MB file with 1MB cap → kept (size > cap, not >= cap).
    writeFileSync(join(workTree, 'edge.bin'), Buffer.alloc(1 * 1024 * 1024))
    writeFileSync(join(workTree, 'over.bin'), Buffer.alloc(1 * 1024 * 1024 + 1))
    await stageAll()

    const dropped = await dropOversizeFromIndex({
      store: storeDir,
      workTree,
      indexFile,
      maxFileSizeMb: 1,
    })
    expect(dropped).toBe(1)
    expect((await lsCached())).toEqual(['edge.bin'])
  })

  test('survives a vanished file (race with AV/edit) without throwing', async () => {
    writeFileSync(join(workTree, 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
    writeFileSync(join(workTree, 'small.txt'), 'ok')
    await stageAll()

    // Delete big.bin BEFORE drop runs — stat will fail, that path is skipped.
    rmSync(join(workTree, 'big.bin'))

    const dropped = await dropOversizeFromIndex({
      store: storeDir,
      workTree,
      indexFile,
      maxFileSizeMb: 1,
    })
    // big.bin is still in the index but stat failed → we don't drop it
    // (matches Hermes `_drop_oversize_from_index`::999-1000 — git itself handles it at write-tree).
    expect(dropped).toBe(0)
    expect((await lsCached()).sort()).toEqual(['big.bin', 'small.txt'])
  })

  test('handles paths with spaces and unicode', async () => {
    writeFileSync(join(workTree, 'has space.bin'), Buffer.alloc(2 * 1024 * 1024))
    writeFileSync(join(workTree, '日本語.bin'), Buffer.alloc(2 * 1024 * 1024))
    await stageAll()

    const dropped = await dropOversizeFromIndex({
      store: storeDir,
      workTree,
      indexFile,
      maxFileSizeMb: 1,
    })
    expect(dropped).toBe(2)
    expect((await lsCached())).toEqual([])
  })
})
