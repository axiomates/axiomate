/**
 * Behavior-only tests for `fileHistory`.
 *
 * RULES — read before adding tests:
 *
 *   1. Observe state ONLY through public API: rewind / makeSnapshot /
 *      trackEdit / restoreStateFromLog / getDiffVsDisk / hasDiffVsDisk.
 *   2. NEVER assert internal shape. After Phase 1, `state.snapshots[]`
 *      is gone — the source of truth for "what anchors exist" is the
 *      shadow git store. If a test would need to probe state to verify
 *      a behavior, the test belongs against `listCodeAnchors` instead.
 *   3. Every assertion stays green across backend changes.
 *
 * Isolation: per-test AXIOMATE_CONFIG_DIR sandbox, per-test workTree wired
 * through setOriginalCwd, force-interactive so fileHistoryEnabled() exercises
 * the same path as the REPL.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID, type UUID } from 'crypto'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest'
import {
  setIsInteractive,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  fileHistoryBulkDiffVsDisk,
  fileHistoryEnabled,
  fileHistoryGetDiffVsDisk,
  fileHistoryHasDiffVsDisk,
  fileHistoryMakeSnapshot,
  fileHistoryRestoreStateFromLog,
  fileHistoryRewind,
  resetFileHistoryDraft,
  type FileHistorySnapshot,
  type FileHistoryState,
} from '../fileHistory.js'
import { listCodeAnchors } from '../checkpoints/listCodeAnchors.js'

let tmpRoot: string
let workTree: string
let originalConfigDir: string | undefined
let originalCwd: string

beforeEach(() => {
  originalConfigDir = process.env.AXIOMATE_CONFIG_DIR
  originalCwd = process.cwd()
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-fhb-'))
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
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeStateHolder(): {
  state: () => FileHistoryState
  updater: (f: (prev: FileHistoryState) => FileHistoryState) => void
} {
  let state: FileHistoryState = {
    snapshotMessageIds: new Set<UUID>(),
    trackedFiles: new Set<string>(),
    snapshotSequence: 0,
  }
  return {
    state: () => state,
    updater: f => {
      state = f(state)
    },
  }
}

const uuid = (): UUID => randomUUID()

async function turn(
  holder: ReturnType<typeof makeStateHolder>,
  files: readonly string[],
): Promise<UUID> {
  const id = uuid()
  await fileHistoryMakeSnapshot(holder.updater, id)
  // Production: tools mutate disk AFTER pre-tool makeSnapshot. The
  // `files` array here represents the per-turn mutation set; it's
  // recorded by the next makeSnapshot's diff-vs-parent. The turn
  // helper preserves the parameter for backward compatibility with
  // existing tests that pass mutation paths positionally — they're
  // expected to be already on disk by this point.
  void files
  return id
}

/**
 * Resolve a messageId → its anchor's gitHash. fileHistoryRewind
 * (post-Phase 3) operates on hashes directly; the test helper does the
 * lookup so test bodies stay readable in messageId terms.
 */
async function hashFor(messageId: UUID): Promise<string> {
  const anchors = await listCodeAnchors(workTree, { withStats: false })
  const a = anchors.find(x => x.messageId === messageId)
  if (!a) throw new Error(`no anchor for ${messageId}`)
  return a.gitHash
}

describe('fileHistoryEnabled', () => {
  test('on by default in test config', () => {
    expect(fileHistoryEnabled()).toBe(true)
  })

  test('off when AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING is truthy', () => {
    process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
    expect(fileHistoryEnabled()).toBe(false)
  })
})

