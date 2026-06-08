import { execFile } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
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
  buildRewindCodeRows,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  resetFileHistoryDraft,
  _setRewindTestHooksForTesting,
  type FileHistoryState,
} from '../../utils/fileHistory.js'
import { listCodeAnchors } from '../../utils/checkpoints/listCodeAnchors.js'
import { listSnapshots } from '../../utils/checkpoints/listSnapshots.js'
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
let originalRewindTempRoot: string | undefined

beforeAll(() => {
  // dist/cli.js must exist (pnpm run build)
})

beforeEach(() => {
  originalConfigDir = process.env.AXIOMATE_CONFIG_DIR
  originalCwd = process.cwd()
  originalCheckpointBase = process.env.AXIOMATE_CHECKPOINT_BASE
  originalRewindTempRoot = process.env.AXIOMATE_REWIND_TEMP_ROOT_FOR_TESTING
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-cli-e2e-'))
  checkpointBase = join(tmpRoot, 'cp')
  process.env.AXIOMATE_CHECKPOINT_BASE = checkpointBase
  process.env.AXIOMATE_CONFIG_DIR = join(tmpRoot, 'config')
  process.env.AXIOMATE_REWIND_TEMP_ROOT_FOR_TESTING = join(tmpRoot, 'rewind-temp')
  mkdirSync(process.env.AXIOMATE_REWIND_TEMP_ROOT_FOR_TESTING, { recursive: true })
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
  if (originalRewindTempRoot === undefined) delete process.env.AXIOMATE_REWIND_TEMP_ROOT_FOR_TESTING
  else process.env.AXIOMATE_REWIND_TEMP_ROOT_FOR_TESTING = originalRewindTempRoot
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
  await expectWorktreeTreeEqualsAt(workTree, gitHash)
}

async function expectWorktreeTreeEqualsAt(workdir: string, gitHash: string): Promise<void> {
  const storeResult = await ensureStore()
  if (storeResult.ok === false) throw new Error(`ensureStore failed: ${storeResult.reason}`)
  const canonical = normalizePath(workdir)
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
          AXIOMATE_REWIND_TEMP_ROOT_FOR_TESTING: join(tmpRoot, 'rewind-temp'),
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

  test('CLI list uses commit stats even when rewind stats differ for the same hash', async () => {
    const holder = makeStateHolder()
    const file = join(workTree, 'story.txt')

    const msg1 = randomUUID()
    await fileHistoryMakeSnapshot(holder.updater, msg1, 'file-history', 'create v1')
    writeFileSync(file, 'one\n')

    const msg2 = randomUUID()
    await fileHistoryMakeSnapshot(holder.updater, msg2, 'file-history', 'expand to v2')
    writeFileSync(file, 'one\ntwo\nthree\n')

    const msg3 = randomUUID()
    await fileHistoryMakeSnapshot(holder.updater, msg3, 'file-history', 'shrink to v3')
    writeFileSync(file, 'three\n')

    const anchors = await listCodeAnchors(workTree, { withStats: true, withBodies: true })
    expect(anchors.length).toBe(3)
    const middle = anchors.find(anchor => anchor.messageId === msg2)
    expect(middle).toBeDefined()
    expect(middle!.insertions).toBe(1)
    expect(middle!.deletions).toBe(0)

    const rows = await buildRewindCodeRows(anchors, holder.state().checkpointLabelsByHash)
    const middleRewindRow = rows.find(row => row.restoreHash === middle!.gitHash)
    expect(middleRewindRow).toBeDefined()
    expect(middleRewindRow!.diffStats.insertions).toBe(2)
    expect(middleRewindRow!.diffStats.deletions).toBe(0)

    const snapshots = await listSnapshots(workTree, { withBodies: true, withStats: true })
    const middleSnapshot = snapshots.find(snapshot => snapshot.hash === middle!.gitHash)
    expect(middleSnapshot).toBeDefined()
    expect(middleSnapshot!.insertions).toBe(1)
    expect(middleSnapshot!.deletions).toBe(0)

    const { stdout, stderr, exitCode } = await cli(['checkpoints', 'list', '--rows', '3'])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    const middleLine = stdout
      .split('\n')
      .find(line => line.includes(middle!.gitHash.slice(0, 7)))
    expect(middleLine).toBeDefined()
    expect(middleLine).toContain('story.txt +1 -0')
    expect(middleLine).not.toContain('+2 -0')
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

  test('fileHistory API e2e: rewind reconciles manual add modify delete drift after AI edits', async () => {
    const scenarios: Array<{
      name: string
      add?: boolean
      modify?: boolean
      delete?: boolean
      deleteAiCreated?: boolean
    }> = [
      { name: 'add', add: true },
      { name: 'modify', modify: true },
      { name: 'delete', delete: true },
      { name: 'add+modify', add: true, modify: true },
      { name: 'add+delete', add: true, delete: true },
      { name: 'modify+delete', modify: true, delete: true },
      { name: 'add+modify+delete', add: true, modify: true, delete: true },
      {
        name: 'add+modify+delete+delete-ai-created',
        add: true,
        modify: true,
        delete: true,
        deleteAiCreated: true,
      },
    ]

    for (const scenario of scenarios) {
      try {
        const scenarioWorkTree = mkdtempSync(join(tmpRoot, `wt-manual-${scenario.name}-`))
        setOriginalCwd(scenarioWorkTree)
        resetFileHistoryDraft()
        const holder = makeStateHolder()

        const sort = join(scenarioWorkTree, 'sort.py')
        const manualModify = join(scenarioWorkTree, 'manual-modify.txt')
        const manualDelete = join(scenarioWorkTree, 'manual-delete.txt')
        const manualAdded = join(scenarioWorkTree, 'manual-added.txt')
        const aiCreated = join(scenarioWorkTree, 'ai-created.txt')

        writeFileSync(sort, '#nothing inside\n')
        writeFileSync(manualModify, 'modify-base\n')
        writeFileSync(manualDelete, 'delete-base\n')

        const targetMessage = randomUUID()
        await fileHistoryMakeSnapshot(
          holder.updater,
          targetMessage,
          'file-history',
          `manual drift matrix target ${scenario.name}`,
        )
        const targetAnchor = (await listCodeAnchors(scenarioWorkTree, { withStats: false }))
          .find(anchor => anchor.messageId === targetMessage)
        expect(targetAnchor).toBeDefined()
        const targetHash = targetAnchor!.gitHash

        writeFileSync(sort, '123\n')
        writeFileSync(aiCreated, 'ai-created\n')
        await fileHistoryMakeSnapshot(
          holder.updater,
          randomUUID(),
          'file-history',
          `manual drift matrix ai edit ${scenario.name}`,
        )

        if (scenario.add) writeFileSync(manualAdded, 'manual-added\n')
        if (scenario.modify) writeFileSync(manualModify, 'manual-modified\n')
        if (scenario.delete) unlinkSync(manualDelete)
        if (scenario.deleteAiCreated) unlinkSync(aiCreated)

        await fileHistoryRewind(
          holder.updater,
          targetHash,
          `manual drift matrix ${scenario.name}`,
        )

        expect(readFileSync(sort, 'utf8')).toBe('#nothing inside\n')
        expect(readFileSync(manualModify, 'utf8')).toBe('modify-base\n')
        expect(readFileSync(manualDelete, 'utf8')).toBe('delete-base\n')
        expect(existsSync(manualAdded)).toBe(false)
        expect(existsSync(aiCreated)).toBe(false)
        await expectWorktreeTreeEqualsAt(scenarioWorkTree, targetHash)
      } catch (error) {
        throw new Error(`manual drift scenario failed: ${scenario.name}\n${String(error)}`)
      }
    }
  }, 120_000)
})
