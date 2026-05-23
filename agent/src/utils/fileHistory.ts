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
 * commit captures the full workdir (minus DEFAULT_EXCLUDES). Rewind
 * restores the workdir to match the target snapshot's tree exactly:
 * files in the snapshot are checked out, files on disk but not in the
 * tree are deleted. Manual edits that fall outside the snapshot are
 * overwritten — to make this safe, `fileHistoryRewind` automatically
 * takes a `pre-rewind:<targetMsgId>` safety snapshot before restoring,
 * so any rewind is itself rewindable. See `fileHistoryRewind` and
 * `__tests__/fileHistory.test.ts`.
 *
 * Persisted-snapshot schema: `{ messageId, gitHash, addedTrackedFiles,
 * timestamp }`. `addedTrackedFiles` is the **delta** — only paths newly
 * registered between the previous snapshot and this one (or trackEdits
 * since this snapshot was committed, see scheduleSnapshotPersist below).
 * `fileHistoryRestoreStateFromLog` folds these in chronological order to
 * rebuild `state.trackedFiles` for the LSP-recommendation UI hint.
 * Disk usage is O(M) total (each path recorded exactly once).
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
import { randomUUID } from 'crypto'
import { unlink } from 'fs/promises'
import { isAbsolute, join, relative } from 'path'
import {
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
import type { Message } from '../types/message.js'

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
  /**
   * Cache of the commit subject (`axiomate:<msgId>:<label>`) so the picker
   * can distinguish synthetic-anchor types without re-reading git on
   * every render. Populated when the snapshot is created in-process
   * (writer side) and on resume (reader side via batch git log; see
   * sessionStorage's buildFileHistorySnapshotChain).
   *
   * Source of truth is the commit message in git; this field is just a
   * cache. Optional because legacy JSONL records don't have it — the
   * picker falls back to the timestamp-only label format when missing.
   */
  subject?: string
  /**
   * Cache of the commit body — typically the user prompt's first ~80
   * chars. Lets the picker show abandoned-fork rows as "↶ <prompt>"
   * instead of a generic timestamp. Same caching rationale as `subject`;
   * source of truth is git. Optional — pre-rewind safety nets and
   * legacy snapshots have no body.
   */
  bodyPreview?: string
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  /**
   * Paths edited by axiomate tools during this process lifetime.
   *
   * UI hint only — NOT load-bearing for rewind or diff. Rewind operates
   * on git's full disk-vs-tree diff (Hermes-model). Used by
   * `useLspPluginRecommendation` to spot "first time we touched a .py
   * file" and suggest the relevant LSP plugin. Empty after restart;
   * `restoreStateFromLog` repopulates from JSONL on `/resume` for
   * parity, but no git op consults it.
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

/**
 * Single gate for both REPL and --print/headless. Upstream Claude Code
 * had a separate SDK branch that required CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1
 * — sensible for an SDK whose users are mostly CI/automation that doesn't
 * want a shadow store growing on disk. Axiomate's policy is the opposite:
 * checkpoints are a user-facing safety net, default-on everywhere, and the
 * only switches are `fileCheckpointingEnabled` (config) plus
 * AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING (env kill-switch).
 */
export function fileHistoryEnabled(): boolean {
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
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
 * before a mutating tool runs (Edit/Write/destructive Bash/etc.), so the
 * commit captures the *pre-mutation* state — that's what /rewind needs.
 *
 * No-ops when nothing changed since the previous snapshot: createSnapshot
 * returns `{ skipped: 'no-changes' }` and we record nothing. This is fine
 * because rewind targets fall back to the closest preceding snapshot.
 */
export async function fileHistoryMakeSnapshot(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
  label: string = 'file-history',
  promptPreview?: string,
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
      // Cache the commit subject we just wrote so the picker doesn't
      // need to re-read git for in-session anchors. The wire format is
      // `axiomate:<msgId>:<label>` — match what formatCommitSubject in
      // checkpoints/reason.ts produces.
      subject: `axiomate:${messageId}:${label}`,
      ...(promptPreview ? { bodyPreview: promptPreview } : {}),
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
    logForDebugging(
      `FileHistory: [Persist] queue write messageId=${messageId.slice(0, 8)} ` +
        `gitHash=${committed.gitHash.slice(0, 8)} addedTrackedFiles=${committed.addedTrackedFiles.length}`,
    )
    void recordFileHistorySnapshot(messageId, committed, false)
      .then(() =>
        logForDebugging(
          `FileHistory: [Persist] write OK messageId=${messageId.slice(0, 8)}`,
        ),
      )
      .catch(error => {
        logError(
          new Error(`FileHistory: Failed to record snapshot: ${error}`),
        )
      })
    logForDebugging(
      `FileHistory: Added snapshot for ${messageId}, tracking ${captured.trackedFiles.size} files`,
    )
  }
}

/**
 * Strict snapshot lookup — returns the snapshot keyed exactly to
 * `targetMessageId`, or undefined.
 *
 * Used by rewind execution and the chooser's diff calculation. The
 * picker's ⚠ badge uses `fileHistoryHasExactSnapshot` (same predicate);
 * keeping the chooser/rewind path strict means picker visuals always
 * match what the chooser will offer — no "looks like ⚠ but the chooser
 * still has Restore code" surprises.
 *
 * Handles the synthetic-UUID case (pre-rewind safety anchors) — those
 * UUIDs aren't in conversation `messages` but DO have a snapshot in
 * state, and this lookup finds them by id alone.
 */
function findExactSnapshot(
  state: FileHistoryState,
  targetMessageId: UUID,
): FileHistorySnapshot | undefined {
  return state.snapshots.findLast(s => s.messageId === targetMessageId)
}

/**
 * Walk back from `targetMessageId`'s position in `messages` to find
 * the closest snapshot at-or-before it. Returns undefined if none.
 *
 * Used ONLY by `fileHistoryHasAnyChanges` — that predicate asks
 * "since the most recent anchor, has the disk changed?", which is
 * the one place where ancestor fallback is the right semantic.
 *
 * Do NOT use for rewind execution or chooser diff: those must agree
 * with the picker's ⚠ badge, which is strict-anchor only.
 */
function findNearestPriorSnapshot(
  state: FileHistoryState,
  targetMessageId: UUID,
  messages: readonly Message[],
): FileHistorySnapshot | undefined {
  const targetIdx = messages.findIndex(m => m.uuid === targetMessageId)
  if (targetIdx < 0) return findExactSnapshot(state, targetMessageId)
  for (let i = state.snapshots.length - 1; i >= 0; i--) {
    const snap = state.snapshots[i]!
    const snapIdx = messages.findIndex(m => m.uuid === snap.messageId)
    if (snapIdx >= 0 && snapIdx <= targetIdx) return snap
  }
  return undefined
}

/**
 * Restore the workdir to the snapshot keyed exactly to `messageId`.
 * Strict-anchor only — picker / chooser have already gated on
 * `fileHistoryCanRestore` (also strict), so any messageId that reaches
 * this function should have a matching snapshot. Throws if not.
 */
export async function fileHistoryRewind(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
  messages: readonly Message[],
): Promise<void> {
  if (!fileHistoryEnabled()) return

  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  logForDebugging(
    `FileHistory: [Rewind] entry messageId=${messageId} state.snapshots.length=${captured.snapshots.length} ` +
      `messages.length=${messages.length}`,
  )

  const target = findExactSnapshot(captured, messageId)
  if (!target) {
    logError(new Error(`FileHistory: Snapshot for ${messageId} not found`))
    throw new Error('The selected snapshot was not found')
  }

  logForDebugging(
    `FileHistory: [Rewind] resolved target messageId=${target.messageId} gitHash=${target.gitHash.slice(0, 8)} ` +
      `(input messageId ${messageId})`,
  )

  // Pre-rewind safety net (Hermes parity, _take("pre-rollback snapshot")).
  // We synthesize a fresh UUID so the snapshot lands in state.snapshots
  // and shows up in the rewind picker as a real anchor — the user can
  // open /rewind, find this row, and undo this rewind. The rollback
  // step below uses skipPreRollbackSnapshot:true to avoid double-snapping.
  // Best-effort: makeSnapshot may skip if workdir is unchanged since the
  // last snapshot, in which case the user can recover by rewinding to
  // that prior snapshot directly. Failure here never blocks the rewind.
  const preRewindMessageId = randomUUID() as UUID
  await fileHistoryMakeSnapshot(
    updateFileHistoryState,
    preRewindMessageId,
    `pre-rewind:${target.messageId}`,
  )

  await restoreFullWorkdirToSnapshot(getOriginalCwd(), target.gitHash)
  logForDebugging(`FileHistory: [Rewind] Finished rewinding to ${messageId}`)
}

/**
 * True when this `messageId` has a code-restore anchor.
 *
 * Strict-anchor only — match the picker's ⚠ badge predicate. A
 * readonly turn returns false here, the chooser hides Restore code,
 * and rewind execution never receives the messageId. All three
 * surfaces agree on the same predicate.
 *
 * Equivalent to `fileHistoryHasExactSnapshot` modulo the
 * `fileHistoryEnabled()` short-circuit; kept as a separate name so
 * callers' intent is self-documenting (canRestore = "would rewind
 * to this turn produce a meaningful code change?").
 */
export function fileHistoryCanRestore(
  state: FileHistoryState,
  messageId: UUID,
  messages: readonly Message[],
): boolean {
  if (!fileHistoryEnabled()) return false
  void messages // signature stable for callers; no longer read
  return findExactSnapshot(state, messageId) !== undefined
}

/**
 * Strict variant of `fileHistoryCanRestore`: returns true only when
 * `messageId` is itself the key of a snapshot — i.e. the AI ran an
 * Edit/Write/NotebookEdit during this exact turn.
 *
 * Use this for "is this turn a code-restore anchor?" UI questions
 * (the rewind picker's default view). Do NOT use for actual rewind
 * gating — `fileHistoryCanRestore` walks back to the closest ancestor
 * snapshot, which is the correct semantics for "rewind code to this
 * point in conversation" even on read-only turns.
 */
export function fileHistoryHasExactSnapshot(
  state: FileHistoryState,
  messageId: UUID,
): boolean {
  if (!fileHistoryEnabled()) return false
  return state.snapshots.some(s => s.messageId === messageId)
}

export async function fileHistoryGetDiffStats(
  state: FileHistoryState,
  messageId: UUID,
  messages: readonly Message[],
): Promise<DiffStats> {
  if (!fileHistoryEnabled()) return undefined
  // Strict-anchor only — agrees with the picker's ⚠ badge. A turn
  // without its own snapshot returns undefined here, the chooser hides
  // Restore code, and the picker's ⚠ on the same row matches. Three
  // surfaces, one predicate (`findExactSnapshot`), no surprises.
  void messages // signature stable; no longer needed for ancestor walk
  const target = findExactSnapshot(state, messageId)
  if (!target) {
    logForDebugging(
      `FileHistory: [GetDiff] uuid=${messageId.slice(0, 8)} → no exact snapshot, undefined`,
    )
    return undefined
  }
  logForDebugging(
    `FileHistory: [GetDiff] uuid=${messageId.slice(0, 8)} target=${target.gitHash.slice(0, 8)}`,
  )

  const storeResult = await ensureStore()
  if (storeResult.ok === false) {
    logForDebugging(
      `FileHistory: [GetDiff] uuid=${messageId.slice(0, 8)} ensureStore failed → empty diff`,
    )
    return { filesChanged: [], insertions: 0, deletions: 0 }
  }
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  // Hermes-model: report git's full disk-vs-tree diff. The picker /
  // chooser uses this to decide whether to offer "Restore code" — it
  // must see all changes that rewind would touch, not just paths
  // axiomate edited this session. (state.trackedFiles used to gate
  // this and was load-bearing for the chooser; restart-fresh emptied
  // it and silently disabled code-restore. Removed.)
  //
  // Stage the workdir into the project's private index first so
  // `git diff --cached` sees untracked files too. Without this, a file
  // created by the user (or by a tool that bypassed trackEdit) since
  // the snapshot wouldn't show up — but rewind would still delete it
  // (the unlink pass in restoreFullWorkdirToSnapshot picks it up via
  // --diff-filter=A), so the chooser must surface it.
  await stageWorkdir(storeResult.store, canonical, indexFile)
  const numstat = await runCheckpointGit(
    ['diff', '--cached', '--numstat', target.gitHash, '--'],
    {
      store: storeResult.store,
      workTree: canonical,
      indexFile,
      allowedExitCodes: REF_NOT_PRESENT,
    },
  )
  if (numstat.ok === false) {
    logForDebugging(
      `FileHistory: [GetDiff] uuid=${messageId.slice(0, 8)} target=${target.gitHash.slice(0, 8)} ` +
        `numstat FAILED ok=false (renders as no-diff)`,
    )
  }
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

  logForDebugging(
    `FileHistory: [GetDiff] uuid=${messageId.slice(0, 8)} target=${target.gitHash.slice(0, 8)} ` +
      `→ files=${filesRel.length} ins=${insertions} del=${deletions} numstat.ok=${numstat.ok}`,
  )

  return {
    filesChanged: filesRel.map(p => maybeExpandFilePath(p)),
    insertions,
    deletions,
  }
}

/**
 * Boolean equivalent of `fileHistoryGetDiffStats` — short-circuits via
 * `git diff --quiet` so the dominant cost (counting lines) is skipped.
 *
 * Hermes-model: looks at the full disk-vs-tree diff. trackedFiles used
 * to gate this; restart-fresh emptied it and made the predicate
 * permanently false. Removed.
 */
export async function fileHistoryHasAnyChanges(
  state: FileHistoryState,
  messageId: UUID,
  messages: readonly Message[],
): Promise<boolean> {
  if (!fileHistoryEnabled()) return false
  // Ancestor fallback IS the right semantic here — "has anything
  // changed since the most recent anchor relevant to this turn"
  // explicitly wants the closest preceding snapshot.
  const target = findNearestPriorSnapshot(state, messageId, messages)
  if (!target) return false

  const storeResult = await ensureStore()
  if (storeResult.ok === false) return false
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  // diff --cached against the snapshot tree: stage-then-compare so
  // untracked files (created since snapshot) are counted as changes.
  // diff --quiet exits 0 if no changes, 1 if changes. allowedExitCodes
  // covers both so neither path becomes a transient-error miss. The
  // per-project GIT_INDEX_FILE matters even for worktree-vs-commit diff:
  // without it, the shared bare store would reuse a stale index left by
  // a prior project, producing wrong answers.
  await stageWorkdir(storeResult.store, canonical, indexFile)
  const result = await runCheckpointGit(
    ['diff', '--cached', '--quiet', target.gitHash, '--'],
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
 * snapshot's `addedTrackedFiles` is unioned into `state.trackedFiles`
 * for the LSP-plugin-recommendation UI hint; not load-bearing for
 * rewind — rewind walks the ref directly.
 *
 * The persisted log is append-only and can outgrow the in-memory ring
 * buffer (a long-running session that resumes repeatedly). We mirror the
 * `fileHistoryMakeSnapshot` cap here: keep only the most recent
 * MAX_SNAPSHOTS, but fold the *whole* persisted log's addedTrackedFiles
 * so the LSP hook sees the full set of paths axiomate has touched
 * across resumes.
 */
export function fileHistoryRestoreStateFromLog(
  fileHistorySnapshots: FileHistorySnapshot[],
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) return

  const trackedFiles = new Set<string>()
  const snapshots: FileHistorySnapshot[] = []
  for (const snapshot of fileHistorySnapshots) {
    // Defense: a malformed entry without `gitHash` would crash rewind
    // when `restoreFullWorkdirToSnapshot` runs `git ls-tree undefined`.
    // Skip it so resume still succeeds; the malformed turn is simply
    // not rewindable.
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
  logForDebugging(
    `FileHistory: [Restore] from JSONL: input=${fileHistorySnapshots.length} valid=${snapshots.length} trimmed=${trimmed.length} trackedFiles=${trackedFiles.size} ` +
      `messageIds=[${trimmed.map(s => s.messageId.slice(0, 8)).join(',')}]`,
  )
  onUpdateState({
    snapshots: trimmed,
    trackedFiles,
    snapshotSequence: snapshots.length,
  })
}

/**
 * Restore the entire workdir to a snapshot commit (Hermes model).
 *
 * Two-phase:
 *   1. `git diff --name-only --diff-filter=A <hash>` lists paths that
 *      exist on disk but NOT in the target tree. We unlink them so
 *      "rewind to a turn where this file did not exist" actually
 *      removes the file. (Plain `git checkout <hash> -- .` would
 *      leave them on disk — Hermes' literal behavior. axiomate goes
 *      one step further so the post-rewind workdir == snapshot tree.)
 *   2. `rollback` runs `git checkout <hash> -- .` and skips its own
 *      pre-rollback snapshot (the caller, `fileHistoryRewind`, has
 *      already taken one at the high level).
 *
 * Replaced `restoreTrackedToSnapshot`: that one read `state.trackedFiles`
 * to limit blast radius, but trackedFiles was a per-process in-memory
 * Set with no persistence — restart-fresh emptied it and silently
 * disabled rewind. Pre-rewind safety snapshot replaces blast-radius
 * limiting as the recoverability mechanism.
 */
/**
 * `git add -A` into the project's per-project index. Used by
 * `getDiffStats` and `hasAnyChanges` so `git diff --cached <hash>`
 * sees untracked files as "added since target snapshot." Idempotent
 * and best-effort — failures are logged but don't propagate, since
 * the diff/has-changes callers prefer "false negative" over a hard
 * fail.
 *
 * Mirrors createSnapshot's stage step but without the size cap or
 * reset — we don't write a commit here, just want the index to
 * reflect the current workdir for diff comparison.
 */
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

  // Phase 1: unlink files that are on disk but not in the target tree.
  // Stage the workdir first so untracked files are visible to git diff;
  // without staging, `git diff <hash>` ignores them entirely.
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

  // Phase 2: checkout — but skip when the target tree is empty.
  // `git checkout <empty-tree-commit> -- .` exits 1 because there are
  // zero matching paths. The Phase 1 unlink already emptied the workdir
  // for this case, so we don't need to do anything more.
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

  // Skip pre-rollback snapshot — fileHistoryRewind already took one at
  // the high level so it lands in state.snapshots.
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
