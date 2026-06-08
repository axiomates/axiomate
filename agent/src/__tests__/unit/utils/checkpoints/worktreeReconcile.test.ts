import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createSnapshot } from '../../../../utils/checkpoints/createSnapshot.js'
import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import { indexPath, normalizePath, projectHash } from '../../../../utils/checkpoints/paths.js'
import { stageWorktreeSnapshotIndex } from '../../../../utils/checkpoints/snapshotIndex.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import {
  applyWorktreeReconcilePlan,
  cleanupWorktreeReconcilePlan,
  prepareWorktreeReconcilePlan,
  resolveGitRelativePathForReconcile,
  verifyWorktreeReconcileFullTree,
  verifyWorktreeReconcileTouchedPaths,
} from '../../../../utils/checkpoints/worktreeReconcile.js'

const GIT_TEST_TIMEOUT_MS = 60_000
type TreeModel = Map<string, string>

let tmpRoot: string
let workTree: string
let originalBase: string | undefined
let snapshotCounter = 0

beforeAll(() => {
  originalBase = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (originalBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalBase
})

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-reconcile-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function writeFile(path: string, content: string): void {
  const abs = join(workTree, path)
  removePath(path)
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const parent = join(workTree, ...parts.slice(0, i))
    if (existsSync(parent) && statSync(parent).isFile()) removePath(parts.slice(0, i).join('/'))
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function removePath(path: string): void {
  rmSync(join(workTree, path), { recursive: true, force: true })
}

function writeTree(tree: TreeModel): void {
  for (const [path, content] of tree) writeFile(path, content)
}

async function snapshotTarget(tree: TreeModel): Promise<string> {
  writeTree(tree)
  const snapshot = await createSnapshot(workTree, {
    messageId: `msg-${++snapshotCounter}`,
    label: 'target',
  })
  if (snapshot.ok === false) throw new Error(`snapshot failed: ${snapshot.skipped}`)
  return snapshot.hash
}

async function reconcileTo(targetHash: string): Promise<void> {
  const plan = await prepareWorktreeReconcilePlan(workTree, targetHash)
  try {
    await applyWorktreeReconcilePlan(plan)
    expect(await verifyWorktreeReconcileTouchedPaths(plan)).toBe(true)
    expect(await verifyWorktreeReconcileFullTree(plan)).toBe(true)
  } finally {
    await cleanupWorktreeReconcilePlan(plan)
  }
}

async function expectWorktreeEquals(hash: string): Promise<void> {
  const storeResult = await ensureStore()
  if (storeResult.ok === false) throw new Error(`ensureStore failed: ${storeResult.reason}`)
  const canonical = normalizePath(workTree)
  const indexFile = indexPath(projectHash(canonical))
  const stage = await stageWorktreeSnapshotIndex({
    store: storeResult.store,
    workTree: canonical,
    indexFile,
  })
  if (stage.ok === false) throw new Error(`stage failed: ${stage.message}`)
  const diff = await runCheckpointGit(['diff', '--cached', '--quiet', hash, '--'], {
    store: storeResult.store,
    workTree: canonical,
    indexFile,
    allowedExitCodes: new Set([1]),
  })
  expect(diff.ok).toBe(true)
  if (diff.ok === false) return
  expect(diff.code).toBe(0)
}

async function expectReconcilesToTarget(target: TreeModel, mutate: () => void): Promise<void> {
  const hash = await snapshotTarget(target)
  mutate()
  await reconcileTo(hash)
  await expectWorktreeEquals(hash)
}

function listFiles(root = workTree): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const abs = join(root, entry.name)
    if (entry.isDirectory()) return listFiles(abs)
    return relative(workTree, abs).replaceAll('\\', '/')
  })
}

function readTree(): TreeModel {
  const tree: TreeModel = new Map()
  for (const path of listFiles()) tree.set(path, readFileSync(join(workTree, path), 'utf8'))
  return tree
}

function expectTreeModelEquals(expected: TreeModel, trace: string[]): void {
  expect([...readTree()].sort(), trace.join('\n')).toEqual([...expected].sort())
}

