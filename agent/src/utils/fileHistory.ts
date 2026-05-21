/**
 * fileHistory — turn-keyed snapshot/rewind built on the Checkpoints v2
 * shadow-git store.
 *
 * Public API surface (call sites in REPL, QueryEngine, Tools, etc.):
 *   - fileHistoryEnabled
 *   - fileHistoryTrackEdit       register a path so rewind covers it
 *   - fileHistoryMakeSnapshot    commit the workdir to the shared store
 *   - fileHistoryRewind          restore tracked paths to a prior turn
 *   - fileHistoryCanRestore      predicate for /rewind selector
 *   - fileHistoryGetDiffStats    insertions/deletions vs current workdir
 *   - fileHistoryHasAnyChanges   boolean version of the above
 *   - fileHistoryRestoreStateFromLog   resume support
 *
 * Storage model: each turn produces ONE commit in the shared shadow store
 * at `~/.axiomate/checkpoints/store/`, keyed by the per-project ref. The
 * commit captures the full workdir (minus DEFAULT_EXCLUDES), but rewind
 * is scoped via `state.trackedFiles` so untracked manual edits are never
 * touched. That scoping invariant is the load-bearing contract — see
 * `__tests__/fileHistory.test.ts` "only restores tracked files…".
 *
 * Schema vs v1: the legacy file-copy backend stored per-snapshot
 * `trackedFileBackups: Record<path, {backupFileName, version}>`. v2
 * replaces that with `gitHash: string` + a per-snapshot
 * `trackedFiles: readonly string[]` (cumulative-at-commit) so resume can
 * rebuild `state.trackedFiles` without reading the git history.
 */

import type { UUID } from 'crypto'
import { existsSync } from 'fs'
import { unlink } from 'fs/promises'
import { isAbsolute, join, relative } from 'path'
import {
  getIsNonInteractiveSession,
  getOriginalCwd,
} from '../bootstrap/state.js'
import { createSnapshot } from './checkpoints/createSnapshot.js'
import { runCheckpointGit } from './checkpoints/git.js'
import {
  indexPath,
  normalizePath,
  projectHash,
} from './checkpoints/paths.js'
import { rollback } from './checkpoints/rollback.js'
import { ensureStore } from './checkpoints/store.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { isENOENT } from './errors.js'
import { logError } from './log.js'
import { recordFileHistorySnapshot } from './sessionStorage.js'

export type FileHistorySnapshot = {
  /** Anthropic message id this snapshot was taken at the start of. */
  messageId: UUID
  /** Commit hash in the shared shadow store. */
  gitHash: string
  /**
   * Cumulative tracked-paths set at (or shortly after) the commit. Stored
   * per-snapshot so `fileHistoryRestoreStateFromLog` can rebuild
   * `state.trackedFiles` without scanning git history. trackEdit during
   * an open turn updates the most-recent snapshot's entry.
   */
  trackedFiles: readonly string[]
  timestamp: Date
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  /**
   * Accumulated set of paths edited by tools during this session.
   * Monotonically grows; rewind blast-radius is exactly this set.
   */
  trackedFiles: Set<string>
  /**
   * Activity counter for `useGitDiffStats`. Increments on every snapshot,
   * even when MAX_SNAPSHOTS eviction keeps `snapshots.length` plateaued.
   */
  snapshotSequence: number
}

export type DiffStats =
  | {
      filesChanged?: string[]
      insertions: number
      deletions: number
    }
  | undefined

const MAX_SNAPSHOTS = 100
const DIFF_HAS_CHANGES = new Set([0, 1])
const REF_NOT_PRESENT = new Set([128, 129])

export function fileHistoryEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    return fileHistoryEnabledSdk()
  }
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
    !isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

