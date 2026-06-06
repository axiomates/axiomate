import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import type { CheckpointGitResult } from '../../../../utils/checkpoints/git.js'

const INJECT: {
  failFirstUpdateIndex: boolean
  deleteBeforeFailure: string | null
  shortCircuitUpdateIndex: boolean
  checkIgnoreHits: number
  updateIndexHits: number
} = {
  failFirstUpdateIndex: false,
  deleteBeforeFailure: null,
  shortCircuitUpdateIndex: false,
  checkIgnoreHits: 0,
  updateIndexHits: 0,
}

vi.mock('../../../../utils/checkpoints/git.js', async () => {
  const real = await vi.importActual<typeof import('../../../../utils/checkpoints/git.js')>(
    '../../../../utils/checkpoints/git.js',
  )
  return {
    ...real,
    runCheckpointGit: vi.fn(async (args: string[], opts: unknown) => {
      if (args[0] === 'check-ignore' && args.includes('--stdin')) {
        INJECT.checkIgnoreHits++
      }
      if (args[0] === 'update-index' && args.includes('--stdin')) {
        INJECT.updateIndexHits++
        if (INJECT.shortCircuitUpdateIndex) {
          return {
            ok: true,
            code: 0,
            stdout: '',
            stderr: '',
          } satisfies CheckpointGitResult
        }
        if (INJECT.failFirstUpdateIndex && INJECT.updateIndexHits === 1) {
          if (INJECT.deleteBeforeFailure !== null) {
            unlinkSync(INJECT.deleteBeforeFailure)
          }
          return {
            ok: false,
            reason: 'non-zero-exit',
            code: 128,
            stdout: '',
            stderr: 'fatal: simulated vanished file',
            message: 'simulated vanished file',
          } satisfies CheckpointGitResult
        }
      }
      return real.runCheckpointGit(
        args,
        opts as Parameters<typeof real.runCheckpointGit>[1],
      )
    }),
  }
})

import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import { indexPath, projectHash } from '../../../../utils/checkpoints/paths.js'
import { stageWorktreeSnapshotIndex } from '../../../../utils/checkpoints/snapshotIndex.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-snapshot-race-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
  storeDir = r.store
  indexFile = indexPath(projectHash(workTree))
})

afterEach(() => {
  INJECT.failFirstUpdateIndex = false
  INJECT.deleteBeforeFailure = null
  INJECT.shortCircuitUpdateIndex = false
  INJECT.checkIgnoreHits = 0
  INJECT.updateIndexHits = 0
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

function touch(rel: string, content = ''): string {
  const full = join(workTree, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

async function stagedTreePaths(): Promise<string[]> {
  const writeTree = await runCheckpointGit(['write-tree'], {
    store: storeDir,
    workTree,
    indexFile,
  })
  if (writeTree.ok === false) throw new Error(writeTree.message)
  const lsTree = await runCheckpointGit(
    ['ls-tree', '-r', '-z', '--name-only', writeTree.stdout.trim()],
    { store: storeDir, workTree, indexFile },
  )
  if (lsTree.ok === false) throw new Error(lsTree.message)
  return lsTree.stdout.split('\0').filter(p => p.length > 0).sort()
}

describe('stageWorktreeSnapshotIndex — filesystem races', () => {
  test('splits large update-index stdin into multiple batches', async () => {
    for (let i = 0; i < 4097; i++) {
      touch(`many/file-${i.toString().padStart(4, '0')}.txt`, `file ${i}`)
    }
    INJECT.shortCircuitUpdateIndex = true

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })

    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(INJECT.checkIgnoreHits).toBe(3)
    expect(INJECT.updateIndexHits).toBe(2)
    expect(r.paths).toHaveLength(4097)
    expect(r.paths.sort()[0]).toBe('many/file-0000.txt')
    expect(r.paths.sort().at(-1)).toBe('many/file-4096.txt')
  }, 30_000)

  test('re-collects from disk after first update-index failure', async () => {
    touch('stable.txt', 'stable')
    const racyPath = touch('racy.txt', 'will vanish')
    INJECT.failFirstUpdateIndex = true
    INJECT.deleteBeforeFailure = racyPath

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })

    expect(r.ok).toBe(true)
    expect(INJECT.updateIndexHits).toBe(2)
    expect(await stagedTreePaths()).toEqual(['stable.txt'])
  })
})
