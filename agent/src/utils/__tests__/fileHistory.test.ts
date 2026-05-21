/**
 * Behavior-only tests for `fileHistory`.
 *
 * RULES OF THIS FILE — read before adding tests:
 *
 *   1. Observe state ONLY through public API: rewind / canRestore /
 *      hasAnyChanges / getDiffStats / restoreStateFromLog.
 *   2. NEVER assert internal shape. No probing of `state.snapshots[i]
 *      .trackedFileBackups[k]`, no `version === N`, no `backupFileName
 *      matches @vN`, no object-identity reuse checks.
 *   3. Every assertion stays green across backend changes. If a test would
 *      break because storage moved between implementations, it does not
 *      belong here.
 *
 * Isolation: per-test AXIOMATE_CONFIG_DIR sandbox, per-test workTree wired
 * through setOriginalCwd, force-interactive so fileHistoryEnabled() exercises
 * the same path as the REPL.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
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
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
  fileHistoryHasAnyChanges,
  fileHistoryMakeSnapshot,
  fileHistoryRestoreStateFromLog,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from '../fileHistory.js'

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
})

afterEach(() => {
  delete process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING
  if (originalConfigDir === undefined) delete process.env.AXIOMATE_CONFIG_DIR
  else process.env.AXIOMATE_CONFIG_DIR = originalConfigDir
  setOriginalCwd(originalCwd)
  setIsInteractive(false)
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeStateHolder(): {
  state: () => FileHistoryState
  updater: (f: (prev: FileHistoryState) => FileHistoryState) => void
} {
  let state: FileHistoryState = {
    snapshots: [],
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

/**
 * Drive a turn end-to-end: snapshot at messageId, then trackEdit each
 * file. Returns the messageId so callers can restore back to it.
 *
 * Call BEFORE the tool's edit (matches production order: trackEdit
 * captures pre-edit state, makeSnapshot at the start of the next turn
 * captures post-edit state).
 */
async function turn(
  holder: ReturnType<typeof makeStateHolder>,
  files: readonly string[],
): Promise<UUID> {
  const id = uuid()
  await fileHistoryMakeSnapshot(holder.updater, id)
  for (const f of files) await fileHistoryTrackEdit(holder.updater, f)
  return id
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

    await fileHistoryRewind(holder.updater, m1)
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

    await fileHistoryRewind(holder.updater, m1)
    expect(readFileSync(a, 'utf-8')).toBe('a-v1')
    expect(readFileSync(b, 'utf-8')).toBe('b-v1')
  })

  test('deletes a file that did not exist at the target turn', async () => {
    const newPath = join(workTree, 'created-later.txt')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [newPath]) // tracked while non-existent
    writeFileSync(newPath, 'now-exists')
    await turn(holder, [newPath])

    await fileHistoryRewind(holder.updater, m1)
    expect(existsSync(newPath)).toBe(false)
  })

  test('only restores tracked files; leaves manual user edits to untracked files alone', async () => {
    // The load-bearing assertion for Phase 3: rewind blast radius must
    // stay scoped to state.trackedFiles. Phase 3's git-checkout swap
    // must be invoked with `paths: [...trackedFiles]` to keep this.
    const tracked = join(workTree, 'tracked.txt')
    const manual = join(workTree, 'manual.txt')
    writeFileSync(tracked, 'tracked-v1')
    writeFileSync(manual, 'manual-v1')

    const holder = makeStateHolder()
    const m1 = await turn(holder, [tracked])
    writeFileSync(tracked, 'tracked-v2')
    writeFileSync(manual, 'manual-v2-edited-by-user') // never tracked
    await turn(holder, [tracked])

    await fileHistoryRewind(holder.updater, m1)
    expect(readFileSync(tracked, 'utf-8')).toBe('tracked-v1')
    expect(readFileSync(manual, 'utf-8')).toBe('manual-v2-edited-by-user')
  })

  test('subdirectory paths round-trip through rewind', async () => {
    mkdirSync(join(workTree, 'src'))
    const f = join(workTree, 'src', 'foo.ts')
    writeFileSync(f, 'export const x = 1\n')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [f])
    writeFileSync(f, 'export const x = 2\n')
    await turn(holder, [f])

    await fileHistoryRewind(holder.updater, m1)
    expect(readFileSync(f, 'utf-8')).toBe('export const x = 1\n')
  })

  test('throws when messageId is unknown', async () => {
    const holder = makeStateHolder()
    await turn(holder, [])
    await expect(
      fileHistoryRewind(holder.updater, uuid()),
    ).rejects.toThrow(/selected snapshot was not found/i)
  })

  test('rewinding twice in a row restores the same content (idempotent)', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m1 = await turn(holder, [a])
    writeFileSync(a, 'v2')
    await turn(holder, [a])

    await fileHistoryRewind(holder.updater, m1)
    expect(readFileSync(a, 'utf-8')).toBe('v1')
    await fileHistoryRewind(holder.updater, m1)
    expect(readFileSync(a, 'utf-8')).toBe('v1')
  })
})