function fileHistoryEnabledSdk(): boolean {
  return (
    isEnvTruthy(process.env.AXIOMATE_CODE_ENABLE_SDK_FILE_CHECKPOINTING) &&
    !isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

/**
 * Register a file path so a future rewind covers it. Tools call this
 * BEFORE editing the file (matches the previous file-copy backend's
 * call-site contract).
 *
 * The shadow-git backend captures content via the per-turn snapshot, so
 * trackEdit only needs to mutate state — no per-edit IO. Hence the lack
 * of a messageId arg: it's intentionally not the snapshot key here.
 */
export async function fileHistoryTrackEdit(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  filePath: string,
): Promise<void> {
  if (!fileHistoryEnabled()) return

  const trackingPath = maybeShortenFilePath(filePath)

  let updatedSnapshot: FileHistorySnapshot | undefined
  updateFileHistoryState(state => {
    if (state.trackedFiles.has(trackingPath)) {
      return state
    }
    const trackedFiles = new Set(state.trackedFiles).add(trackingPath)
    let snapshots = state.snapshots
    const last = state.snapshots.at(-1)
    if (last && !last.trackedFiles.includes(trackingPath)) {
      const updated: FileHistorySnapshot = {
        ...last,
        trackedFiles: [...last.trackedFiles, trackingPath],
      }
      updatedSnapshot = updated
      snapshots = state.snapshots.slice()
      snapshots[snapshots.length - 1] = updated
    }
    return { ...state, trackedFiles, snapshots }
  })

  if (updatedSnapshot) {
    void recordFileHistorySnapshot(
      updatedSnapshot.messageId,
      updatedSnapshot,
      true,
    ).catch(error => {
      logError(new Error(`FileHistory: Failed to record snapshot: ${error}`))
    })
    logForDebugging(`FileHistory: Tracked file modification for ${filePath}`)
  }
}

/**
 * Capture the current workdir as a snapshot keyed by `messageId`. Called
 * once at the start of every turn. The createSnapshot call uses
 * `allowEmpty: true` so even no-op turns get a gitHash — rewind always
 * has a target to roll back to.
 */
export async function fileHistoryMakeSnapshot(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) return

  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  logForDebugging(`FileHistory: Making snapshot for message ${messageId}`)

  const workdir = getOriginalCwd()
  const result = await createSnapshot(
    workdir,
    { messageId, label: 'file-history' },
    { allowEmpty: true },
  )
  if (result.ok === false) {
    logForDebugging(
      `FileHistory: snapshot skipped for ${messageId} (${result.skipped})`,
    )
    return
  }

  let committed: FileHistorySnapshot | undefined
  updateFileHistoryState(state => {
    const snapshot: FileHistorySnapshot = {
      messageId,
      gitHash: result.hash,
      trackedFiles: Array.from(state.trackedFiles),
      timestamp: new Date(),
    }
    committed = snapshot
    const all = [...state.snapshots, snapshot]
    return {
      ...state,
      snapshots: all.length > MAX_SNAPSHOTS ? all.slice(-MAX_SNAPSHOTS) : all,
      snapshotSequence: (state.snapshotSequence ?? 0) + 1,
    }
  })

  if (committed) {
    void recordFileHistorySnapshot(messageId, committed, false).catch(
      error => {
        logError(
          new Error(`FileHistory: Failed to record snapshot: ${error}`),
        )
      },
    )
    logForDebugging(
      `FileHistory: Added snapshot for ${messageId}, tracking ${captured.trackedFiles.size} files`,
    )
  }
}

/**
 * Restore tracked paths to their state at `messageId`. Throws if the
 * messageId is unknown — call sites already gate on
 * `fileHistoryCanRestore` before invoking this.
 */
export async function fileHistoryRewind(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) return

  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  const target = captured.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  if (!target) {
    logError(new Error(`FileHistory: Snapshot for ${messageId} not found`))
    throw new Error('The selected snapshot was not found')
  }

  logForDebugging(
    `FileHistory: [Rewind] Rewinding to snapshot for ${messageId}`,
  )
  await restoreTrackedToSnapshot(
    getOriginalCwd(),
    target.gitHash,
    Array.from(captured.trackedFiles),
  )
  logForDebugging(`FileHistory: [Rewind] Finished rewinding to ${messageId}`)
}

export function fileHistoryCanRestore(
  state: FileHistoryState,
  messageId: UUID,
): boolean {
  if (!fileHistoryEnabled()) return false
  return state.snapshots.some(snapshot => snapshot.messageId === messageId)
}

