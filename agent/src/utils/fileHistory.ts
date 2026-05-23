/**
 * fileHistory — turn-keyed snapshot/rewind built on the Checkpoints
 * shadow-git store.
 *
 * Public API surface (call sites in REPL, QueryEngine, Tools, etc.):
 *   - fileHistoryEnabled
 *   - fileHistoryTrackEdit             register a path so rewind covers it
 *   - fileHistoryMakeSnapshot          commit the workdir to the shared store
 *   - fileHistoryRewind                restore tracked paths to a prior turn
 *   - fileHistoryGetDiffVsDisk         insertions/deletions vs current workdir
 *   - fileHistoryHasDiffVsDisk         boolean version of the above
 *   - fileHistoryRestoreStateFromLog   resume support
 *   - resetFileHistoryDraft            /clear hook — drop turn-local draft
 *
 * Storage model: each turn produces ONE commit in the shared shadow store
 * at `~/.axiomate/checkpoints/store/`, keyed by the per-project ref. The
 * commit captures the full workdir (minus DEFAULT_EXCLUDES). Rewind
 * restores the workdir to match the target snapshot's tree exactly.
 *
 * Source of truth (Phase 1 of disk-as-source migration): the per-project
 * git ref is the single source for "what anchors exist". Picker, chooser,
 * and rewind execution all read it via `listCodeAnchors`. There is no
 * in-memory snapshot cache anymore — the previous `state.snapshots[]`
 * silently drifted from disk on `/checkpoints clear`, prune, gc, and was
 * the root cause of "picker shows ghost rows that fail at execution time".
 *
 * The only in-memory residue is `currentTurnDraft` (module-local) — a
 * single-slot record so trackEdit can append `addedTrackedFiles` between
 * the turn's snapshot commit and JSONL persistence. Picker / chooser /
 * rewind do NOT read it.
 */

import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { unlink } from 'fs/promises'
import { isAbsolute, join, relative } from 'path'
import { getOriginalCwd } from '../bootstrap/state.js'
import { createSnapshot } from './checkpoints/createSnapshot.js'
import { runCheckpointGit } from './checkpoints/git.js'
import { listCodeAnchors } from './checkpoints/listCodeAnchors.js'
import { indexPath, normalizePath, projectHash } from './checkpoints/paths.js'
import { rollback } from './checkpoints/rollback.js'
import { ensureStore } from './checkpoints/store.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { isENOENT } from './errors.js'
import { logError } from './log.js'
import { recordFileHistorySnapshot } from './sessionStorage.js'
import type { Message } from '../types/message.js'

export type FileHistorySnapshot = {
  messageId: UUID
  gitHash: string
  /**
   * Paths newly registered as tracked between the prior snapshot and
   * this one. **Delta**, not cumulative — readers fold these
   * chronologically to rebuild `state.trackedFiles`.
   */
  addedTrackedFiles: readonly string[]
  timestamp: Date
  /** Cache of `axiomate:<msgId>:<label>` — source of truth is git. */
  subject?: string
  /** Cache of the user prompt's first ~80 chars — source of truth is git. */
  bodyPreview?: string
}

export type FileHistoryState = {
  /**
   * Set of messageIds for which we've already taken a per-turn snapshot.
   * Used by `maybeSnapshotBeforeToolCall` for per-turn dedup. NOT load-
   * bearing for picker / chooser / rewind — those read git directly.
   */
  snapshotMessageIds: Set<UUID>
  /**
   * Paths edited by axiomate tools during this process lifetime.
   * UI hint only — used by `useLspPluginRecommendation` to spot "first
   * time we touched a .py file" and suggest the relevant LSP plugin.
   * NOT load-bearing for rewind or diff.
   */
  trackedFiles: Set<string>
  /**
   * Activity counter for `useGitDiffStats`. Increments on every snapshot.
   */
  snapshotSequence: number
}