describe('canRestore — restorability predicate', () => {
  test('true for a known messageId, false for an unknown one', async () => {
    const holder = makeStateHolder()
    const m = await turn(holder, [])
    expect(fileHistoryCanRestore(holder.state(), m)).toBe(true)
    expect(fileHistoryCanRestore(holder.state(), uuid())).toBe(false)
  })

  test('false when fileHistory is disabled, even if the snapshot exists', async () => {
    const holder = makeStateHolder()
    const m = await turn(holder, [])
    process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
    expect(fileHistoryCanRestore(holder.state(), m)).toBe(false)
  })
})

describe('hasAnyChanges — observable disk diff', () => {
  test('false when no tracked file has changed since the snapshot', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'stable')
    const holder = makeStateHolder()
    const m = await turn(holder, [a])
    expect(await fileHistoryHasAnyChanges(holder.state(), m)).toBe(false)
  })

  test('true after a tracked file is edited on disk', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m = await turn(holder, [a])
    writeFileSync(a, 'v2 different size')
    expect(await fileHistoryHasAnyChanges(holder.state(), m)).toBe(true)
  })

  test('true after a previously-missing tracked file is created', async () => {
    const newPath = join(workTree, 'created.txt')
    const holder = makeStateHolder()
    const m = await turn(holder, [newPath]) // tracked while non-existent
    writeFileSync(newPath, 'now-exists')
    expect(await fileHistoryHasAnyChanges(holder.state(), m)).toBe(true)
  })

  test('true after a tracked file is deleted', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder = makeStateHolder()
    const m = await turn(holder, [a])
    rmSync(a)
    expect(await fileHistoryHasAnyChanges(holder.state(), m)).toBe(true)
  })

  test('false for an unknown messageId', async () => {
    const holder = makeStateHolder()
    await turn(holder, [])
    expect(await fileHistoryHasAnyChanges(holder.state(), uuid())).toBe(false)
  })
})

describe('getDiffStats — file list and line counts', () => {
  test('zero counts and empty filesChanged when nothing has changed', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'one\ntwo\n')
    const holder = makeStateHolder()
    const m = await turn(holder, [a])
    const stats = await fileHistoryGetDiffStats(holder.state(), m)
    expect(stats).toEqual({
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })
  })

  test('reports an edited file in filesChanged with non-zero line counts', async () => {
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'line1\nline2\n')
    const holder = makeStateHolder()
    const m = await turn(holder, [a])
    writeFileSync(a, 'line1\nline2\nline3\nline4\n')

    const stats = await fileHistoryGetDiffStats(holder.state(), m)
    expect(stats).toBeDefined()
    expect(stats!.filesChanged).toEqual([a])
    expect(stats!.insertions + stats!.deletions).toBeGreaterThan(0)
  })

  test('reports multiple changed files in filesChanged', async () => {
    const a = join(workTree, 'a.txt')
    const b = join(workTree, 'b.txt')
    writeFileSync(a, 'a-v1')
    writeFileSync(b, 'b-v1')
    const holder = makeStateHolder()
    const m = await turn(holder, [a, b])
    writeFileSync(a, 'a-v2-very-different-content')
    writeFileSync(b, 'b-v2-very-different-content')

    const stats = await fileHistoryGetDiffStats(holder.state(), m)
    expect(stats).toBeDefined()
    // Order isn't guaranteed; assert as a set.
    expect(new Set(stats!.filesChanged)).toEqual(new Set([a, b]))
  })

  test('undefined for unknown messageId or when disabled', async () => {
    const holder = makeStateHolder()
    const m = await turn(holder, [])
    expect(await fileHistoryGetDiffStats(holder.state(), uuid())).toBeUndefined()
    process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
    expect(await fileHistoryGetDiffStats(holder.state(), m)).toBeUndefined()
  })
})