export async function fileHistoryGetDiffStats(
  state: FileHistoryState,
  messageId: UUID,
): Promise<DiffStats> {
  if (!fileHistoryEnabled()) return undefined
  const target = state.snapshots.findLast(s => s.messageId === messageId)
  if (!target) return undefined

  const paths = Array.from(state.trackedFiles)
  if (paths.length === 0) {
    return { filesChanged: [], insertions: 0, deletions: 0 }
  }

  const storeResult = await ensureStore()
  if (storeResult.ok === false) {
    return { filesChanged: [], insertions: 0, deletions: 0 }
  }
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  // Pre-compute tree-vs-disk membership: paths that flipped existence
  // between the snapshot and now don't show up in `git diff <hash>`
  // (they're not in any tree it can reach), but they ARE changes.
  const tree = await readTree(storeResult.store, canonical, target.gitHash)
  const flipped: string[] = []
  if (tree) {
    for (const p of paths) {
      const inTree = tree.has(toForwardSlash(p))
      const onDisk = existsSync(maybeExpandFilePath(p))
      if (inTree !== onDisk) flipped.push(p)
    }
  }

  const nameOnly = await runCheckpointGit(
    ['diff', '--name-only', target.gitHash, '--', ...paths],
    {
      store: storeResult.store,
      workTree: canonical,
      indexFile,
      allowedExitCodes: REF_NOT_PRESENT,
    },
  )
  const filesRel = nameOnly.ok
    ? nameOnly.stdout.split('\n').filter(line => line.length > 0)
    : []
  const allChangedRel = new Set([...filesRel, ...flipped])

  const shortstat = await runCheckpointGit(
    ['diff', '--shortstat', target.gitHash, '--', ...paths],
    {
      store: storeResult.store,
      workTree: canonical,
      indexFile,
      allowedExitCodes: REF_NOT_PRESENT,
    },
  )
  let insertions = 0
  let deletions = 0
  if (shortstat.ok) {
    const ins = shortstat.stdout.match(/(\d+) insertions?\(\+\)/)
    const del = shortstat.stdout.match(/(\d+) deletions?\(-\)/)
    if (ins) insertions = Number.parseInt(ins[1], 10)
    if (del) deletions = Number.parseInt(del[1], 10)
  }

  return {
    filesChanged: Array.from(allChangedRel, p => maybeExpandFilePath(p)),
    insertions,
    deletions,
  }
}

/**
 * Boolean equivalent of `fileHistoryGetDiffStats` — short-circuits via
 * `git diff --quiet` so the dominant cost (counting lines) is skipped.
 *
 * Has to combine three signals because `git diff <hash>` only sees paths
 * that are either in the snapshot tree or in the index — a tracked-but-
 * never-committed path that materializes on disk after the snapshot is
 * invisible to plain diff. So we compare structural state (in-tree vs
 * on-disk) first, then fall through to a content diff for paths in both.
 */
export async function fileHistoryHasAnyChanges(
  state: FileHistoryState,
  messageId: UUID,
): Promise<boolean> {
  if (!fileHistoryEnabled()) return false
  const target = state.snapshots.findLast(s => s.messageId === messageId)
  if (!target) return false

  const paths = Array.from(state.trackedFiles)
  if (paths.length === 0) return false

  const storeResult = await ensureStore()
  if (storeResult.ok === false) return false
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  const tree = await readTree(storeResult.store, canonical, target.gitHash)
  if (!tree) return false

  const inBoth: string[] = []
  for (const p of paths) {
    const inTree = tree.has(toForwardSlash(p))
    const onDisk = existsSync(maybeExpandFilePath(p))
    if (inTree !== onDisk) return true
    if (inTree && onDisk) inBoth.push(p)
  }
  if (inBoth.length === 0) return false

  // diff --quiet exits 0 if no changes, 1 if changes. allowedExitCodes
  // covers both so neither path becomes a transient-error miss.
  const result = await runCheckpointGit(
    ['diff', '--quiet', target.gitHash, '--', ...inBoth],
    {
      store: storeResult.store,
      workTree: canonical,
      indexFile,
      allowedExitCodes: DIFF_HAS_CHANGES,
    },
  )
  if (result.ok === false) return false
  return result.code === 1
}

/**
 * Resume entry: rebuild state from a persisted snapshot list. Each
 * snapshot's `trackedFiles` is unioned into `state.trackedFiles` so
 * rewind blast-radius matches the pre-resume session.
 *
 * The persisted log is append-only and can outgrow the in-memory ring
 * buffer (a long-running session that resumes repeatedly). We mirror the
 * `fileHistoryMakeSnapshot` cap here: keep only the most recent
 * MAX_SNAPSHOTS, but union the *whole* persisted log's trackedFiles
 * because rewind blast-radius is cumulative — a file the user wants to
 * rewind to a kept snapshot must still be in trackedFiles even if the
 * snapshot that first registered it has aged out.
 */