export type DiffStats =
  | { filesChanged?: string[]; insertions: number; deletions: number }
  | undefined

const DIFF_HAS_CHANGES = new Set([0, 1])
const REF_NOT_PRESENT = new Set([128, 129])

export function fileHistoryEnabled(): boolean {
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
    !isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

/**
 * Module-local draft for the current turn's snapshot. Holds the latest
 * snapshot record so `fileHistoryTrackEdit` can append `addedTrackedFiles`
 * and re-persist via the latch protocol below.
 *
 * Single-slot is sufficient: `maybeSnapshotBeforeToolCall` dedups per turn
 * (toolExecution.ts:424), so each turn produces at most one makeSnapshot.
 * trackEdit always fires after that snapshot within the same turn. Turn
 * transitions overwrite the slot via the next makeSnapshot.
 *
 * Picker / chooser / rewind never read this — they read git. The draft
 * exists purely to chain `trackEdit` calls into the JSONL persistence
 * record so resume can rebuild `state.trackedFiles` for the LSP hint.
 */
let currentTurnDraft: FileHistorySnapshot | undefined

/**
 * Reset the module-local draft. Called by `/clear` so a stale draft from
 * the previous conversation can't leak `addedTrackedFiles` into a new one.
 */
export function resetFileHistoryDraft(): void {
  currentTurnDraft = undefined
}

export async function fileHistoryTrackEdit(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  filePath: string,
): Promise<void> {
  if (!fileHistoryEnabled()) return

  const trackingPath = maybeShortenFilePath(filePath)

  let alreadyTracked = false
  updateFileHistoryState(state => {
    if (state.trackedFiles.has(trackingPath)) {
      alreadyTracked = true
      return state
    }
    const trackedFiles = new Set(state.trackedFiles).add(trackingPath)
    return { ...state, trackedFiles }
  })
  if (alreadyTracked) return

  if (
    currentTurnDraft &&
    !currentTurnDraft.addedTrackedFiles.includes(trackingPath)
  ) {
    currentTurnDraft = {
      ...currentTurnDraft,
      addedTrackedFiles: [...currentTurnDraft.addedTrackedFiles, trackingPath],
    }
    scheduleSnapshotPersist(currentTurnDraft)
    logForDebugging(`FileHistory: Tracked file modification for ${filePath}`)
  }
}

/**
 * Coalesce per-trackEdit persistence: a single turn often calls trackEdit
 * many times in rapid succession. Each call would otherwise produce its
 * own jsonl append — but the persisted record is a full snapshot keyed by
 * messageId, and the reader takes the *last* one, so all but the final
 * write are wasted IO. Latch collapses N writes into at most 2 round-trips
 * per turn.
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

export async function fileHistoryMakeSnapshot(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
  label: string = 'file-history',
  promptPreview?: string,
): Promise<void> {
  if (!fileHistoryEnabled()) return

  logForDebugging(`FileHistory: Making snapshot for message ${messageId}`)

  const workdir = getOriginalCwd()
  const result = await createSnapshot(workdir, {
    messageId,
    label,
    bodyText: promptPreview,
  })
  if (result.ok === false) {
    logForDebugging(
      `FileHistory: snapshot skipped for ${messageId} (${result.skipped})`,
    )
    return
  }

  const draft: FileHistorySnapshot = {
    messageId,
    gitHash: result.hash,
    addedTrackedFiles: [],
    timestamp: new Date(),
    subject: `axiomate:${messageId}:${label}`,
    ...(promptPreview ? { bodyPreview: promptPreview } : {}),
  }
  currentTurnDraft = draft

  updateFileHistoryState(state => ({
    ...state,
    snapshotMessageIds: new Set(state.snapshotMessageIds).add(messageId),
    snapshotSequence: (state.snapshotSequence ?? 0) + 1,
  }))

  logForDebugging(
    `FileHistory: [Persist] queue write messageId=${messageId.slice(0, 8)} ` +
      `gitHash=${draft.gitHash.slice(0, 8)}`,
  )
  void recordFileHistorySnapshot(messageId, draft, false)
    .then(() =>
      logForDebugging(
        `FileHistory: [Persist] write OK messageId=${messageId.slice(0, 8)}`,
      ),
    )
    .catch(error => {
      logError(new Error(`FileHistory: Failed to record snapshot: ${error}`))
    })
}

/**
 * Restore the workdir to the snapshot keyed exactly to `messageId`.
 *
 * Resolves messageId → gitHash via `listCodeAnchors` (which reads git
 * directly), so the picker, chooser, and execution all agree on the
 * same set of anchors. Throws if the messageId has no anchor on disk.
 */
export async function fileHistoryRewind(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
  messages: readonly Message[],
): Promise<void> {
  if (!fileHistoryEnabled()) return
  void messages // signature stable for callers; lookup goes through git now

  logForDebugging(`FileHistory: [Rewind] entry messageId=${messageId}`)

  const anchors = await listCodeAnchors(getOriginalCwd(), { withStats: false })
  const target = anchors.find(a => a.messageId === messageId)
  if (!target) {
    logError(new Error(`FileHistory: Snapshot for ${messageId} not found`))
    throw new Error('The selected snapshot was not found')
  }

  logForDebugging(
    `FileHistory: [Rewind] resolved target messageId=${messageId} ` +
      `gitHash=${target.gitHash.slice(0, 8)}`,
  )

  // Pre-rewind safety net (Hermes parity, _take("pre-rollback snapshot")).
  // Synthesize a fresh UUID so the snapshot lands as a new ref tip and
  // surfaces in the picker as an off-branch ↶ row — the user can undo
  // this rewind. Best-effort: if disk is unchanged since the last anchor
  // createSnapshot returns no-changes and the user can recover by
  // rewinding to that prior anchor directly.
  const preRewindMessageId = randomUUID() as UUID
  await fileHistoryMakeSnapshot(
    updateFileHistoryState,
    preRewindMessageId,
    `pre-rewind:${messageId}`,
  )

  await restoreFullWorkdirToSnapshot(getOriginalCwd(), target.gitHash)
  logForDebugging(`FileHistory: [Rewind] Finished rewinding to ${messageId}`)
}

/**
 * Diff between a snapshot tree and the current workdir. Used by chooser
 * preview ("restoring will change +X -Y") and `--print` rewind dry-run.
 *
 * Caller resolves the gitHash via `listCodeAnchors` and passes it in
 * directly. Replaces the deleted state-keyed `fileHistoryGetDiffStats`.
 */
export async function fileHistoryGetDiffVsDisk(
  gitHash: string,
): Promise<DiffStats> {
  if (!fileHistoryEnabled()) return undefined

  const storeResult = await ensureStore()
  if (storeResult.ok === false) {
    return { filesChanged: [], insertions: 0, deletions: 0 }
  }
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  await stageWorkdir(storeResult.store, canonical, indexFile)
  const numstat = await runCheckpointGit(
    ['diff', '--cached', '--numstat', gitHash, '--'],
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

  return {
    filesChanged: filesRel.map(p => maybeExpandFilePath(p)),
    insertions,
    deletions,
  }
}

/**
 * Boolean equivalent of `fileHistoryGetDiffVsDisk` — short-circuits via
 * `git diff --quiet`. Replaces `fileHistoryHasAnyChanges`.
 */
export async function fileHistoryHasDiffVsDisk(
  gitHash: string,
): Promise<boolean> {
  if (!fileHistoryEnabled()) return false

  const storeResult = await ensureStore()
  if (storeResult.ok === false) return false
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  await stageWorkdir(storeResult.store, canonical, indexFile)
  const result = await runCheckpointGit(
    ['diff', '--cached', '--quiet', gitHash, '--'],
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
 * Resume entry: rebuild `trackedFiles` and `snapshotMessageIds` from the
 * persisted snapshot list. Neither is load-bearing for rewind — git is
 * the source of truth — so this fn is purely for resume parity (LSP
 * hint + per-turn dedup gate).
 */
export function fileHistoryRestoreStateFromLog(
  fileHistorySnapshots: FileHistorySnapshot[],
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) return

  const trackedFiles = new Set<string>()
  const snapshotMessageIds = new Set<UUID>()
  for (const snapshot of fileHistorySnapshots) {
    if (typeof snapshot.gitHash !== 'string' || snapshot.gitHash === '') {
      continue
    }
    snapshotMessageIds.add(snapshot.messageId)
    for (const path of snapshot.addedTrackedFiles ?? []) {
      const trackingPath = maybeShortenFilePath(path)
      trackedFiles.add(trackingPath)
    }
  }
  logForDebugging(
    `FileHistory: [Restore] from JSONL: input=${fileHistorySnapshots.length} ` +
      `valid=${snapshotMessageIds.size} trackedFiles=${trackedFiles.size}`,
  )
  onUpdateState({
    snapshotMessageIds,
    trackedFiles,
    snapshotSequence: snapshotMessageIds.size,
  })
}

async function stageWorkdir(
  store: string,
  workTree: string,
  indexFile: string,
): Promise<void> {
  const result = await runCheckpointGit(['add', '-A'], {
    store,
    workTree,
    indexFile,
  })
  if (result.ok === false) {
    logForDebugging(
      `FileHistory: stageWorkdir failed (${result.message}); diff may miss untracked files`,
    )
  }
}

async function restoreFullWorkdirToSnapshot(
  workdir: string,
  gitHash: string,
): Promise<void> {
  const storeResult = await ensureStore()
  if (storeResult.ok === false) {
    throw new Error(`ensureStore: ${storeResult.reason}`)
  }
  const store = storeResult.store
  const canonical = normalizePath(workdir)
  const indexFile = indexPath(projectHash(canonical))

  await stageWorkdir(store, canonical, indexFile)
  const diff = await runCheckpointGit(
    ['diff', '--cached', '--name-only', '--diff-filter=A', gitHash, '--'],
    { store, workTree: canonical, indexFile },
  )
  const addedPaths =
    diff.ok === true
      ? diff.stdout.split('\n').filter(s => s.length > 0)
      : []
  logForDebugging(
    `FileHistory: [Rewind] Phase 1 unlink: ${addedPaths.length} disk-but-not-in-tree paths ` +
      `(gitHash=${gitHash.slice(0, 8)} workdir=${canonical})`,
  )
  if (diff.ok === true) {
    for (const rel of addedPaths) {
      const abs = maybeExpandFilePath(rel)
      try {
        await unlink(abs)
        logForDebugging(`FileHistory: [Rewind] Deleted ${abs}`)
      } catch (err: unknown) {
        if (!isENOENT(err)) logError(err)
      }
    }
  }

  const targetTree = await runCheckpointGit(
    ['ls-tree', '--name-only', gitHash],
    { store, workTree: canonical, indexFile },
  )
  const targetIsEmpty =
    targetTree.ok === true && targetTree.stdout.trim().length === 0
  if (targetIsEmpty) {
    logForDebugging(
      `FileHistory: [Rewind] Phase 2 skipped (target tree is empty); workdir already cleared`,
    )
    return
  }

  logForDebugging(
    `FileHistory: [Rewind] Phase 2 checkout: gitHash=${gitHash.slice(0, 8)}`,
  )
  const result = await rollback(canonical, gitHash, {
    skipPreRollbackSnapshot: true,
  })
  if (result.ok === false) {
    throw new Error(`rollback: ${result.reason} ${result.message}`)
  }
  logForDebugging(`FileHistory: [Rewind] Phase 2 checkout complete`)
}

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
