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
 * commit captures the full workdir as a filesystem snapshot, excluding
 * VCS metadata, tiny defaults, and paths ignored by the user's `.gitignore`.
 * Rewind restores the workdir to match the target snapshot's tree exactly.
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
import { mkdtemp, rm, rmdir, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, relative } from 'path'
import { getOriginalCwd } from '../bootstrap/state.js'
import {
  createSnapshot,
  createSnapshotFromTree,
  MAX_FILE_SIZE_MB,
  prepareSnapshotTree,
} from './checkpoints/createSnapshot.js'
import {
  logCheckpointDiagnostic,
  quoteDiagnostic,
} from './checkpoints/diagnostics.js'
import { dropOversizeFromIndex } from './checkpoints/dropOversizeFromIndex.js'
import { runCheckpointGit } from './checkpoints/git.js'
import { indexPath, normalizePath, projectHash, refName } from './checkpoints/paths.js'
import {
  classifyAnchor,
  formatCommitBody,
  formatCommitSubject,
  LABEL_PRE_REWIND,
  parseCommitBody,
  parseCommitSubject,
} from './checkpoints/reason.js'
import { stageWorktreeSnapshotIndex } from './checkpoints/snapshotIndex.js'
import { ensureStore } from './checkpoints/store.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { isENOENT } from './errors.js'
import { logError } from './log.js'
import {
  readNulPathspecFile,
  streamGitPathspecFromDiff,
} from './fileHistoryRewindPathspec.js'
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
   * Set of messageIds for which we've already attempted a per-turn snapshot.
   * Used by `maybeSnapshotBeforeToolCall` for per-turn dedup. A no-changes
   * pre-tool attempt still counts: Hermes marks the directory as checkpointed
   * before `_take`, so later mutating-looking tools in the same turn must not
   * create a post-change anchor under the same prompt.
   */
  snapshotMessageIds: Set<UUID>
  /**
   * Optional labels for hash-keyed file rewind rows. The file tab's primary
   * key is the checkpoint hash; message IDs only label that hash row.
   */
  checkpointLabelsByHash: Map<string, CheckpointHashLabel>
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

export type CheckpointHashLabel = {
  messageId: UUID
  preview?: string
  timestamp: Date
}

export type RewindCodeRowKind = 'turn' | 'hash-label' | 'pre-rewind'

export type RewindCodeRow = {
  rowId: string
  kind: RewindCodeRowKind
  restoreHash: string
  labelMessageId?: UUID
  labelPreview?: string
  labelText: string
  timestamp: Date
  diffStats: Exclude<DiffStats, undefined>
  isSynthetic: boolean
}

const DIFF_HAS_CHANGES = new Set([0, 1])
const REF_NOT_PRESENT = new Set([128, 129])
const REWIND_PATHSPEC_PREFIX = 'axiomate-rewind-'

type RewindExecutionPlan = {
  store: string
  workdir: string
  indexFile: string
  targetHash: string
  currentTree: string
  tempDir: string
  checkoutPathspecFile: string
  deletePathspecFile: string
  checkoutCount: number
  deleteCount: number
  touchedCount: number
}

type RewindTestHooks = {
  afterApply?: () => void | Promise<void>
  afterTouchedVerify?: () => void | Promise<void>
}

let rewindTestHooks: RewindTestHooks | undefined

export function _setRewindTestHooksForTesting(hooks: RewindTestHooks | undefined): void {
  rewindTestHooks = hooks
}

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

/**
 * Result of `fileHistoryMakeSnapshot`. Phase 5 made this explicit so
 * callers (specifically `fileHistoryRewind`) can distinguish:
 *   - `ok: true` — anchor committed, hash returned
 *   - `ok: false, reason: 'no-changes'` — disk already matches the
 *     previous anchor; semantically equivalent to "anchor exists" for
 *     transactional purposes (the prior anchor is the safety net)
 *   - `ok: false, reason: 'too-many-files'` — no anchor committed because
 *     the working tree exceeded the configured file-count guard
 *   - `ok: false, reason: 'failed'` — real error; caller must NOT
 *     proceed with downstream disk mutation since there's no safety
 *     net to recover from
 *
 * Earlier the function returned `void` and silently swallowed all
 * `createSnapshot` failures. A pre-rewind safety snapshot that failed
 * to commit would let the rewind proceed and modify disk with no way
 * back — invisible to the user, but a hard data-loss path. Explicit
 * return type plus rewind-aborts-on-failed-prerewind closes the gap.
 */
