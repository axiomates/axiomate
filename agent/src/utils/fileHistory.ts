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
import { indexPath, normalizePath, projectHash } from './checkpoints/paths.js'
import { rollback } from './checkpoints/rollback.js'
import { ensureStore } from './checkpoints/store.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { isENOENT } from './errors.js'
import { logError } from './log.js'
import { recordFileHistorySnapshot } from './sessionStorage.js'

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
 * No-op kept for backward compatibility with persisted JSONL records.
 * Earlier the module held a turn-local snapshot draft slot so trackEdit
 * could append addedTrackedFiles between makeSnapshot and persistence.
 * Phase 4.5 dropped that path entirely — trackedFiles is populated as
 * a batch in fileHistoryMakeSnapshot from the anchor's filesChanged.
 * Older sessions may still call this on /clear; safe to leave a stub.
 */
export function resetFileHistoryDraft(): void {
  // intentional no-op
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

  // Batch-populate trackedFiles from the anchor we just wrote. Earlier
  // each tool called fileHistoryTrackEdit per file, but trackedFiles is
  // only consumed by useLspPluginRecommendation (the LSP plugin hint
  // hook) — Phase 1 deleted every other consumer. The hook just wants
  // "what files has axiomate touched in this session?" and the per-
  // anchor diff vs the previous anchor is exactly that signal,
  // computed in one git invocation regardless of how many files
  // changed. Falls back gracefully if the diff-tree call fails: the
  // snapshot itself already landed; trackedFiles can stay stale.
  let addedTrackedFiles: string[] = []
  try {
    addedTrackedFiles = await diffPathsAgainstParent(workdir, result.hash)
  } catch (error) {
    logError(new Error(`FileHistory: trackedFiles diff failed: ${error}`))
  }

  updateFileHistoryState(state => {
    const trackedFiles = new Set(state.trackedFiles)
    for (const p of addedTrackedFiles) {
      trackedFiles.add(maybeShortenFilePath(p))
    }
    return {
      ...state,
      trackedFiles,
      snapshotMessageIds: new Set(state.snapshotMessageIds).add(messageId),
      snapshotSequence: (state.snapshotSequence ?? 0) + 1,
    }
  })

  logForDebugging(
    `FileHistory: [Persist] queue write messageId=${messageId.slice(0, 8)} ` +
      `gitHash=${result.hash.slice(0, 8)} addedTrackedFiles=${addedTrackedFiles.length}`,
  )
  const draft: FileHistorySnapshot = {
    messageId,
    gitHash: result.hash,
    addedTrackedFiles,
    timestamp: new Date(),
    subject: `axiomate:${messageId}:${label}`,
    ...(promptPreview ? { bodyPreview: promptPreview } : {}),
  }
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
 * One-shot diff: list paths changed by `gitHash` versus its parent.
 * For root commits (no parent) this returns the full tree contents.
 * Best-effort — failures are surfaced to the caller as exceptions and
 * handled there; no fallback here.
 */
async function diffPathsAgainstParent(
  workdir: string,
  gitHash: string,
): Promise<string[]> {
  const storeResult = await ensureStore()
  if (storeResult.ok === false) return []
  const canonical = normalizePath(workdir)
  const r = await runCheckpointGit(
    ['log', '-1', '--name-only', '--pretty=format:', '--root', gitHash],
    {
      store: storeResult.store,
      workTree: canonical,
      indexFile: indexPath(projectHash(canonical)),
    },
  )
  if (r.ok === false) return []
  return r.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * Restore the workdir to the snapshot at `gitHash`.
 *
 * Caller is responsible for resolving messageId → gitHash via
 * `listCodeAnchors` (or carrying the hash from picker render time).
 * Phase 3 simplified the signature: the previous form took messageId
 * and re-resolved internally, but every call site already has the
 * hash available — passing it through removes a redundant git spawn
 * on every rewind and makes the function's atomicity boundary
 * obvious.
 */
export async function fileHistoryRewind(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  gitHash: string,
): Promise<void> {
  if (!fileHistoryEnabled()) return

  logForDebugging(`FileHistory: [Rewind] entry gitHash=${gitHash.slice(0, 8)}`)

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
    `pre-rewind:${gitHash.slice(0, 8)}`,
  )

  await restoreFullWorkdirToSnapshot(getOriginalCwd(), gitHash)
  logForDebugging(
    `FileHistory: [Rewind] Finished rewinding to ${gitHash.slice(0, 8)}`,
  )
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
 * Bulk version of `fileHistoryGetDiffVsDisk`. Picker-row stats answer
 * "if I rewind to anchor X, how many lines change on disk?" — the same
 * question the chooser preview answers for the selected row. Sharing
 * the same git query means picker and chooser line counts match by
 * construction; no more "picker says +1 -0, chooser says +1 -1".
 *
 * Implementation: stage the workdir once into a temp index file
 * (write-tree captures the current disk state as an immutable tree
 * object), then run one `git diff-tree --numstat <anchor> <diskTree>`
 * per anchor in parallel. diff-tree is index-free so the parallel
 * reads can't race each other or the rest of the system. ~80ms for 20
 * anchors on Windows.
 *
 * Returns a Map keyed by gitHash. Anchors that fail their diff-tree
 * call get omitted (caller falls back to "stats unavailable" UI). The
 * function never throws — checkpoints subsystem is best-effort.
 */
export async function fileHistoryBulkDiffVsDisk(
  gitHashes: readonly string[],
): Promise<Map<string, DiffStats>> {
  const out = new Map<string, DiffStats>()
  if (!fileHistoryEnabled() || gitHashes.length === 0) return out

  const storeResult = await ensureStore()
  if (storeResult.ok === false) return out
  const store = storeResult.store
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  await stageWorkdir(store, canonical, indexFile)

  // Lock disk state into an immutable tree. Subsequent diff-tree calls
  // read this tree object, not the index, so they're safe to parallelize
  // and free of any further `git add` race.
  const wt = await runCheckpointGit(['write-tree'], {
    store,
    workTree: canonical,
    indexFile,
  })
  if (wt.ok === false) return out
  const diskTree = wt.stdout.trim()
  if (diskTree.length === 0) return out

  // Serial loop instead of Promise.all: parallel git children sharing
  // the same indexFile + store directory race in subtle ways on
  // Windows (output of all-but-the-last call comes back empty even
  // though each call's args are correct individually). Serial keeps
  // one git process at a time and is still fast (~5ms per spawn × N
  // anchors); for typical N <= 30 the total is well under the
  // ~150ms picker-mount budget.
  for (const hash of gitHashes) {
    const r = await runCheckpointGit(
      ['diff-tree', '--numstat', '-r', hash, diskTree, '--'],
      {
        store,
        workTree: canonical,
        indexFile,
      },
    )
    if (r.ok === false) {
      logForDebugging(
        `FileHistory: [BulkDiff] diff-tree failed hash=${hash.slice(0, 8)}: ${r.message}`,
      )
      continue
    }
    const filesRel: string[] = []
    let insertions = 0
    let deletions = 0
    for (const line of r.stdout.split('\n')) {
      if (line.length === 0) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const [insStr, delStr, path] = parts as [string, string, string]
      filesRel.push(path)
      if (insStr !== '-') insertions += Number.parseInt(insStr, 10) || 0
      if (delStr !== '-') deletions += Number.parseInt(delStr, 10) || 0
    }
    out.set(hash, {
      filesChanged: filesRel.map(p => maybeExpandFilePath(p)),
      insertions,
      deletions,
    })
  }
  return out
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
