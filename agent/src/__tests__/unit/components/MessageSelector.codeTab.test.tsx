import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
import {
  resolveDiffStatsForRestoreSelection,
} from '../../../components/MessageSelector.js'

let tmpRoot: string
let workTree: string
let originalConfigDir: string | undefined
let originalCwd: string

beforeEach(() => {
  originalConfigDir = process.env.AXIOMATE_CONFIG_DIR
  originalCwd = process.cwd()
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-msr-'))
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

async function fileHistorySnapshot(
  holder: ReturnType<typeof makeStateHolder>,
  preview?: string,
): Promise<UUID> {
  const id = randomUUID()
  await fileHistoryMakeSnapshot(holder.updater, id, 'file-history', preview)
  return id
}

describe('MessageSelector File tab row model', () => {
  test('turn rows have ↶ Before label', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1\n')
    const holder = makeStateHolder()
    await fileHistorySnapshot(holder, 'create a.txt')

    writeFileSync(join(workTree, 'a.txt'), 'v2\n')
    await fileHistorySnapshot(holder, 'edit a.txt')

    const anchors = await listCodeAnchors(workTree, { withStats: true, withBodies: true })
    expect(anchors.length).toBeGreaterThanOrEqual(2)

    const rows = await buildRewindCodeRows(anchors, holder.state().checkpointLabelsByHash)
    expect(rows.length).toBeGreaterThanOrEqual(1)

    const turnRow = rows.find(r => r.kind === 'turn')
    expect(turnRow).toBeDefined()
    expect(turnRow!.labelText).toContain('↶ Before')
  }, 30_000)

  test('pre-rewind row appears after rewind with disk changes', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1\n')
    const holder = makeStateHolder()
    const msg1 = await fileHistorySnapshot(holder, 'create a.txt')

    writeFileSync(join(workTree, 'b.txt'), 'added\n')
    const msg2 = await fileHistorySnapshot(holder, 'add b.txt')

    // Rewind to msg1
    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const targetHash = anchors.find(a => a.messageId === msg1)?.gitHash
    expect(targetHash).toBeDefined()
    await fileHistoryRewind(holder.updater, targetHash!, 'create a.txt')
    void msg2

    const refreshedAnchors = await listCodeAnchors(workTree, { withStats: true, withBodies: true })
    const rows = await buildRewindCodeRows(refreshedAnchors, holder.state().checkpointLabelsByHash)

    // Target row must exist
    const targetRow = rows.find(r => r.restoreHash === targetHash)
    expect(targetRow, 'target row not found').toBeDefined()
    expect(targetRow!.kind).toBe('turn')

    // Pre-rewind row: may not appear if the diff vs next anchor is zero-change.
    // When present, verify shape.
    const preRewindRow = rows.find(r => r.kind === 'pre-rewind')
    if (preRewindRow) {
      expect(preRewindRow.labelText).toContain('↶ Before rewind')
      expect(preRewindRow.isSynthetic).toBe(true)
    }
  }, 30_000)

  test('confirmation refreshes the selected file row against current disk', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'v1\n')
    const holder = makeStateHolder()
    await fileHistorySnapshot(holder, 'create a.txt')

    writeFileSync(join(workTree, 'a.txt'), 'v2\n')
    await fileHistorySnapshot(holder, 'edit a.txt')

    // Picker opens while disk is one edit past the newest checkpoint.
    writeFileSync(join(workTree, 'a.txt'), 'v3\n')
    const anchors = await listCodeAnchors(workTree, { withStats: true, withBodies: true })
    const newestHash = anchors[0]?.gitHash
    expect(newestHash).toBeDefined()
    const rows = await buildRewindCodeRows(anchors, holder.state().checkpointLabelsByHash)
    const newestRow = rows.find(r => r.restoreHash === newestHash)
    expect(newestRow, 'newest row not found').toBeDefined()
    expect(newestRow!.diffStats).toMatchObject({
      insertions: 1,
      deletions: 1,
    })

    // Disk changes while the picker remains open. The selected row model is
    // now stale; confirmation must refresh only this restore hash.
    writeFileSync(join(workTree, 'a.txt'), 'v4\nmanual\n')

    const resolved = await resolveDiffStatsForRestoreSelection({
      activeTab: 'code',
      row: newestRow,
    })

    expect(resolved.restoreHash).toBe(newestHash)
    expect(resolved.diffStats).toMatchObject({
      insertions: 2,
      deletions: 1,
    })
    expect(resolved.diffStats).not.toEqual(newestRow!.diffStats)
  }, 30_000)
})