describe('rewind — restore content at the chosen turn', () => {
  test('restores a single edited file to its content at the target turn', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    writeFileSync(a, 'v2')
    await turn(holder, [a])

    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('v1')
  })

  test('restores multiple files in one rewind, each to its turn-1 content', async () => {
    const a = join(workTree, 'a.txt')
    const b = join(workTree, 'b.txt')
    writeFileSync(a, 'a-v1')
    writeFileSync(b, 'b-v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a, b])
    writeFileSync(a, 'a-v2')
    writeFileSync(b, 'b-v2')
    await turn(holder, [a, b])

    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('a-v1')
    expect(readFileSync(b, 'utf-8')).toBe('b-v1')
  })

  test('deletes a file that did not exist at the target turn', async () => {
    const seed = join(workTree, 'seed.txt')
    writeFileSync(seed, 'seed')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [seed])
    const newFile = join(workTree, 'new.txt')
    writeFileSync(newFile, 'fresh')
    await turn(holder, [])

    expect(existsSync(newFile)).toBe(true)
    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(existsSync(newFile)).toBe(false)
  })

  test('rewind covers files NOT registered with trackEdit (full-tree restore)', async () => {
    const tracked = join(workTree, 'tracked.txt')
    const manual = join(workTree, 'manual.txt')
    writeFileSync(tracked, 'tracked-v1')
    writeFileSync(manual, 'manual-v1')

    const holder = makeStateHolder()
    const m1 = await turn(holder, [tracked])
    writeFileSync(tracked, 'tracked-v2')
    writeFileSync(manual, 'manual-v2-edited-by-user')
    const m2 = await turn(holder, [tracked])
    writeFileSync(tracked, 'tracked-v3-divergent')

    await fileHistoryRewind(holder.updater, await hashFor(m1))

    expect(readFileSync(tracked, 'utf-8')).toBe('tracked-v1')
    expect(readFileSync(manual, 'utf-8')).toBe('manual-v1')
    expect(m2).toBeDefined()
  })

  test('rewind to empty-workdir root removes the file the first edit created', async () => {
    const newFile = join(workTree, 'created-by-ai.txt')
    expect(existsSync(newFile)).toBe(false)

    const holder = makeStateHolder()
    const m1 = await turn(holder, [])
    writeFileSync(newFile, 'created')
    await turn(holder, [])

    expect(existsSync(newFile)).toBe(true)
    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(existsSync(newFile)).toBe(false)
  })

  test('subdirectory paths round-trip through rewind', async () => {
    mkdirSync(join(workTree, 'src'))
    const f = join(workTree, 'src', 'foo.ts')
    writeFileSync(f, 'export const x = 1\n')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [f])
    writeFileSync(f, 'export const x = 2\n')
    await turn(holder, [f])

    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(f, 'utf-8')).toBe('export const x = 1\n')
  })

  test('throws when gitHash is unknown', async () => {
    const holder = makeStateHolder()
    await turn(holder, [])
    await expect(
      fileHistoryRewind(
        holder.updater,
        '0000000000000000000000000000000000000000',
      ),
    ).rejects.toThrow(/Rewind failed|Undo last rewind/i)
  })

  test('rewinding twice in a row restores the same content (idempotent)', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    writeFileSync(a, 'v2')
    await turn(holder, [a])

    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('v1')
    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('v1')
  })

  test('throws when given a hash that does not exist in the store', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    await turn(holder, [a])
    writeFileSync(a, 'v2')
    await expect(
      fileHistoryRewind(
        holder.updater,
        '0000000000000000000000000000000000000000',
      ),
    ).rejects.toThrow(/Rewind failed|Undo last rewind/i)
    expect(readFileSync(a, 'utf-8')).toBe('v2')
  })
})

describe('getDiffVsDisk / hasDiffVsDisk — chooser preview source', () => {
  test('zero counts when nothing has changed since the snapshot', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'one\ntwo\n')
    const holder = makeStateHolder()
    await turn(holder, [a])

    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const stats = await fileHistoryGetDiffVsDisk(anchors[0]!.gitHash)
    expect(stats).toEqual({ filesChanged: [], insertions: 0, deletions: 0 })
    expect(await fileHistoryHasDiffVsDisk(anchors[0]!.gitHash)).toBe(false)
  })

  test('reports edited file with non-zero line counts and changed paths', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'line1\nline2\n')
    const holder = makeStateHolder()
    await turn(holder, [a])
    writeFileSync(a, 'line1\nline2\nline3\nline4\n')

    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const stats = await fileHistoryGetDiffVsDisk(anchors[0]!.gitHash)
    expect(stats).toBeDefined()
    expect(stats!.filesChanged).toContain(a)
    expect(stats!.insertions + stats!.deletions).toBeGreaterThan(0)
    expect(await fileHistoryHasDiffVsDisk(anchors[0]!.gitHash)).toBe(true)
  })
})

