import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID, type UUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  setIsInteractive,
  setOriginalCwd,
} from '../../../bootstrap/state.js'
import {
  buildRewindCodeRows,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  resetFileHistoryDraft,
  _setRewindTestHooksForTesting,
  type FileHistoryState,
} from '../../../utils/fileHistory.js'
import { listCodeAnchors } from '../../../utils/checkpoints/listCodeAnchors.js'
import { LABEL_PRE_REWIND } from '../../../utils/checkpoints/reason.js'

let tmpRoot: string
let workTree: string
let originalConfigDir: string | undefined
let originalCwd: string

beforeEach(() => {
  originalConfigDir = process.env.AXIOMATE_CONFIG_DIR
  originalCwd = process.cwd()
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-rr2-'))
  process.env.AXIOMATE_CONFIG_DIR = join(tmpRoot, 'config')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  setOriginalCwd(workTree)
  setIsInteractive(true)
  resetFileHistoryDraft()
})

afterEach(() => {
  delete process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING
  if (originalConfigDir === undefined) delete process.env.AXIOMATE_CONFIG_DIR
  else process.env.AXIOMATE_CONFIG_DIR = originalConfigDir
  setOriginalCwd(originalCwd)
  setIsInteractive(false)
  resetFileHistoryDraft()
  _setRewindTestHooksForTesting(undefined)
  rmSync(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
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

function writeFile(path: string, content: string): void {
  const abs = join(workTree, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function readFile(path: string): string {
  return readFileSync(join(workTree, path), 'utf8')
}

const GIT_TEST_TIMEOUT = 60_000

describe('rewind and rewind-of-rewind', () => {
  test('rewind restores target content', async () => {
    const holder = makeStateHolder()
    writeFile('sort.py', 'v1\n')
    const msg1 = randomUUID()
    await fileHistoryMakeSnapshot(holder.updater, msg1, 'file-history', 'create v1')

    writeFile('sort.py', 'v2\n')
    await fileHistoryMakeSnapshot(holder.updater, randomUUID(), 'file-history', 'edit to v2')

    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const targetHash = anchors.find(a => a.messageId === msg1)?.gitHash
    expect(targetHash).toBeDefined()

    await fileHistoryRewind(holder.updater, targetHash!, 'create v1')
    expect(readFile('sort.py')).toBe('v1\n')
  }, GIT_TEST_TIMEOUT)

  test('rewind of rewind restores post-rewind content', async () => {
    const holder = makeStateHolder()

    // Turn 1: create v1
    writeFile('sort.py', 'v1\n')
    const msg1 = randomUUID()
    await fileHistoryMakeSnapshot(holder.updater, msg1, 'file-history', 'create v1')

    // Turn 2: edit to v2, also add extra.py
    writeFile('sort.py', 'v2\n')
    writeFile('extra.py', 'extra\n')
    const msg2 = randomUUID()
    await fileHistoryMakeSnapshot(holder.updater, msg2, 'file-history', 'add extra.py and edit')

    // Mutate disk between last checkpoint and rewind so rewind-time tree
    // differs from the latest checkpoint (guarantees pre-rewind anchor exists)
    rmSync(join(workTree, 'extra.py'))
    writeFile('sort.py', 'v2-changed\n')

    // Rewind to turn 1
    const anchors1 = await listCodeAnchors(workTree, { withStats: false })
    const hash1 = anchors1.find(a => a.messageId === msg1)?.gitHash
    expect(hash1).toBeDefined()
    await fileHistoryRewind(holder.updater, hash1!, 'create v1')

    // After first rewind: sort.py = v1, extra.py should be gone
    expect(readFile('sort.py')).toBe('v1\n')
    expect(existsSync(join(workTree, 'extra.py'))).toBe(false)

    // Find the pre-rewind anchor (safety net from the first rewind)
    const anchors2 = await listCodeAnchors(workTree, { withStats: false, withBodies: true })
    const preRewindAnchor = anchors2.find(a => a.subject.includes(`:${LABEL_PRE_REWIND}:`))
    expect(preRewindAnchor, 'pre-rewind anchor must exist').toBeDefined()

    // Rewind to the pre-rewind anchor (undo the undo)
    await fileHistoryRewind(holder.updater, preRewindAnchor!.gitHash, 'undo rewind')

    // After undo: sort.py back to v2-changed, extra.py stayed deleted (was deleted before first rewind)
    expect(readFile('sort.py')).toBe('v2-changed\n')
    expect(existsSync(join(workTree, 'extra.py'))).toBe(false)

    // Verify rows contain both the target row and the pre-rewind row
    const rows = await buildRewindCodeRows(
      await listCodeAnchors(workTree, { withStats: true, withBodies: true }),
      holder.state().checkpointLabelsByHash,
    )
    const preRewindRows = rows.filter(r => r.kind === 'pre-rewind')
    expect(preRewindRows.length).toBeGreaterThanOrEqual(1)
    expect(preRewindRows.some(r => r.labelText.includes('↶ Before rewind'))).toBe(true)
  }, GIT_TEST_TIMEOUT)
})