describe('snapshot retention — oldest turns become unrestorable', () => {
  test('after 102 turns, the first two messageIds are no longer restorable', async () => {
    // The exact retention number is an implementation detail; the
    // BEHAVIOR we pin is "history is bounded — the oldest turns drop
    // off, the newest stay available." Phase 3's git ring-buffer prune
    // must keep this same observable shape.
    const holder = makeStateHolder()
    const ids: UUID[] = []
    for (let i = 0; i < 102; i++) ids.push(await turn(holder, []))

    expect(fileHistoryCanRestore(holder.state(), ids[0])).toBe(false)
    expect(fileHistoryCanRestore(holder.state(), ids[1])).toBe(false)
    expect(fileHistoryCanRestore(holder.state(), ids.at(-1)!)).toBe(true)
    expect(fileHistoryCanRestore(holder.state(), ids[2])).toBe(true)
  }, 60_000)
})

describe('restoreStateFromLog — resume rebuilds a usable state', () => {
  test('rebuilt state can rewind to the snapshots it was rebuilt from', async () => {
    // The behavioral guarantee: after rebuilding state from a log of
    // snapshots, fileHistoryRewind(messageId) restores the file content
    // that existed when those snapshots were taken. Phase 3's schema
    // change (gitHash field) must keep this property — anything else
    // is a regression in /resume.
    const a = join(workTree, 'a.txt')
    writeFileSync(a, 'v1')
    const holder1 = makeStateHolder()
    const m1 = await turn(holder1, [a])
    writeFileSync(a, 'v2')
    await turn(holder1, [a])

    // "Resume" by feeding the persisted snapshots into a fresh holder.
    const holder2 = makeStateHolder()
    fileHistoryRestoreStateFromLog(holder1.state().snapshots, s =>
      holder2.updater(() => s),
    )

    // The rebuilt state knows about m1 — same behavioral predicate.
    expect(fileHistoryCanRestore(holder2.state(), m1)).toBe(true)

    // And rewind through it actually restores v1 on disk.
    await fileHistoryRewind(holder2.updater, m1)
    expect(readFileSync(a, 'utf-8')).toBe('v1')
  })

  test('restoreStateFromLog with no snapshots leaves canRestore=false for every id', () => {
    const holder = makeStateHolder()
    fileHistoryRestoreStateFromLog([], s => holder.updater(() => s))
    expect(fileHistoryCanRestore(holder.state(), uuid())).toBe(false)
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

describe('concurrency — interleaved trackEdit during makeSnapshot still produces a coherent snapshot', () => {
  test('a trackEdit issued while makeSnapshot is in flight is reflected in the new turn', async () => {
    // makeSnapshot has an internal phase-2 await window. trackEdit can
    // race into that window in production. The behavioral contract:
    // after both promises resolve, the just-tracked file is restorable
    // from the new snapshot.
    const a = join(workTree, 'a.txt')
    const b = join(workTree, 'b.txt')
    writeFileSync(a, 'a-v1')
    writeFileSync(b, 'b-v1')

    const holder = makeStateHolder()
    await turn(holder, [a])

    // Start turn 2 — but inject a trackEdit for b mid-flight.
    const m2 = uuid()
    const m2Promise = fileHistoryMakeSnapshot(holder.updater, m2)
    await fileHistoryTrackEdit(holder.updater, b)
    await m2Promise

    // After m2 settles, both files are restorable through the new turn:
    // editing both on disk and rewinding to m2 must restore them to the
    // pre-edit content.
    writeFileSync(a, 'a-v2')
    writeFileSync(b, 'b-v2')
    await fileHistoryRewind(holder.updater, m2)
    expect(readFileSync(a, 'utf-8')).toBe('a-v1')
    expect(readFileSync(b, 'utf-8')).toBe('b-v1')
  })
})
