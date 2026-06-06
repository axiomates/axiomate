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
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
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
} from '../../../bootstrap/state.js'
import {
  bulkDiffEventStats,
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
} from '../../../utils/fileHistory.js'
import { listCodeAnchors } from '../../../utils/checkpoints/listCodeAnchors.js'
import { ensureStore } from '../../../utils/checkpoints/store.js'
import { runCheckpointGit } from '../../../utils/checkpoints/git.js'
import { indexPath, normalizePath, projectHash } from '../../../utils/checkpoints/paths.js'
import { stageWorktreeSnapshotIndex } from '../../../utils/checkpoints/snapshotIndex.js'
import { LABEL_PRE_REWIND } from '../../../utils/checkpoints/reason.js'

let tmpRoot: string
let workTree: string
let originalConfigDir: string | undefined
let originalCwd: string
const GIT_BACKED_TEST_TIMEOUT_MS = 30_000

function gitBackedTest(
  name: string,
  fn: () => void | Promise<void>,
): void {
  test(name, fn, GIT_BACKED_TEST_TIMEOUT_MS)
}

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
    {
      store: storeResult.store,
      workTree: canonical,
      indexFile,
      allowedExitCodes: new Set([1]),
    },
  )
  expect(diff.ok).toBe(true)
  if (diff.ok === false) return
  expect(diff.code).toBe(0)
}

async function latestPreRewindHash(): Promise<string> {
  const anchors = await listCodeAnchors(workTree, { withStats: false })
  const anchor = anchors.find(x => x.subject.includes(`:${LABEL_PRE_REWIND}:`))
  if (!anchor) throw new Error('no pre-rewind anchor found')
  return anchor.gitHash
}