export function fileHistoryRestoreStateFromLog(
  fileHistorySnapshots: FileHistorySnapshot[],
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) return

  const trackedFiles = new Set<string>()
  const snapshots: FileHistorySnapshot[] = []
  for (const snapshot of fileHistorySnapshots) {
    const trackedList: string[] = []
    for (const path of snapshot.trackedFiles ?? []) {
      const trackingPath = maybeShortenFilePath(path)
      trackedFiles.add(trackingPath)
      trackedList.push(trackingPath)
    }
    snapshots.push({ ...snapshot, trackedFiles: trackedList })
  }
  const trimmed =
    snapshots.length > MAX_SNAPSHOTS ? snapshots.slice(-MAX_SNAPSHOTS) : snapshots
  onUpdateState({
    snapshots: trimmed,
    trackedFiles,
    snapshotSequence: snapshots.length,
  })
}

/**
 * Restore tracked paths to a snapshot commit. Splits into "exists in
 * snapshot tree" vs "absent from tree" because `git checkout <hash> --
 * <path>` errors if a path is missing from the tree. Existing paths go
 * through `rollback` (re-uses its index-seeding); missing paths get
 * unlinked from disk to satisfy "rewind to a turn where this file did
 * not exist" semantics.
 */
async function restoreTrackedToSnapshot(
  workdir: string,
  gitHash: string,
  trackedFiles: readonly string[],
): Promise<void> {
  if (trackedFiles.length === 0) return

  const storeResult = await ensureStore()
  if (storeResult.ok === false) {
    throw new Error(`ensureStore: ${storeResult.reason}`)
  }
  const store = storeResult.store
  const canonical = normalizePath(workdir)

  const tree = await readTree(store, canonical, gitHash)
  if (!tree) {
    throw new Error(`ls-tree failed for ${gitHash}`)
  }

  const existing: string[] = []
  const missing: string[] = []
  for (const p of trackedFiles) {
    if (tree.has(toForwardSlash(p))) existing.push(p)
    else missing.push(p)
  }

  if (existing.length > 0) {
    const result = await rollback(canonical, gitHash, { paths: existing })
    if (result.ok === false) {
      throw new Error(`rollback: ${result.reason} ${result.message}`)
    }
  }

  for (const p of missing) {
    const abs = maybeExpandFilePath(p)
    try {
      await unlink(abs)
      logForDebugging(`FileHistory: [Rewind] Deleted ${abs}`)
    } catch (err: unknown) {
      if (!isENOENT(err)) logError(err)
    }
  }
}

/**
 * `git ls-tree -r --name-only <hash>` → set of forward-slash paths in
 * the snapshot tree. Returns null on git failure so callers can decide
 * whether to fail open. The set lets us answer "did this path exist at
 * snapshot time?" without an extra git invocation per path.
 */
async function readTree(
  store: string,
  workTree: string,
  gitHash: string,
): Promise<Set<string> | null> {
  const result = await runCheckpointGit(
    ['ls-tree', '-r', '--name-only', gitHash],
    { store, workTree },
  )
  if (result.ok === false) return null
  return new Set(
    result.stdout.split('\n').filter(line => line.length > 0),
  )
}

/**
 * Use the relative path as the in-state key so persisted snapshots are
 * portable across sessions (and stay short in storage).
 *
 * On Windows the prefix check has to be case-insensitive — a tool can
 * pass `c:\proj\a.ts` while `getOriginalCwd()` is `C:\proj`, and a
 * case-sensitive `startsWith` would record those as two different keys
 * (one absolute, one relative) for the same file. We slice from the raw
 * input by the cwd's length so the returned relative path keeps the
 * tool's original casing.
 */
function maybeShortenFilePath(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath
  const cwd = getOriginalCwd()
  const prefixMatches =
    process.platform === 'win32'
      ? filePath.slice(0, cwd.length).toLowerCase() === cwd.toLowerCase()
      : filePath.startsWith(cwd)
  if (prefixMatches) return relative(cwd, filePath)
  return filePath
}

function maybeExpandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) return filePath
  return join(getOriginalCwd(), filePath)
}

/** Git stores paths with `/` separators on every platform. */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/')
}