describe('worktreeReconcile', () => {
  test('restores a modified target file', async () => {
    await expectReconcilesToTarget(new Map([['a.txt', 'target\n']]), () => {
      writeFile('a.txt', 'current\n')
    })
  }, GIT_TEST_TIMEOUT_MS)

  test('restores a target file deleted from current disk', async () => {
    await expectReconcilesToTarget(new Map([['sort.py', 'print("sort")\n']]), () => {
      removePath('sort.py')
    })
  }, GIT_TEST_TIMEOUT_MS)

  test('restore does not use the fixed project index lock', async () => {
    const targetHash = await snapshotTarget(new Map([['sort.py', '#nothing inside\n']]))
    writeFile('sort.py', '123')
    const fixedIndex = indexPath(projectHash(normalizePath(workTree)))
    writeFileSync(`${fixedIndex}.lock`, 'stale project index lock\n')
    const plan = await prepareWorktreeReconcilePlan(workTree, targetHash)
    try {
      await applyWorktreeReconcilePlan(plan)
      expect(readFileSync(join(workTree, 'sort.py'), 'utf-8')).toBe('#nothing inside\n')
    } finally {
      rmSync(`${fixedIndex}.lock`, { force: true })
      await cleanupWorktreeReconcilePlan(plan)
    }
  }, GIT_TEST_TIMEOUT_MS)

  test('deletes a current file absent from target', async () => {
    await expectReconcilesToTarget(new Map([['keep.txt', 'keep\n']]), () => {
      writeFile('extra.txt', 'extra\n')
    })
  }, GIT_TEST_TIMEOUT_MS)

  test('reconciles mixed add modify and delete changes', async () => {
    await expectReconcilesToTarget(
      new Map([
        ['keep.txt', 'target keep\n'],
        ['restore.txt', 'target restore\n'],
      ]),
      () => {
        writeFile('keep.txt', 'current keep\n')
        removePath('restore.txt')
        writeFile('extra.txt', 'extra\n')
      },
    )
  }, GIT_TEST_TIMEOUT_MS)

  test('replaces a current directory with a target file', async () => {
    await expectReconcilesToTarget(new Map([['node', 'file\n']]), () => {
      removePath('node')
      writeFile('node/child.txt', 'dir child\n')
    })
  }, GIT_TEST_TIMEOUT_MS)

  test('replaces a current file with a target directory', async () => {
    await expectReconcilesToTarget(new Map([['node/child.txt', 'dir child\n']]), () => {
      removePath('node')
      writeFile('node', 'file\n')
    })
  }, GIT_TEST_TIMEOUT_MS)

  test('cleans empty parent directories after deleting current-only files', async () => {
    await expectReconcilesToTarget(new Map([['root.txt', 'root\n']]), () => {
      writeFile('nested/empty/extra.txt', 'extra\n')
    })
    expect(existsSync(join(workTree, 'nested'))).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)

  test('handles unicode spaces and punctuation paths', async () => {
    await expectReconcilesToTarget(
      new Map([
        ['space dir/hello world.txt', 'hello\n'],
        ['unicode/你好.txt', 'unicode\n'],
        ['punctuation/[x] #1!.txt', 'punctuation\n'],
      ]),
      () => {
        writeFile('space dir/hello world.txt', 'changed\n')
        removePath('unicode/你好.txt')
        writeFile('punctuation/extra @2.txt', 'extra\n')
      },
    )
  }, GIT_TEST_TIMEOUT_MS)

  test('rejects unsafe pathspec records', () => {
    expect(() => resolveGitRelativePathForReconcile(workTree, '')).toThrow(/empty/)
    expect(() => resolveGitRelativePathForReconcile(workTree, 'bad\0path.txt')).toThrow(/null byte/)
    expect(() => resolveGitRelativePathForReconcile(workTree, '../outside.txt')).toThrow(/outside/)
    expect(() => resolveGitRelativePathForReconcile(workTree, '/outside.txt')).toThrow(/absolute/)
    expect(() => resolveGitRelativePathForReconcile(workTree, 'C:/outside.txt')).toThrow(/absolute/)
    expect(resolveGitRelativePathForReconcile(workTree, 'safe/file.txt')).toBe(
      resolve(workTree, 'safe/file.txt'),
    )
  })

  test('expands and normalizes worktree roots at the path boundary', () => {
    expect(resolveGitRelativePathForReconcile(`${workTree}/nested/..`, 'safe/file.txt')).toBe(
      resolve(workTree, 'safe/file.txt'),
    )
  })
})

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const pathPool = [
  'a.txt',
  'b.txt',
  'dir/c.txt',
  'dir/deep/d.txt',
  'space dir/e file.txt',
  'unicode/é.txt',
  'punct/[1]-x!.txt',
  'replace/node',
  'replace/node/child.txt',
]

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!
}

function randomInitialTree(seed: number): TreeModel {
  const random = seededRandom(seed)
  const tree: TreeModel = new Map()
  for (const path of pathPool) {
    if (path.startsWith('replace/node')) continue
    if (random() < 0.45) tree.set(path, `target:${seed}:${path}\n`)
  }
  if (tree.size === 0) tree.set('a.txt', `target:${seed}:a\n`)
  return tree
}

function mutateRandomly(seed: number): string[] {
  const random = seededRandom(seed * 17 + 3)
  const trace: string[] = []
  for (let i = 0; i < 12; i++) {
    const op = Math.floor(random() * 5)
    const path = pick(pathPool, random)
    if (op === 0) {
      removePath(path)
      trace.push(`${i}: delete ${path}`)
    } else if (op === 1) {
      writeFile(path, `current:${seed}:${i}:${path}\n`)
      trace.push(`${i}: write ${path}`)
    } else if (op === 2) {
      const to = pick(pathPool.filter(p => p !== path), random)
      if (existsSync(join(workTree, path)) && statSync(join(workTree, path)).isFile()) {
        const content = readFileSync(join(workTree, path), 'utf8')
        removePath(path)
        writeFile(to, content)
      }
      trace.push(`${i}: rename ${path}`)
    } else if (op === 3) {
      removePath('replace/node')
      writeFile('replace/node', `current:file:${seed}:${i}\n`)
      trace.push(`${i}: replace subtree with file`)
    } else {
      removePath('replace/node')
      writeFile('replace/node/child.txt', `current:dir:${seed}:${i}\n`)
      trace.push(`${i}: replace file with subtree`)
    }
  }
  return trace
}

describe('worktreeReconcile randomized', () => {
  for (const seed of [101, 202, 303, 404, 505]) {
    test(`reconciles generated tree mutation seed ${seed}`, async () => {
      const target = randomInitialTree(seed)
      const hash = await snapshotTarget(target)
      const trace = mutateRandomly(seed)
      try {
        await reconcileTo(hash)
      } catch (error) {
        throw new Error(`seed=${seed}\n${trace.join('\n')}\n${String(error)}`)
      }
      expectTreeModelEquals(target, [`seed=${seed}`, ...trace])
      await expectWorktreeEquals(hash)
    }, GIT_TEST_TIMEOUT_MS)
  }
})