function rewindTempDirNames(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter(name => name.startsWith('axiomate-rewind-')),
  )
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
  gitBackedTest('restores a single edited file to its content at the target turn', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    writeFileSync(a, 'v2')
    await turn(holder, [a])

    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('v1')
  })

  gitBackedTest('cleans up rewind pathspec temp directories after success', async () => {
    const before = rewindTempDirNames()
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    writeFileSync(a, 'v2')
    await turn(holder, [a])

    await fileHistoryRewind(holder.updater, await hashFor(m1))

    const after = rewindTempDirNames()
    for (const name of after) {
      expect(before.has(name)).toBe(true)
    }
  })

  gitBackedTest('does not reuse or leave pathspec temp directories across consecutive rewinds', async () => {
    const before = rewindTempDirNames()
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    writeFileSync(a, 'v2')
    const m2 = await turn(holder, [a])
    writeFileSync(a, 'v3')
    await turn(holder, [a])

    await fileHistoryRewind(holder.updater, await hashFor(m1))
    expect(readFileSync(a, 'utf-8')).toBe('v1')
    await fileHistoryRewind(holder.updater, await hashFor(m2))
    expect(readFileSync(a, 'utf-8')).toBe('v2')

    const after = rewindTempDirNames()
    for (const name of after) {
      expect(before.has(name)).toBe(true)
    }
  })

  gitBackedTest('restores multiple files in one rewind, each to its turn-1 content', async () => {
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

  gitBackedTest('deletes a file that did not exist at the target turn', async () => {
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

  gitBackedTest('rewind covers files NOT registered with trackEdit (full-tree restore)', async () => {
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

  gitBackedTest('rewind to empty-workdir root removes the file the first edit created', async () => {
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

  gitBackedTest('subdirectory paths round-trip through rewind', async () => {
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

  gitBackedTest('rewind result tree equals the target checkpoint tree', async () => {
    mkdirSync(join(workTree, 'dir'))
    const a = join(workTree, 'a.txt')
    const b = join(workTree, 'b.txt')
    const nested = join(workTree, 'dir', 'nested.txt')
    writeFileSync(a, 'a-v1')
    writeFileSync(b, 'b-v1')
    writeFileSync(nested, 'nested-v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a, b, nested])
    const h1 = await hashFor(m1)

    writeFileSync(a, 'a-v2')
    rmSync(b)
    writeFileSync(nested, 'nested-v2')
    writeFileSync(join(workTree, 'fresh.txt'), 'fresh')
    await turn(holder, [a, nested])

    await fileHistoryRewind(holder.updater, h1)

    expect(readFileSync(a, 'utf-8')).toBe('a-v1')
    expect(readFileSync(b, 'utf-8')).toBe('b-v1')
    expect(readFileSync(nested, 'utf-8')).toBe('nested-v1')
    expect(existsSync(join(workTree, 'fresh.txt'))).toBe(false)
    await expectWorktreeTreeEquals(h1)
  })

  gitBackedTest('pre-rewind anchor restores the exact dirty disk content', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    const h1 = await hashFor(m1)
    writeFileSync(a, 'v2')
    await turn(holder, [a])
    writeFileSync(a, 'v3-dirty')

    await fileHistoryRewind(holder.updater, h1)
    expect(readFileSync(a, 'utf-8')).toBe('v1')

    const preRewindHash = await latestPreRewindHash()
    await fileHistoryRewind(holder.updater, preRewindHash)

    expect(readFileSync(a, 'utf-8')).toBe('v3-dirty')
    await expectWorktreeTreeEquals(preRewindHash)
  })

  gitBackedTest('rewind replaces a current directory with a target file', async () => {
    const thing = join(workTree, 'thing')
    writeFileSync(thing, 'file-target')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [thing])
    const h1 = await hashFor(m1)

    rmSync(thing)
    mkdirSync(thing)
    writeFileSync(join(thing, 'child.txt'), 'current directory child')
    await turn(holder, [join(thing, 'child.txt')])

    await fileHistoryRewind(holder.updater, h1)

    expect(statSync(thing).isFile()).toBe(true)
    expect(readFileSync(thing, 'utf-8')).toBe('file-target')
    await expectWorktreeTreeEquals(h1)
  })

  gitBackedTest('rewind replaces a current file with a target directory', async () => {
    const thing = join(workTree, 'thing')
    mkdirSync(thing)
    writeFileSync(join(thing, 'child.txt'), 'directory-target')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [join(thing, 'child.txt')])
    const h1 = await hashFor(m1)

    rmSync(thing, { recursive: true, force: true })
    writeFileSync(thing, 'current file')
    await turn(holder, [thing])

    await fileHistoryRewind(holder.updater, h1)

    expect(statSync(thing).isDirectory()).toBe(true)
    expect(readFileSync(join(thing, 'child.txt'), 'utf-8')).toBe('directory-target')
    await expectWorktreeTreeEquals(h1)
  })

  gitBackedTest('rewind handles rename-equivalent changes', async () => {
    const oldPath = join(workTree, 'old.txt')
    const newPath = join(workTree, 'new.txt')
    writeFileSync(oldPath, 'old-target')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [oldPath])
    const h1 = await hashFor(m1)

    rmSync(oldPath)
    writeFileSync(newPath, 'renamed-current')
    await turn(holder, [newPath])

    await fileHistoryRewind(holder.updater, h1)

    expect(readFileSync(oldPath, 'utf-8')).toBe('old-target')
    expect(existsSync(newPath)).toBe(false)
    await expectWorktreeTreeEquals(h1)
  })

  gitBackedTest('rewind handles spaces, punctuation, and unicode paths', async () => {
    const paths = [
      join(workTree, 'space dir', 'file name.txt'),
      join(workTree, 'symbols', 'safe (1)+=,@.txt'),
      join(workTree, 'unicode', '文件.txt'),
    ]
    for (const p of paths) mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(paths[0]!, 'space-v1')
    writeFileSync(paths[1]!, 'symbols-v1')
    writeFileSync(paths[2]!, 'unicode-v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, paths)
    const h1 = await hashFor(m1)

    writeFileSync(paths[0]!, 'space-v2')
    rmSync(paths[1]!)
    writeFileSync(paths[2]!, 'unicode-v2')
    writeFileSync(join(workTree, 'space dir', 'fresh name.txt'), 'fresh')
    await turn(holder, paths)

    await fileHistoryRewind(holder.updater, h1)

    expect(readFileSync(paths[0]!, 'utf-8')).toBe('space-v1')
    expect(readFileSync(paths[1]!, 'utf-8')).toBe('symbols-v1')
    expect(readFileSync(paths[2]!, 'utf-8')).toBe('unicode-v1')
    expect(existsSync(join(workTree, 'space dir', 'fresh name.txt'))).toBe(false)
    await expectWorktreeTreeEquals(h1)
  })

  gitBackedTest('rewind restores ordinary files inside an embedded Git repository', async () => {
    const nested = join(workTree, 'nested')
    mkdirSync(join(nested, '.git'), { recursive: true })
    writeFileSync(join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(nested, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(nested, 'dirty.txt'), 'nested-v1')
    writeFileSync(join(nested, 'ignored.txt'), 'ignored-v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [join(nested, 'dirty.txt')])
    const h1 = await hashFor(m1)

    writeFileSync(join(nested, 'dirty.txt'), 'nested-v2')
    writeFileSync(join(nested, 'untracked.txt'), 'untracked-current')
    writeFileSync(join(nested, 'ignored.txt'), 'ignored-v2')
    await turn(holder, [join(nested, 'dirty.txt'), join(nested, 'untracked.txt')])

    await fileHistoryRewind(holder.updater, h1)

    expect(readFileSync(join(nested, 'dirty.txt'), 'utf-8')).toBe('nested-v1')
    expect(existsSync(join(nested, 'untracked.txt'))).toBe(false)
    expect(readFileSync(join(nested, 'ignored.txt'), 'utf-8')).toBe('ignored-v2')
    expect(existsSync(join(nested, '.git', 'HEAD'))).toBe(true)
    await expectWorktreeTreeEquals(h1)
  })

  gitBackedTest('throws when gitHash is unknown', async () => {
    const holder = makeStateHolder()
    await turn(holder, [])
    await expect(
      fileHistoryRewind(
        holder.updater,
        '0000000000000000000000000000000000000000',
      ),
    ).rejects.toThrow(/no longer available|refresh|Rewind failed|Undo last rewind/i)
  })

  gitBackedTest('rewinding twice in a row restores the same content (idempotent)', async () => {
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

  gitBackedTest('throws when given a hash that does not exist in the store', async () => {
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
    ).rejects.toThrow(/no longer available|refresh|Rewind failed|Undo last rewind/i)
    expect(readFileSync(a, 'utf-8')).toBe('v2')
  })
})

describe('getDiffVsDisk / hasDiffVsDisk — chooser preview source', () => {
  gitBackedTest('zero counts when nothing has changed since the snapshot', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'one\ntwo\n')
    const holder = makeStateHolder()
    await turn(holder, [a])

    const anchors = await listCodeAnchors(workTree, { withStats: false })
    const stats = await fileHistoryGetDiffVsDisk(anchors[0]!.gitHash)
    expect(stats).toEqual({ filesChanged: [], insertions: 0, deletions: 0 })
    expect(await fileHistoryHasDiffVsDisk(anchors[0]!.gitHash)).toBe(false)
  })

  gitBackedTest('reports edited file with non-zero line counts and changed paths', async () => {
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
  gitBackedTest('rebuilt state can rewind to the snapshots it was rebuilt from', async () => {
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
  gitBackedTest('every anchor reports the same line counts as getDiffVsDisk for that anchor', async () => {
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

  gitBackedTest('root anchor (empty pre-snapshot) reports the disk content as +N', async () => {
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

  gitBackedTest('bulkDiff against anchors loaded with withBodies returns valid stats for every row', async () => {
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
  gitBackedTest('a trackEdit issued while makeSnapshot is in flight is reflected in the new turn', async () => {
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
  gitBackedTest('preRewind no-changes path does NOT abort rewind', async () => {
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

  gitBackedTest('verification passes for a successful rewind (positive case)', async () => {
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

  gitBackedTest('Phase 7: rewind on a missing hash throws refresh hint, NOT undo hint', async () => {
    // A hash of valid SHA-1 shape that doesn't exist in the store.
    // The pre-Phase-7 path would still call fileHistoryMakeSnapshot
    // for the safety snapshot, then fail in restoreFullWorkdirToSnapshot
    // with the "Undo last rewind" recovery message — but disk has
    // never been modified, so that hint is misleading. Phase 7 makes
    // the existence check come first and throws a refresh-pointing
    // message that doesn't reference an undo path.
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    await turn(holder, [a])
    writeFileSync(a, 'v2')

    const fakeHash = '0000000000000000000000000000000000000000'
    let caught: Error | undefined
    try {
      await fileHistoryRewind(holder.updater, fakeHash)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/no longer available|refresh/i)
    // Must NOT mention "Undo last rewind" — disk was never touched,
    // there is nothing to undo.
    expect(caught!.message).not.toMatch(/Undo last rewind/i)
    // Disk unchanged.
    expect(readFileSync(a, 'utf-8')).toBe('v2')
  })

  gitBackedTest('Phase 7: rewind to a real anchor still succeeds (existence check is non-destructive)', async () => {
    // Sanity: the cat-file gate must not false-negative on real
    // anchors.
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

describe('bulkDiffEventStats — event-aligned stats', () => {
  // The picker / list CHANGES column should describe what THIS row's
  // turn wrote, not what the turn before it wrote. Since axiomate stores
  // pre-tool snapshots, that means each anchor's stats are computed
  // against the next-newer anchor (or against current disk for the
  // newest row).

  gitBackedTest('two-turn v1 → v2 sequence: latest gets +1 -1, oldest gets +1 -0', async () => {
    // Mirror sandbox: empty workdir, "create v1" turn, "v1 → v2" turn,
    // disk = v2. Anchors are pre-tool snapshots (newest first):
    //   anchors[0] (Before "v1 → v2") tree = v1
    //   anchors[1] (Before "create")  tree = ∅
    //   diskTree = v2
    // Event-aligned:
    //   stats[0] = diff(v1, v2) = +1 -1
    //   stats[1] = diff(∅, v1) = +1 -0
    const a = join(workTree, 'a.txt')
    const holder = makeStateHolder()
    await fileHistoryMakeSnapshot(holder.updater, uuid())
    writeFileSync(a, 'v1\n')
    await fileHistoryMakeSnapshot(holder.updater, uuid())
    writeFileSync(a, 'v2\n')

    const anchors = await listCodeAnchors(workTree, { withStats: true })
    expect(anchors.length).toBe(2)
    const stats = await bulkDiffEventStats(
      anchors.map(x => ({
        gitHash: x.gitHash,
        filesChanged: x.filesChanged,
        insertions: x.insertions,
        deletions: x.deletions,
        filePaths: x.filePaths,
      })),
    )
    expect(stats.size).toBe(2)
    const newest = stats.get(anchors[0]!.gitHash)!
    const oldest = stats.get(anchors[1]!.gitHash)!
    expect(newest.insertions).toBe(1)
    expect(newest.deletions).toBe(1)
    expect(oldest.insertions).toBe(1)
    expect(oldest.deletions).toBe(0)
  })

  gitBackedTest('single-anchor case: stats vs disk', async () => {
    // Only one anchor: it has no prev anchor, so stats[0] falls back
    // to anchor-vs-disk — describes what the latest turn wrote.
    const a = join(workTree, 'a.txt')
    const holder = makeStateHolder()
    await fileHistoryMakeSnapshot(holder.updater, uuid())
    writeFileSync(a, 'one\ntwo\n')

    const anchors = await listCodeAnchors(workTree, { withStats: true })
    expect(anchors.length).toBe(1)
    const stats = await bulkDiffEventStats(
      anchors.map(x => ({
        gitHash: x.gitHash,
        filesChanged: x.filesChanged,
        insertions: x.insertions,
        deletions: x.deletions,
        filePaths: x.filePaths,
      })),
    )
    const only = stats.get(anchors[0]!.gitHash)!
    expect(only.insertions).toBe(2)
    expect(only.deletions).toBe(0)
  })

  test('empty input returns empty map', async () => {
    const stats = await bulkDiffEventStats([])
    expect(stats.size).toBe(0)
  })
})