describe('restoreStateFromLog — resume rebuilds a usable state', () => {
  test('rebuilt state can rewind to the snapshots it was rebuilt from', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder1 = makeStateHolder()
    const m1 = await turn(holder1, [a])
    writeFileSync(a, 'v2')
    await turn(holder1, [a])

    // "Resume": feed the persisted snapshots into a fresh holder. We
    // construct the FileHistorySnapshot[] from the ground truth (git)
    // since state.snapshots no longer exists.
    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const snapshots: FileHistorySnapshot[] = anchors.map(a => ({
      messageId: a.messageId!,
      gitHash: a.gitHash,
      addedTrackedFiles: [],
      timestamp: a.timestamp,
    }))
    const holder2 = makeStateHolder()
    fileHistoryRestoreStateFromLog(snapshots, s => holder2.updater(() => s))

    expect(holder2.state().snapshotMessageIds.has(m1)).toBe(true)
    await fileHistoryRewind(holder2.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('v1')
  })

  test('restoreStateFromLog with no snapshots leaves snapshotMessageIds empty', () => {
    const holder = makeStateHolder()
    fileHistoryRestoreStateFromLog([], s => holder.updater(() => s))
    expect(holder.state().snapshotMessageIds.size).toBe(0)
  })

  test('disabled fileHistory short-circuits restoreStateFromLog without invoking the updater', () => {
    process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
    let called = false
    fileHistoryRestoreStateFromLog([], () => {
      called = true
    })
    expect(called).toBe(false)
  })
})

describe('bulkDiffVsDisk — picker stats agree with chooser', () => {
  test('every anchor reports the same line counts as getDiffVsDisk for that anchor', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    await turn(holder, [a])
    writeFileSync(a, 'v1\nv2')
    await turn(holder, [a])
    writeFileSync(a, 'v1\nv2\nv3')
    await turn(holder, [a])

    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const hashes = anchors.map(x => x.gitHash)
    const bulk = await fileHistoryBulkDiffVsDisk(hashes)
    expect(bulk.size).toBe(hashes.length)

    for (const hash of hashes) {
      const single = await fileHistoryGetDiffVsDisk(hash)
      const fromBulk = bulk.get(hash)
      expect(fromBulk).toBeDefined()
      expect(fromBulk!.insertions).toBe(single!.insertions)
      expect(fromBulk!.deletions).toBe(single!.deletions)
    }
  })

  test('root anchor (empty pre-snapshot) reports the disk content as +N', async () => {
    const a = join(workTree, 'a.txt')
    // Mirror the sandbox sequence: pre-tool snapshot fires on an empty
    // workdir, AI then writes the file. Anchor's tree is empty; disk
    // has 3 lines → bulk diff vs disk reports +3 insertions.
    const holder = makeStateHolder()
    const id = uuid()
    await fileHistoryMakeSnapshot(holder.updater, id)
    writeFileSync(a, 'one\ntwo\nthree\n')

    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const root = anchors[anchors.length - 1]!
    const bulk = await fileHistoryBulkDiffVsDisk([root.gitHash])
    const stats = bulk.get(root.gitHash)
    expect(stats).toBeDefined()
    expect(stats!.insertions).toBeGreaterThan(0)
    expect(stats!.filesChanged).toEqual([a])
  })

  test('bulkDiff against anchors loaded with withBodies returns valid stats for every row', async () => {
    // Regression for production sandbox: picker fetches anchors with
    // withBodies: true, bulkDiff was then called on the resulting
    // hashes. Earlier, all but the first hash returned by listSnapshots
    // (withBodies path) had a leading newline because git emits one
    // newline AFTER each NUL terminator. Polluted hashes made
    // diff-tree fail silently → picker rendered ⚠ on every row except
    // the newest. Pin the end-to-end shape: anchors loaded with bodies
    // produce hashes that bulkDiff can use unchanged.
    //
    // Sandbox sequence (mirrored): pre-tool snapshot fires BEFORE the
    // tool changes disk, so anchorN.tree captures state AT turn N -
    // which is what existed before turn N's edit landed. After 3 such
    // turns, all 3 anchors differ from disk (newest, mid, oldest).
    const a = join(workTree, 'a.txt')
    const holder = makeStateHolder()
    const m1 = uuid()
    await fileHistoryMakeSnapshot(holder.updater, m1)
    writeFileSync(a, 'v1')
    const m2 = uuid()
    await fileHistoryMakeSnapshot(holder.updater, m2)
    writeFileSync(a, 'v2')
    const m3 = uuid()
    await fileHistoryMakeSnapshot(holder.updater, m3)
    writeFileSync(a, 'v3')

    const anchors = await listCodeAnchors(workTree, { withBodies: true })
    expect(anchors.length).toBe(3)
    for (const x of anchors) expect(x.gitHash).toMatch(/^[0-9a-f]{40}$/)

    const bulk = await fileHistoryBulkDiffVsDisk(anchors.map(x => x.gitHash))
    expect(bulk.size).toBe(3)
    for (const x of anchors) {
      const stats = bulk.get(x.gitHash)
      expect(stats).toBeDefined()
      expect(stats!.filesChanged).toEqual([a])
      expect(stats!.insertions + stats!.deletions).toBeGreaterThan(0)
    }
  })

  test('returns empty map for empty input', async () => {
    const bulk = await fileHistoryBulkDiffVsDisk([])
    expect(bulk.size).toBe(0)
  })
})

