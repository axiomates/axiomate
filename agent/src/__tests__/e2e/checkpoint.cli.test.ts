import { execFile } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { randomUUID, type UUID } from 'crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  setIsInteractive,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  resetFileHistoryDraft,
  _setRewindTestHooksForTesting,
  type FileHistoryState,
} from '../../utils/fileHistory.js'
import { listCodeAnchors } from '../../utils/checkpoints/listCodeAnchors.js'
import { ensureStore } from '../../utils/checkpoints/store.js'
import { runCheckpointGit } from '../../utils/checkpoints/git.js'
import { indexPath, normalizePath, projectHash } from '../../utils/checkpoints/paths.js'
import { stageWorktreeSnapshotIndex } from '../../utils/checkpoints/snapshotIndex.js'

const execFileAsync = promisify(execFile)

let tmpRoot: string
let workTree: string
let checkpointBase: string
let originalConfigDir: string | undefined
let originalCwd: string
let originalCheckpointBase: string | undefined

beforeAll(() => {
  // dist/cli.js must exist (pnpm run build)
})

beforeEach(() => {
  originalConfigDir = process.env.AXIOMATE_CONFIG_DIR
  originalCwd = process.cwd()
  originalCheckpointBase = process.env.AXIOMATE_CHECKPOINT_BASE
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-cli-e2e-'))
  checkpointBase = join(tmpRoot, 'cp')
  process.env.AXIOMATE_CHECKPOINT_BASE = checkpointBase
  process.env.AXIOMATE_CONFIG_DIR = join(tmpRoot, 'config')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  setOriginalCwd(workTree)
  setIsInteractive(true)
  resetFileHistoryDraft()
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.AXIOMATE_CONFIG_DIR
  else process.env.AXIOMATE_CONFIG_DIR = originalConfigDir
  if (originalCheckpointBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalCheckpointBase
  setOriginalCwd(originalCwd)
  setIsInteractive(false)
  resetFileHistoryDraft()
  _setRewindTestHooksForTesting(undefined)
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function makeStateHolder(): {
  state: () => FileHistoryState
  updater: (f: (prev: FileHistoryState) => FileHistoryState) => void
} {
  let state: FileHistoryState = {
    snapshotMessageIds: new Set<UUID>(),
    checkpointLabelsByHash: new Map(),
    trackedFiles: new Set<string>(),
    snapshotSequence: 0,
  }
  return {
    state: () => state,
    updater: f => { state = f(state) },
  }
}

async function expectWorktreeTreeEquals(gitHash: string): Promise<void> {
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
  const diff = await runCheckpointGit(
    ['diff', '--cached', '--quiet', gitHash, '--'],
    { store: storeResult.store, workTree: canonical, indexFile, allowedExitCodes: new Set([1]) },
  )
  expect(diff.ok).toBe(true)
  expect(diff.code).toBe(0)
}

async function cli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // agent/src/__tests__/e2e/ -> 3 levels up -> agent/ -> dist/cli.js
  const script = join(__dirname, '..', '..', '..', 'dist', 'cli.js')
  try {
    const { stdout, stderr } = await execFileAsync(
      'bun',
      [script, ...args],
      {
        env: {
          ...process.env,
          AXIOMATE_CHECKPOINT_BASE: checkpointBase,
          AXIOMATE_CONFIG_DIR: join(tmpRoot, 'config'),
          AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING: '0',
        },
        timeout: 60_000,
        cwd: workTree,
      },
    )
    return { stdout, stderr, exitCode: 0 }
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.code ?? 1,
    }
  }
}

describe('checkpoint CLI e2e', () => {
  test('checkpoints status runs', async () => {
    const { stdout, stderr, exitCode } = await cli(['checkpoints', 'status'])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Checkpoint base:')
  }, 60_000)

  test('checkpoints prune runs', async () => {
    const { stdout, stderr, exitCode } = await cli([
      'checkpoints', 'prune',
      '--retention-days', '30',
      '--max-size-mb', '100',
      '--force',
    ])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Prune complete.')
  }, 60_000)

  test('checkpoints clear --force runs', async () => {
    const { stdout, stderr, exitCode } = await cli(['checkpoints', 'clear', '--force'])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Nothing to clear')
  }, 60_000)

  test('CLI list sees checkpoints created by fileHistory API', async () => {
    const holder = makeStateHolder()
    writeFileSync(join(workTree, 'sort.py'), 'v1\n')
    await fileHistoryMakeSnapshot(holder.updater, randomUUID(), 'file-history', 'create v1')
    writeFileSync(join(workTree, 'sort.py'), 'v2\n')
    await fileHistoryMakeSnapshot(holder.updater, randomUUID(), 'file-history', 'edit to v2')

    const { stdout, stderr, exitCode } = await cli(['checkpoints', 'list'])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('sort.py')
  }, 60_000)

  test('CLI list reflects rewind created by fileHistory API', async () => {
    const holder = makeStateHolder()
    writeFileSync(join(workTree, 'sort.py'), 'v1\n')
    const msg1 = randomUUID()
    await fileHistoryMakeSnapshot(holder.updater, msg1, 'file-history', 'create v1')

    writeFileSync(join(workTree, 'sort.py'), 'v2\n')
    await fileHistoryMakeSnapshot(holder.updater, randomUUID(), 'file-history', 'edit to v2')

    // Rewind via API
    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const hash1 = anchors.find(a => a.messageId === msg1)?.gitHash
    expect(hash1).toBeDefined()
    await fileHistoryRewind(holder.updater, hash1!, 'create v1')

    // Sort.py should be back to v1
    expect(readFileSync(join(workTree, 'sort.py'), 'utf8')).toBe('v1\n')

    // CLI list should show the rewind-related anchors
    const { stdout, stderr, exitCode } = await cli(['checkpoints', 'list'])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Checkpoints for')
  }, 60_000)

  test('fileHistory rewind restores selected snapshot from picker path', async () => {
    const holder = makeStateHolder()
    const msg1 = randomUUID()

    writeFileSync(join(workTree, 'sort.py'), 'v1\n')
    await fileHistoryMakeSnapshot(holder.updater, msg1, 'file-history', 'create v1')

    writeFileSync(join(workTree, 'sort.py'), 'v2\n')
    writeFileSync(join(workTree, 'extra.txt'), 'extra\n')
    await fileHistoryMakeSnapshot(holder.updater, randomUUID(), 'file-history', 'edit to v2')

    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const hash1 = anchors.find(a => a.messageId === msg1)?.gitHash
    expect(hash1).toBeDefined()

    await fileHistoryRewind(holder.updater, hash1!, 'create v1')

    expect(readFileSync(join(workTree, 'sort.py'), 'utf8')).toBe('v1\n')
    await expectWorktreeTreeEquals(hash1!)
  }, 60_000)

  test('fileHistory API e2e: rewind survives manual temp deletion and stale fixed index lock', async () => {
    const holder = makeStateHolder()
    const msg1 = randomUUID()
    const target = join(workTree, 'sort.py')
    const temp = join(workTree, 'temp.txt')

    writeFileSync(target, '#nothing inside\n')
    await fileHistoryMakeSnapshot(holder.updater, msg1, 'file-history', 'create sort')
    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const hash1 = anchors.find(a => a.messageId === msg1)?.gitHash
    expect(hash1).toBeDefined()

    writeFileSync(target, '123')
    writeFileSync(temp, 'temporary\n')
    await fileHistoryMakeSnapshot(holder.updater, randomUUID(), 'file-history', 'edit sort and temp')
    unlinkSync(temp)

    const fixedIndex = indexPath(projectHash(normalizePath(workTree)))
    writeFileSync(`${fixedIndex}.lock`, 'stale lock from interrupted restore\n')
    try {
      await fileHistoryRewind(holder.updater, hash1!, 'create sort')
    } finally {
      rmSync(`${fixedIndex}.lock`, { force: true })
    }

    expect(readFileSync(target, 'utf8')).toBe('#nothing inside\n')
    expect(() => readFileSync(temp, 'utf8')).toThrow()
    await expectWorktreeTreeEquals(hash1!)
  }, 60_000)
})
