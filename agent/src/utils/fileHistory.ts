/**
 * fileHistory — turn-keyed snapshot/rewind built on the Checkpoints
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
 * Persisted-snapshot schema: `{ messageId, gitHash, addedTrackedFiles,
 * timestamp }`. `addedTrackedFiles` is the **delta** — only paths newly
 * registered between the previous snapshot and this one (or trackEdits
 * since this snapshot was committed, see scheduleSnapshotPersist below).
 * `fileHistoryRestoreStateFromLog` folds these in chronological order to
 * rebuild `state.trackedFiles`. Disk usage is O(M) total (each path
 * recorded exactly once).
 *
 * Updater protocol: every API takes `updateFileHistoryState`, a
 * synchronous setState-style dispatcher. Several functions here read
 * the current state by passing an identity updater
 * (`updateFileHistoryState(s => { captured = s; return s })`); this
 * relies on the dispatcher invoking the reducer synchronously. All
 * current consumers (REPL useState, SDK in-memory state) satisfy that.
 * If a future state layer becomes async, switch to a separate read API
 * rather than racing on `captured`.
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
   * Paths newly registered as tracked between the prior snapshot (or
   * session start) and this one. **Delta**, not cumulative — readers
   * fold these chronologically to rebuild `state.trackedFiles`. trackEdit
   * calls that arrive after this snapshot was committed append to this
   * array (and re-persist via the coalescing latch).
   */
  addedTrackedFiles: readonly string[]
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
 * BEFORE editing the file.
 *
 * Content is captured by the per-turn shadow-git snapshot, so trackEdit
 * only mutates state — no per-edit IO. That's also why there's no
 * messageId arg: trackEdit is not the snapshot key.
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
    if (last && !last.addedTrackedFiles.includes(trackingPath)) {
      const updated: FileHistorySnapshot = {
        ...last,
        addedTrackedFiles: [...last.addedTrackedFiles, trackingPath],
      }
      updatedSnapshot = updated
      snapshots = state.snapshots.slice()
      snapshots[snapshots.length - 1] = updated
    }
    return { ...state, trackedFiles, snapshots }
  })

  if (updatedSnapshot) {
    scheduleSnapshotPersist(updatedSnapshot)
    logForDebugging(`FileHistory: Tracked file modification for ${filePath}`)
  }
}

/**
 * Coalesce per-trackEdit persistence: a single turn often calls trackEdit
 * many times in rapid succession (one per file the tool will edit). Each
 * call would otherwise produce its own jsonl append — but the persisted
 * record is a full snapshot keyed by messageId, and the reader takes the
 * *last* one (`fileHistorySnapshots.set(messageId, entry)` at
 * sessionStorage.ts:3269), so all but the final write are wasted IO.
 *
 * We keep a per-messageId latest-pending entry and at most one in-flight
 * write per messageId. When the in-flight write resolves, if a newer
 * entry showed up while it was running, we kick off one more — this
 * collapses N writes into at most 2 round-trips per turn (instead of N).
 */
const pendingSnapshotPersists = new Map<UUID, FileHistorySnapshot>()
const inFlightSnapshotPersists = new Set<UUID>()

function scheduleSnapshotPersist(snapshot: FileHistorySnapshot): void {
  pendingSnapshotPersists.set(snapshot.messageId, snapshot)
  if (inFlightSnapshotPersists.has(snapshot.messageId)) return
  void drainSnapshotPersist(snapshot.messageId)
}

async function drainSnapshotPersist(messageId: UUID): Promise<void> {
  inFlightSnapshotPersists.add(messageId)
  try {
    while (pendingSnapshotPersists.has(messageId)) {
      const next = pendingSnapshotPersists.get(messageId)!
      pendingSnapshotPersists.delete(messageId)
      try {
        await recordFileHistorySnapshot(messageId, next, true)
      } catch (error) {
        logError(new Error(`FileHistory: Failed to record snapshot: ${error}`))
      }
    }
  } finally {
    inFlightSnapshotPersists.delete(messageId)
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
      // Empty at emit time: makeSnapshot fires at turn start, before any
      // trackEdit. trackEdit calls during the turn append to this snapshot's
      // addedTrackedFiles. The fold-on-read invariant
      //   union(snapshots[].addedTrackedFiles) === state.trackedFiles
      // is what lets us store O(M) total instead of O(K×M).
      addedTrackedFiles: [],
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

  // One diff invocation: --numstat gives `<ins>\t<del>\t<path>` per file
  // (or `-\t-\t<path>` for binary). The per-project GIT_INDEX_FILE is
  // required even for worktree-vs-commit diff: the shared bare store
  // would otherwise reuse `$GIT_DIR/index` left over from a previous
  // project, producing stale diffs.
  const numstat = await runCheckpointGit(
    ['diff', '--numstat', target.gitHash, '--', ...paths],
    {
      store: storeResult.store,
      workTree: canonical,
      indexFile,
      allowedExitCodes: REF_NOT_PRESENT,
    },
  )
  const filesRel: string[] = []
  let insertions = 0
  let deletions = 0
  if (numstat.ok) {
    for (const line of numstat.stdout.split('\n')) {
      if (line.length === 0) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const [insStr, delStr, path] = parts as [string, string, string]
      filesRel.push(path)
      if (insStr !== '-') insertions += Number.parseInt(insStr, 10) || 0
      if (delStr !== '-') deletions += Number.parseInt(delStr, 10) || 0
    }
  }
  const allChangedRel = new Set([...filesRel, ...flipped])

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
  // covers both so neither path becomes a transient-error miss. The
  // per-project GIT_INDEX_FILE matters even for worktree-vs-commit diff:
  // without it, the shared bare store would reuse a stale index left by
  // a prior project, producing wrong answers.
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
 * snapshot's `addedTrackedFiles` is unioned into `state.trackedFiles` so
 * rewind blast-radius matches the pre-resume session — chronological
 * fold over the deltas.
 *
 * The persisted log is append-only and can outgrow the in-memory ring
 * buffer (a long-running session that resumes repeatedly). We mirror the
 * `fileHistoryMakeSnapshot` cap here: keep only the most recent
 * MAX_SNAPSHOTS, but fold the *whole* persisted log's addedTrackedFiles
 * because rewind blast-radius is cumulative — a file the user wants to
 * rewind to a kept snapshot must still be in trackedFiles even if the
 * snapshot that first registered it has aged out of the in-memory ring.
 */
export function fileHistoryRestoreStateFromLog(
  fileHistorySnapshots: FileHistorySnapshot[],
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) return

  const trackedFiles = new Set<string>()
  const snapshots: FileHistorySnapshot[] = []
  for (const snapshot of fileHistorySnapshots) {
    // Defense: a malformed entry without `gitHash` would crash rewind at
    // `restoreTrackedToSnapshot` (calls `git ls-tree undefined`). Skip it
    // so resume still succeeds; the malformed turn is simply not rewindable.
    if (typeof snapshot.gitHash !== 'string' || snapshot.gitHash === '') {
      continue
    }
    const addedList: string[] = []
    for (const path of snapshot.addedTrackedFiles ?? []) {
      const trackingPath = maybeShortenFilePath(path)
      if (trackedFiles.has(trackingPath)) continue
      trackedFiles.add(trackingPath)
      addedList.push(trackingPath)
    }
    snapshots.push({ ...snapshot, addedTrackedFiles: addedList })
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