export type MakeSnapshotResult =
  | { ok: true; hash: string }
  | { ok: false; reason: 'no-changes' | 'failed' }
  | {
      ok: false
      reason: 'too-many-files'
      maxFiles: number
      firstDetection: boolean
    }

export async function fileHistoryMakeSnapshot(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
  label: string = 'file-history',
  preview?: string,
  // Caller declares what `preview` represents for this snapshot:
  //   'prompt' (default) — first ~80 chars of the user's prompt for
  //                        a regular turn anchor; picker uses it for
  //                        '↶ "<prompt>"' off-branch labels
  //   'target'           — first ~80 chars of the rewind target's
  //                        message for a pre-rewind safety-net anchor;
  //                        picker uses it for '↶ Undo rewind to "<target>"'
  // Storing the kind discriminator on disk (in the commit body via
  // formatCommitBody) means picker / chooser / list don't need to
  // re-derive it from the subject's label field.
  previewKind: 'prompt' | 'target' = 'prompt',
): Promise<MakeSnapshotResult> {
  if (!fileHistoryEnabled()) {
    return { ok: false, reason: 'failed' }
  }

  logForDebugging(`FileHistory: Making snapshot for message ${messageId}`)

  const workdir = getOriginalCwd()
  const bodyText = preview
    ? formatCommitBody({ kind: previewKind, preview })
    : ''
  const result = await createSnapshot(workdir, {
    messageId,
    label,
    bodyText,
  })
  if (result.ok === false) {
    logForDebugging(
      `FileHistory: snapshot skipped for ${messageId} (${result.skipped})`,
    )
    logCheckpointDiagnostic(
      () =>
        `fileHistory snapshot skipped messageId=${quoteDiagnostic(messageId)} ` +
        `skipped=${result.skipped}` +
        ('message' in result && result.message
          ? ` message=${quoteDiagnostic(result.message)}`
          : ''),
    )
    // `no-changes` is benign — the previous anchor already represents
    // current disk, no new commit needed. Every other skip reason is
    // a real failure (git missing, too many files, transient error,
    // race). Map them so callers can branch on the meaningful axis.
    if (result.skipped === 'no-changes') {
      const currentHash = await currentCheckpointHash(workdir)
      updateFileHistoryState(state => {
        const checkpointLabelsByHash = new Map(state.checkpointLabelsByHash)
        if (currentHash) {
          checkpointLabelsByHash.set(
            currentHash,
            labelFromPreview(messageId, preview),
          )
        }
        return {
          ...state,
          checkpointLabelsByHash,
          snapshotMessageIds: new Set(state.snapshotMessageIds).add(messageId),
        }
      })
      return { ok: false, reason: 'no-changes' }
    }
    if (result.skipped === 'too-many-files') {
      return {
        ok: false,
        reason: 'too-many-files',
        maxFiles: result.maxFiles,
        firstDetection: result.firstDetection,
      }
    }
    return { ok: false, reason: 'failed' }
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
    const checkpointLabelsByHash = new Map(state.checkpointLabelsByHash)
    checkpointLabelsByHash.set(result.hash, labelFromPreview(messageId, preview))
    return {
      ...state,
      trackedFiles,
      checkpointLabelsByHash,
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
    subject: formatCommitSubject({ messageId, label }),
    ...(preview ? { bodyPreview: preview } : {}),
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

  return { ok: true, hash: result.hash }
}

async function recordSuccessfulFileHistorySnapshot(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
  gitHash: string,
  label: string,
  preview?: string,
): Promise<void> {
  let addedTrackedFiles: string[] = []
  try {
    addedTrackedFiles = await diffPathsAgainstParent(getOriginalCwd(), gitHash)
  } catch (error) {
    logError(new Error(`FileHistory: trackedFiles diff failed: ${error}`))
  }

  updateFileHistoryState(state => {
    const trackedFiles = new Set(state.trackedFiles)
    for (const p of addedTrackedFiles) {
      trackedFiles.add(maybeShortenFilePath(p))
    }
    const checkpointLabelsByHash = new Map(state.checkpointLabelsByHash)
    if (!label.startsWith(`${LABEL_PRE_REWIND}:`)) {
      checkpointLabelsByHash.set(gitHash, labelFromPreview(messageId, preview))
    }
    return {
      ...state,
      trackedFiles,
      checkpointLabelsByHash,
      snapshotMessageIds: new Set(state.snapshotMessageIds).add(messageId),
      snapshotSequence: (state.snapshotSequence ?? 0) + 1,
    }
  })

  const draft: FileHistorySnapshot = {
    messageId,
    gitHash,
    addedTrackedFiles,
    timestamp: new Date(),
    subject: formatCommitSubject({ messageId, label }),
    ...(preview ? { bodyPreview: preview } : {}),
  }
  void recordFileHistorySnapshot(messageId, draft, false).catch(error => {
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

async function currentCheckpointHash(workdir: string): Promise<string | undefined> {
  const storeResult = await ensureStore()
  if (storeResult.ok === false) return undefined
  const canonical = normalizePath(workdir)
  const hash = projectHash(canonical)
  const r = await runCheckpointGit(
    ['rev-parse', '--verify', `${refName(hash)}^{commit}`],
    {
      store: storeResult.store,
      workTree: canonical,
      allowedExitCodes: REF_NOT_PRESENT,
    },
  )
  if (r.ok === false) return undefined
  const out = r.stdout.trim()
  return out.length > 0 ? out : undefined
}

function labelFromPreview(messageId: UUID, preview?: string): CheckpointHashLabel {
  return { messageId, preview, timestamp: new Date() }
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
/**
 * Restore the workdir to the snapshot at `gitHash`.
 *
 * Phase 7 prologue: validate the anchor still exists in the store
 * BEFORE doing anything else. The picker captured this hash at mount
 * time; between then and the user pressing Enter, another axiomate
 * process or a user-invoked `/checkpoints prune` / `clear` could have
 * removed it. Surface a refresh-pointing error before we even touch
 * the safety-snapshot path. Distinct from the Phase 5 mid-rewind
 * failure case (which points at "↶ Rewind") because here
 * disk hasn't been modified at all — there is nothing to undo.
 *
 * Phase 5 transaction model (after the existence check passes):
 *   1. Take a pre-rewind safety snapshot. If commit fails (real
 *      error, NOT "no-changes"), abort BEFORE touching disk — there
 *      is no safety net to recover from. The user gets a clear error
 *      and disk is unchanged.
 *   2. The "no-changes" path is benign: disk already matches the
 *      previous anchor, which IS the safety net. Proceed.
 *   3. Restore disk. If restore fails partway, throw a recovery-
 *      pointing error: pre-rewind anchor exists in the ref, the user
 *      can pick "↶ Rewind" to roll disk back.
 *   4. Verify disk matches target tree. If diff is non-empty after a
 *     "successful" restore, we have silent data corruption — surface
 *      the same recovery hint.
 *
 * What this does NOT do: rollback the ref tip on failure. Earlier
 * drafts considered `git update-ref --no-deref <ref> <oldTip>` to
 * unwind the pre-rewind commit, but that REMOVES the user's only
 * recovery path. Keeping the pre-rewind anchor visible in the picker
 * is more valuable than ref tidiness on failure.
 */
export async function fileHistoryRewind(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  gitHash: string,
  targetPreview?: string,
): Promise<void> {
  if (!fileHistoryEnabled()) return

  logForDebugging(`FileHistory: [Rewind] entry gitHash=${gitHash.slice(0, 8)}`)

  // Phase 7: anchor existence gate. ~5ms `git cat-file -t` round-trip;
  // catches cross-process prune / clear / gc since the picker mounted.
  // Phase 6 closes the same-process race; this closes the rest.
  const exists = await anchorExistsInStore(gitHash)
  if (!exists) {
    logError(
      new Error(
        `FileHistory: [Rewind] aborted — anchor ${gitHash.slice(0, 8)} ` +
          `no longer exists in the store (likely pruned by another process)`,
      ),
    )
    throw new Error(
      `This snapshot is no longer available — the store may have been ` +
        `pruned or cleared. Press Esc and re-open /rewind to refresh the picker.`,
    )
  }

  const plan = await prepareRewindExecutionPlan(getOriginalCwd(), gitHash)
  try {
    const preRewindMessageId = randomUUID() as UUID
    const bodyText = targetPreview
      ? formatCommitBody({ kind: 'target', preview: targetPreview })
      : ''
    const preRewind = await createSnapshotFromTree(
      getOriginalCwd(),
      plan.currentTree,
      {
        messageId: preRewindMessageId,
        label: `${LABEL_PRE_REWIND}:${gitHash.slice(0, 8)}`,
        bodyText,
      },
    )
    if (
      preRewind.ok === false &&
      (preRewind.skipped === 'transient-error' ||
        preRewind.skipped === 'too-many-files' ||
        preRewind.skipped === 'git-missing' ||
        preRewind.skipped === 'workdir-too-broad' ||
        preRewind.skipped === 'race')
    ) {
      logForDebugging(
        `FileHistory: [Rewind] aborted — pre-rewind safety snapshot failed (${preRewind.skipped})`,
      )
      throw new Error(
        'Cannot create pre-rewind safety snapshot. Rewind aborted, ' +
          'disk unchanged. Check checkpoints store availability, file-count guard settings, and retry.',
      )
    }
    if (preRewind.ok === true) {
      await recordSuccessfulFileHistorySnapshot(
        updateFileHistoryState,
        preRewindMessageId,
        preRewind.hash,
        `${LABEL_PRE_REWIND}:${gitHash.slice(0, 8)}`,
        targetPreview,
      )
    }
    logForDebugging(
      `FileHistory: [Rewind] pre-rewind safety net ` +
        (preRewind.ok ? `committed (${preRewind.hash.slice(0, 8)})` : 'no-op (no-changes)'),
    )

    try {
      await applyRewindExecutionPlan(plan)
    } catch (error) {
      logError(
        new Error(
          `FileHistory: [Rewind] disk restore failed mid-way: ${error}. ` +
            `Recover via /rewind picker → "↶ Rewind" row.`,
        ),
      )
      throw new Error(
        `Rewind failed mid-way. Disk may be partially modified. ` +
          `Open /rewind, switch to File tab, select "↶ Rewind" to recover.`,
      )
    }

    await rewindTestHooks?.afterApply?.()

    const touchedVerified = await verifyRewindTouchedPaths(plan)
    if (!touchedVerified) {
      throwRewindVerificationError(gitHash)
    }

    await rewindTestHooks?.afterTouchedVerify?.()

    const fullVerified = await verifyRewindFullTree(plan)
    if (!fullVerified) {
      throwRewindVerificationError(gitHash)
    }

    logForDebugging(
      `FileHistory: [Rewind] Finished rewinding to ${gitHash.slice(0, 8)}`,
    )
  } finally {
    await cleanupRewindExecutionPlan(plan)
  }
}

/**
 * Verify the workdir matches the tree at `gitHash` exactly. Stages
 * disk and checks `git diff --cached --quiet` against the target.
 * Returns true if they match (or if verification itself fails — we
 * don't want a flaky verification step blocking otherwise-successful
 * rewinds; the throw-on-mismatch path requires a confident "no").
 */
/**
 * Check whether the given commit hash still exists in the checkpoint
 * store. Used by `fileHistoryRewind` to detect prune / clear / gc
 * that happened after the picker resolved this hash. Read-only,
 * ~5ms round-trip.
 *
 * Returns false on:
 *   - hash genuinely missing (`git cat-file -t` exit 128)
 *   - store missing (ensureStore failure)
 *   - any other unexpected git failure (treat as "can't confirm
 *     existence" → safe to abort the rewind rather than press on)
 */
async function anchorExistsInStore(gitHash: string): Promise<boolean> {
  const storeResult = await ensureStore()
  if (storeResult.ok === false) return false
  const canonical = normalizePath(getOriginalCwd())

  const r = await runCheckpointGit(['cat-file', '-t', gitHash], {
    store: storeResult.store,
    workTree: canonical,
    indexFile: indexPath(projectHash(canonical)),
    allowedExitCodes: new Set([128]), // 128 = unknown object
  })
  if (r.ok === false) return false
  // Exit 0 + stdout "commit\n" → exists. Exit 128 (allowed) →
  // missing — runCheckpointGit returns ok:true with empty/error
  // stdout in that case. Distinguish by code.
  return r.code === 0 && r.stdout.trim() === 'commit'
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
 * Per-anchor diff stats for the picker / `/checkpoints list`.
 *
 * Each anchor is a PRE-tool snapshot — its tree captures disk BEFORE
 * a turn runs. We want the row labeled `Before "<prompt>"` to show
 * what THAT prompt wrote on disk, not what the previous prompt wrote.
 * Showing the anchor's own commit-vs-parent diff would surface the
 * latter (the diff describes the gap between two pre-tool snapshots,
 * which is the work of the turn that ran BETWEEN them — i.e. the
 * earlier turn). To make stats align with the row's prompt label,
 * we shift one slot: a row's stats describe the diff to the snapshot
 * AFTER it (or to disk for the newest row).
 *
 * Algorithm — anchors arrive newest-first (anchors[0] = latest):
 *
 *   stats[0]    = diff(anchors[0].tree, diskTree)
 *                  ≡ "the latest turn ran and produced current disk"
 *   stats[i>=1] = diff(anchors[i].tree, anchors[i-1].tree)
 *                  ≡ "the turn after this snapshot was taken
 *                     produced the next snapshot"
 *
 * The oldest anchor is the root commit (tree=∅ in fresh-empty-dir
 * sessions). Its stats describe what the FIRST edit wrote — which is
 * exactly the diff against anchors[N-2], no special case needed.
 *
 * Returns `Map<gitHash, DiffStats>` keyed by anchor.gitHash. Anchors
 * whose diff-tree call fails get omitted (caller renders "stats
 * unavailable"). Function never throws — fail-soft like the rest of
 * the checkpoint subsystem.
 *
 * Implementation: stage workdir → write-tree once → diff only the
 * newest anchor against disk. Older rows reuse the next-newer anchor's
 * precomputed commit-vs-parent stats from `listSnapshots(withStats: true)`
 * / `listCodeAnchors(withStats: true)`, shifted by one slot. This avoids
 * serial `diff-tree --numstat` work for every row while preserving the
 * event-aligned contract above.
 *
 * `gitHash` field on the input is whatever the caller uses as a
 * stable map key — SnapshotEntry calls it `hash`, CodeAnchor calls it
 * `gitHash`; the adapter at each call site normalizes that. The stats
 * fields must be populated by callers with `withStats: true` for older
 * rows to show event stats.
 */
export interface EventStatsAnchor {
  readonly gitHash: string
  readonly filesChanged: number
  readonly insertions: number
  readonly deletions: number
  readonly filePaths: readonly string[]
}

export interface RewindCodeRowAnchor extends EventStatsAnchor {
  readonly messageId: UUID | undefined
  readonly subject: string
  readonly body: string
  readonly timestamp: Date
}

export async function buildRewindCodeRows(
  anchors: readonly RewindCodeRowAnchor[],
  labelsByHash: ReadonlyMap<string, CheckpointHashLabel> = new Map(),
): Promise<RewindCodeRow[]> {
  const rows: RewindCodeRow[] = []
  if (!fileHistoryEnabled() || anchors.length === 0) return rows

  const originalIndexByHash = new Map<string, number>()
  anchors.forEach((anchor, index) => {
    originalIndexByHash.set(anchor.gitHash, index)
  })

  const intervalAnchors = anchors.filter(anchor => classifyAnchor(anchor.subject) !== 'foreign')
  const intervalAnchorHashes = new Set(intervalAnchors.map(anchor => anchor.gitHash))
  const displayAnchors = anchors.filter(anchor => {
    const kind = classifyAnchor(anchor.subject)
    return (
      kind !== 'foreign' &&
      (kind === 'turn' || kind === 'pre-rewind' || labelsByHash.has(anchor.gitHash))
    )
  })
  if (displayAnchors.length === 0) return rows

  const storeResult = await ensureStore()
  if (storeResult.ok === false) return rows
  const store = storeResult.store
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  await stageWorkdir(store, canonical, indexFile)
  const wt = await runCheckpointGit(['write-tree'], {
    store,
    workTree: canonical,
    indexFile,
  })
  if (wt.ok === false) return rows
  const diskTree = wt.stdout.trim()
  if (diskTree.length === 0) return rows

  const diffInterval = async (
    anchor: RewindCodeRowAnchor,
    compare: string,
  ): Promise<DiffStats | undefined> => {
    const diff = await runCheckpointGit(
      ['diff-tree', '--numstat', '-r', anchor.gitHash, compare, '--'],
      { store, workTree: canonical, indexFile },
    )
    if (diff.ok === false) {
      logForDebugging(
        `FileHistory: [RewindRows] diff-tree failed hash=${anchor.gitHash.slice(0, 8)}: ${diff.message}`,
      )
      return undefined
    }
    return diffStatsFromNumstat(diff.stdout)
  }

  const nextIntervalAnchor = (anchor: RewindCodeRowAnchor): RewindCodeRowAnchor | undefined => {
    const index = originalIndexByHash.get(anchor.gitHash)
    if (index === undefined) return undefined
    for (let i = index - 1; i >= 0; i--) {
      const candidate = anchors[i]!
      if (intervalAnchorHashes.has(candidate.gitHash)) return candidate
    }
    return undefined
  }

  for (const anchor of displayAnchors) {
    const compareAnchor = nextIntervalAnchor(anchor)
    const diffStats = compareAnchor
      ? originalIndexByHash.get(compareAnchor.gitHash) ===
        (originalIndexByHash.get(anchor.gitHash) ?? -1) - 1
        ? diffStatsFromAnchor(compareAnchor)
        : await diffInterval(anchor, compareAnchor.gitHash)
      : await diffInterval(anchor, diskTree)
    if (!diffStats || diffStats.filesChanged.length === 0) continue

    const role = classifyAnchor(anchor.subject)
    const label = labelsByHash.get(anchor.gitHash) ?? labelFromAnchor(anchor)
    const kind: RewindCodeRowKind =
      role === 'turn'
        ? 'turn'
        : labelsByHash.has(anchor.gitHash)
          ? 'hash-label'
          : 'pre-rewind'
    rows.push({
      rowId: anchor.gitHash,
      kind,
      restoreHash: anchor.gitHash,
      labelMessageId: label?.messageId ?? anchor.messageId,
      labelPreview: label?.preview,
      labelText: labelTextForRewindRow(anchor, label, kind),
      timestamp: label?.timestamp ?? anchor.timestamp,
      diffStats,
      isSynthetic: kind === 'pre-rewind',
    })
  }

  return rows
}

function labelTextForRewindRow(
  anchor: RewindCodeRowAnchor,
  label: CheckpointHashLabel | undefined,
  kind: RewindCodeRowKind,
): string {
  const hashTag = ` [${anchor.gitHash.slice(0, 7)}]`
  if (kind === 'pre-rewind') {
    const body = parseCommitBody(anchor.body)
    const preview =
      body.kind === 'target' || body.kind === 'prompt'
        ? body.preview
        : body.kind === 'unknown'
          ? body.raw
          : ''
    const isHashRef = /^\[[0-9a-f]{7,8}\]$/i.test(preview)
    if (isHashRef) return `↶ Before rewind ${preview.slice(1, -1)}${hashTag}`
    if (preview.length > 0) return `↶ Before rewind "${preview}"${hashTag}`
    const targetHash = targetHashFromPreRewindSubject(anchor.subject)
    if (targetHash) return `↶ Before rewind ${targetHash}${hashTag}`
    return `↶ Before rewind${hashTag}`
  }
  if (label?.preview) return `↶ Before "${label.preview}"`
  return `↶ Before checkpoint ${anchor.gitHash.slice(0, 7)}`
}

function targetHashFromPreRewindSubject(subject: string): string | undefined {
  const parsed = parseCommitSubject(subject)
  if (parsed.kind !== 'axiomate') return undefined
  const prefix = `${LABEL_PRE_REWIND}:`
  if (!parsed.label.startsWith(prefix)) return undefined
  const hash = parsed.label.slice(prefix.length)
  return hash.length > 0 ? hash : undefined
}

function labelFromAnchor(
  anchor: RewindCodeRowAnchor,
): CheckpointHashLabel | undefined {
  if (!anchor.messageId) return undefined
  const body = parseCommitBody(anchor.body)
  return {
    messageId: anchor.messageId,
    preview: body.kind === 'prompt' ? body.preview : undefined,
    timestamp: anchor.timestamp,
  }
}

export async function bulkDiffEventStats(
  anchors: readonly EventStatsAnchor[],
): Promise<Map<string, DiffStats>> {
  const out = new Map<string, DiffStats>()
  if (!fileHistoryEnabled() || anchors.length === 0) return out

  const storeResult = await ensureStore()
  if (storeResult.ok === false) return out
  const store = storeResult.store
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  // Stage current disk into a tree object, used only for anchors[0]'s
  // event diff (newest anchor's pair is current disk). Older rows reuse
  // already-batched commit stats from the next-newer anchor.
  await stageWorkdir(store, canonical, indexFile)
  const wt = await runCheckpointGit(['write-tree'], {
    store,
    workTree: canonical,
    indexFile,
  })
  if (wt.ok === false) return out
  const diskTree = wt.stdout.trim()
  if (diskTree.length === 0) return out

  const newest = anchors[0]!
  const newestDiff = await runCheckpointGit(
    ['diff-tree', '--numstat', '-r', newest.gitHash, diskTree, '--'],
    {
      store,
      workTree: canonical,
      indexFile,
    },
  )
  if (newestDiff.ok === false) {
    logForDebugging(
      `FileHistory: [EventStats] diff-tree failed hash=${newest.gitHash.slice(0, 8)}: ${newestDiff.message}`,
    )
  } else {
    out.set(newest.gitHash, diffStatsFromNumstat(newestDiff.stdout))
  }

  for (let i = 1; i < anchors.length; i++) {
    out.set(anchors[i]!.gitHash, diffStatsFromAnchor(anchors[i - 1]!))
  }

  return out
}

function diffStatsFromAnchor(anchor: EventStatsAnchor): DiffStats {
  return {
    filesChanged: anchor.filePaths.map(p => maybeExpandFilePath(p)),
    insertions: anchor.insertions,
    deletions: anchor.deletions,
  }
}

function diffStatsFromNumstat(stdout: string): DiffStats {
  const filesRel: string[] = []
  let insertions = 0
  let deletions = 0
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [insStr, delStr, ...pathParts] = parts
    const path = pathParts.join('\t')
    if (path.length === 0) continue
    filesRel.push(path)
    if (insStr !== '-') insertions += Number.parseInt(insStr, 10) || 0
    if (delStr !== '-') deletions += Number.parseInt(delStr, 10) || 0
  }
  return {
    filesChanged: filesRel.map(p => maybeExpandFilePath(p)),
    insertions,
    deletions,
  }
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
    checkpointLabelsByHash: new Map(),
    trackedFiles,
    snapshotSequence: snapshotMessageIds.size,
  })
}

async function stageWorkdir(
  store: string,
  workTree: string,
  indexFile: string,
): Promise<void> {
  const result = await stageWorktreeSnapshotIndex({
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

async function prepareRewindExecutionPlan(
  workdir: string,
  targetHash: string,
): Promise<RewindExecutionPlan> {
  const prepared = await prepareSnapshotTree(workdir)
  if (prepared.ok === false) {
    if (prepared.skipped === 'too-many-files') {
      throw new Error('too-many-files')
    }
    throw new Error(prepared.message ?? prepared.skipped)
  }

  const tempDir = await mkdtemp(join(tmpdir(), REWIND_PATHSPEC_PREFIX))
  try {
    const checkoutPathspecFile = join(tempDir, 'checkout-paths.nul')
    const deletePathspecFile = join(tempDir, 'delete-paths.nul')
    const deleteCount = await writePathspecFromDiff({
      store: prepared.store,
      workdir: prepared.canonical,
      indexFile: prepared.indexFile,
      args: [
        'diff',
        '--name-only',
        '-z',
        '--diff-filter=A',
        targetHash,
        prepared.treeHash,
      ],
      pathspecFile: deletePathspecFile,
    })
    const checkoutCount = await writePathspecFromDiff({
      store: prepared.store,
      workdir: prepared.canonical,
      indexFile: prepared.indexFile,
      args: [
        'diff',
        '--name-only',
        '-z',
        '--diff-filter=AMT',
        prepared.treeHash,
        targetHash,
      ],
      pathspecFile: checkoutPathspecFile,
    })

    return {
      store: prepared.store,
      workdir: prepared.canonical,
      indexFile: prepared.indexFile,
      targetHash,
      currentTree: prepared.treeHash,
      tempDir,
      checkoutPathspecFile,
      deletePathspecFile,
      checkoutCount,
      deleteCount,
      touchedCount: checkoutCount + deleteCount,
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function writePathspecFromDiff(args: {
  store: string
  workdir: string
  indexFile: string
  args: string[]
  pathspecFile: string
}): Promise<number> {
  const diff = await streamGitPathspecFromDiff({
    store: args.store,
    workTree: args.workdir,
    indexFile: args.indexFile,
    gitArgs: args.args,
    pathspecFile: args.pathspecFile,
  })
  if (diff.ok === false) throw new Error(`diff: ${diff.message}`)
  return diff.count
}

async function applyRewindExecutionPlan(plan: RewindExecutionPlan): Promise<void> {
  logForDebugging(
    `FileHistory: [Rewind] path apply delete=${plan.deleteCount} checkout=${plan.checkoutCount}`,
  )
  await deletePathspecPaths(plan)
  if (plan.checkoutCount === 0) return

  const checkout = await runCheckpointGit(
    [
      'checkout',
      plan.targetHash,
      `--pathspec-from-file=${plan.checkoutPathspecFile}`,
      '--pathspec-file-nul',
    ],
    {
      store: plan.store,
      workTree: plan.workdir,
      indexFile: plan.indexFile,
      timeoutMs: 60_000,
    },
  )
  if (checkout.ok === false) {
    throw new Error(`checkout: ${checkout.message}`)
  }
}

async function deletePathspecPaths(plan: RewindExecutionPlan): Promise<void> {
  if (plan.deleteCount === 0) return
  for await (const rel of readNulPathspecFile(plan.deletePathspecFile)) {
    const abs = join(plan.workdir, rel)
    try {
      await unlink(abs)
      await removeEmptyParents(dirname(abs), plan.workdir)
      logForDebugging(`FileHistory: [Rewind] Deleted ${abs}`)
    } catch (err: unknown) {
      if (!isENOENT(err)) logError(err)
    }
  }
}

async function removeEmptyParents(dir: string, root: string): Promise<void> {
  let current = dir
  while (current.length > root.length && current.startsWith(root)) {
    try {
      await rmdir(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

async function verifyRewindTouchedPaths(plan: RewindExecutionPlan): Promise<boolean> {
  if (plan.touchedCount === 0) return true
  const files = [
    [plan.checkoutPathspecFile, plan.checkoutCount] as const,
    [plan.deletePathspecFile, plan.deleteCount] as const,
  ]
  for (const [pathspecFile, count] of files) {
    if (count === 0) continue
    const diff = await runCheckpointGit(
      [
        'diff',
        '--quiet',
        plan.targetHash,
        `--pathspec-from-file=${pathspecFile}`,
        '--pathspec-file-nul',
      ],
      {
        store: plan.store,
        workTree: plan.workdir,
        indexFile: plan.indexFile,
        allowedExitCodes: DIFF_HAS_CHANGES,
      },
    )
    if (diff.ok === false) return true
    if (diff.code === 1) return false
  }
  return true
}

async function verifyRewindFullTree(plan: RewindExecutionPlan): Promise<boolean> {
  const stage = await stageWorktreeSnapshotIndex({
    store: plan.store,
    workTree: plan.workdir,
    indexFile: plan.indexFile,
  })
  if (stage.ok === false) {
    logForDebugging(
      `FileHistory: [Rewind] final full-tree verification stage failed (${stage.message}); treating as inconclusive`,
    )
    return true
  }

  await dropOversizeFromIndex({
    store: plan.store,
    workTree: plan.workdir,
    indexFile: plan.indexFile,
    maxFileSizeMb: MAX_FILE_SIZE_MB,
  })

  const diff = await runCheckpointGit(
    ['diff', '--cached', '--quiet', plan.targetHash, '--'],
    {
      store: plan.store,
      workTree: plan.workdir,
      indexFile: plan.indexFile,
      allowedExitCodes: DIFF_HAS_CHANGES,
    },
  )
  if (diff.ok === false) {
    logForDebugging(
      `FileHistory: [Rewind] final full-tree verification diff failed (${diff.message}); treating as inconclusive`,
    )
    return true
  }
  return diff.code === 0
}

function throwRewindVerificationError(gitHash: string): never {
  logError(
    new Error(
      `FileHistory: [Rewind] verification failed — disk does not match ` +
        `target tree ${gitHash.slice(0, 8)} after restore`,
    ),
  )
  throw new Error(
    `Rewind completed but disk does not match the target. Some files ` +
      `may be locked by another process. Open /rewind, select ` +
      `"↶ Rewind" to recover, then retry.`,
  )
}

async function cleanupRewindExecutionPlan(plan: RewindExecutionPlan): Promise<void> {
  await rm(plan.tempDir, { recursive: true, force: true }).catch(() => {})
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