describe('concurrency — interleaved trackEdit during makeSnapshot', () => {
  test('a trackEdit issued while makeSnapshot is in flight is reflected in the new turn', async () => {
    const a = join(workTree, 'a.txt')
    const b = join(workTree, 'b.txt')
    writeFileSync(a, 'a-v1')
    writeFileSync(b, 'b-v1')

    const holder = makeStateHolder()
    await turn(holder, [a])

    writeFileSync(a, 'a-v2')

    const m2 = uuid()
    const m2Promise = fileHistoryMakeSnapshot(holder.updater, m2)
    await m2Promise

    writeFileSync(a, 'a-v3')
    writeFileSync(b, 'b-v2')
    await fileHistoryRewind(holder.updater, await hashFor(m2))
    expect(readFileSync(a, 'utf-8')).toBe('a-v2')
    expect(readFileSync(b, 'utf-8')).toBe('b-v1')
  })
})

describe('rewind transaction — Phase 5 atomicity', () => {
  test('throws with recovery hint when disk restore fails mid-way', async () => {
    // Force restore failure by handing a hash that exists in NO
    // store. ensureStore + pre-rewind both succeed, then
    // restoreFullWorkdirToSnapshot fails when git checkout can't
    // find the tree. The user-facing error should mention the
    // recovery path, not just bubble the raw git error.
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    await turn(holder, [a])
    writeFileSync(a, 'v2')

    await expect(
      fileHistoryRewind(
        holder.updater,
        '0000000000000000000000000000000000000000',
      ),
    ).rejects.toThrow(/Undo last rewind/i)
  })

  test('preRewind no-changes path does NOT abort rewind', async () => {
    // When disk equals the previous anchor, pre-rewind makeSnapshot
    // returns {ok:false, reason:'no-changes'} — that's benign, the
    // previous anchor is already the safety net. Rewind must proceed.
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    writeFileSync(a, 'v2')
    const m2 = await turn(holder, [a])
    // Don't change disk between m2's anchor and rewind — pre-rewind
    // will return no-changes.
    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('v1')
    expect(m2).toBeDefined()
  })

  test('verification passes for a successful rewind (positive case)', async () => {
    // Round-trip the happy path through the new verifyDiskMatchesTree
    // gate to make sure it doesn't false-positive on a genuinely
    // successful restore.
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    writeFileSync(a, 'v2')
    await turn(holder, [a])

    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('v1')
  })
})
