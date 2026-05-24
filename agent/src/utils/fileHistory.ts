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
import {
  formatCommitBody,
  formatCommitSubject,
  LABEL_PRE_REWIND,
} from './checkpoints/reason.js'
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

/**
 * Result of `fileHistoryMakeSnapshot`. Phase 5 made this explicit so
 * callers (specifically `fileHistoryRewind`) can distinguish:
 *   - `ok: true` — anchor committed, hash returned
 *   - `ok: false, reason: 'no-changes'` — disk already matches the
 *     previous anchor; semantically equivalent to "anchor exists" for
 *     transactional purposes (the prior anchor is the safety net)
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
    // `no-changes` is benign — the previous anchor already represents
    // current disk, no new commit needed. Every other skip reason is
    // a real failure (git missing, too many files, transient error,
    // race). Map them so callers can branch on the meaningful axis.
    return result.skipped === 'no-changes'
      ? { ok: false, reason: 'no-changes' }
      : { ok: false, reason: 'failed' }
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
/**
 * Restore the workdir to the snapshot at `gitHash`.
 *
 * Phase 7 prologue: validate the anchor still exists in the store
 * BEFORE doing anything else. The picker captured this hash at mount
 * time; between then and the user pressing Enter, another axiomate
 * process or a user-invoked `/checkpoints prune` / `clear` could have
 * removed it. Surface a refresh-pointing error before we even touch
 * the safety-snapshot path. Distinct from the Phase 5 mid-rewind
 * failure case (which points at "↶ Undo last rewind") because here
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
 *      can pick "↶ Undo last rewind" to roll disk back.
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

  const preRewindMessageId = randomUUID() as UUID
  const preRewind = await fileHistoryMakeSnapshot(
    updateFileHistoryState,
    preRewindMessageId,
    `${LABEL_PRE_REWIND}:${gitHash.slice(0, 8)}`,
    // Caller passes the rewind target's message preview ("创建 test.txt"
    // etc); we stash it in the commit body (kind: 'target', see
    // reason.ts for the body codec) so the picker's ↶ row can surface
    // "↶ Undo rewind to '<target>'" instead of an opaque "Undo last
    // rewind" — users couldn't tell which rewind it was undoing when
    // chained or after multiple sessions.
    targetPreview,
    'target',
  )
  if (preRewind.ok === false && preRewind.reason === 'failed') {
    logForDebugging(
      `FileHistory: [Rewind] aborted — pre-rewind safety snapshot failed`,
    )
    throw new Error(
      'Cannot create pre-rewind safety snapshot. Rewind aborted, ' +
        'disk unchanged. Check checkpoints store availability and retry.',
    )
  }
  logForDebugging(
    `FileHistory: [Rewind] pre-rewind safety net ` +
      (preRewind.ok ? `committed (${preRewind.hash.slice(0, 8)})` : 'no-op (no-changes)'),
  )

  try {
    await restoreFullWorkdirToSnapshot(getOriginalCwd(), gitHash)
  } catch (error) {
    logError(
      new Error(
        `FileHistory: [Rewind] disk restore failed mid-way: ${error}. ` +
          `Recover via /rewind picker → "↶ Undo last rewind" row.`,
      ),
    )
    throw new Error(
      `Rewind failed mid-way. Disk may be partially modified. ` +
        `Open /rewind, switch to File tab, select "↶ Undo last rewind" to recover.`,
    )
  }

  // Post-restore consistency check: disk should match the target tree
  // exactly. If it doesn't, restoreFullWorkdirToSnapshot returned
  // success but git checkout silently failed on some path (a
  // file-locked external editor, antivirus quarantine, etc).
  const verified = await verifyDiskMatchesTree(gitHash)
  if (!verified) {
    logError(
      new Error(
        `FileHistory: [Rewind] verification failed — disk does not match ` +
          `target tree ${gitHash.slice(0, 8)} after restore`,
      ),
    )
    throw new Error(
      `Rewind completed but disk does not match the target. Some files ` +
        `may be locked by another process. Open /rewind, select ` +
        `"↶ Undo last rewind" to recover, then retry.`,
    )
  }

  logForDebugging(
    `FileHistory: [Rewind] Finished rewinding to ${gitHash.slice(0, 8)}`,
  )
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

async function verifyDiskMatchesTree(gitHash: string): Promise<boolean> {
  const storeResult = await ensureStore()
  if (storeResult.ok === false) return true
  const canonical = normalizePath(getOriginalCwd())
  const indexFile = indexPath(projectHash(canonical))

  const stage = await runCheckpointGit(['add', '-A'], {
    store: storeResult.store,
    workTree: canonical,
    indexFile,
  })
  if (stage.ok === false) return true // can't verify — don't claim mismatch

  const r = await runCheckpointGit(
    ['diff', '--cached', '--quiet', gitHash, '--'],
    {
      store: storeResult.store,
      workTree: canonical,
      indexFile,
      allowedExitCodes: DIFF_HAS_CHANGES,
    },
  )
  if (r.ok === false) return true // ditto
  return r.code === 0 // 0 = no diff, 1 = diff present
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
 * Per-event diff stats for a list of anchors (newest-first).
 *
 * Each anchor's stats answer "what did THIS event do on disk".
 * For the newest anchor (i=0): anchor.tree vs current disk
 * (its event is the most recent committed state; whatever the user
 * has on disk now is what came after).
 * For older anchors (i>=1): the COMMIT-VS-PARENT numstat already
 * computed by listSnapshots/listCodeAnchors, which is exactly
 * "what this commit added/removed relative to the previous one"
 * (= what the corresponding event wrote on disk at the time).
 *
 * This is what picker rows and `/checkpoints list` should display:
 * the row's label says "v1 改 v2" so the row's stats should report
 * the v1→v2 delta — stable across subsequent rewinds, independent
 * of where disk drifts. Earlier the picker used anchor-vs-disk,
 * which was correct for the chooser ("if I restore this, how does
 * disk change") but wrong for a historical browse view ("what did
 * this event do").
 *
 * Returns `Map<gitHash, DiffStats>` keyed by anchor.gitHash; same
 * shape as `fileHistoryBulkDiffVsDisk` so picker / list rendering
 * code can switch helpers without other changes.
 *
 * Cost: 1 git spawn (the newest anchor's anchor-vs-disk diff). All
 * other rows reuse the data already on the input objects.
 *
 * Accepts a duck-typed protocol so both CodeAnchor (used by
 * MessageSelector.tsx) and SnapshotEntry (used by /checkpoints list
 * via commands/checkpoints/checkpoints.tsx) can pass through. The
 * `gitHash` field is whatever the caller uses as a stable map key —
 * SnapshotEntry calls it `hash`, CodeAnchor calls it `gitHash`; the
 * adapter at each call site normalizes that.
 */
export interface EventStatsAnchor {
  readonly gitHash: string
  readonly filesChanged: number
  readonly insertions: number
  readonly deletions: number
  readonly filePaths: readonly string[]
}

export async function bulkDiffEventStats(
  anchors: readonly EventStatsAnchor[],
): Promise<Map<string, DiffStats>> {
  const out = new Map<string, DiffStats>()
  if (anchors.length === 0) return out

  // Each row in the picker / list is labeled with a turn's prompt and
  // should display "what THIS turn did on disk".
  //
  // Anchors are PRE-tool snapshots (taken before the turn runs), so
  // the diff for "turn N's effect" lives between turn N's anchor and
  // the next turn's anchor (taken after turn N completed). In
  // newest-first ordering, anchor[i+1] is older than anchor[i], so
  // the next-newer anchor for row i is anchor[i-1]. Its
  // commit-vs-parent numstat (already populated by listSnapshots)
  // captures exactly turn[i]'s diff.
  //
  // The newest row (i=0) has no newer anchor; "what came after" is
  // current disk. fileHistoryBulkDiffVsDisk gives anchor-vs-disk for
  // that one row.
  //
  // The oldest row's turn diff is unrepresentable in this model — its
  // pre-snapshot exists but no later anchor was taken before the turn
  // shipped. The map leaves it absent and the renderer falls back to
  // "(no diff)". Earlier code displayed the oldest commit's
  // commit-vs-empty-tree numstat there, which surfaced the entire
  // repo state ("1985 files +489k -0") as if it were turn[oldest]'s
  // effect. That was visibly wrong.
  for (let i = 1; i < anchors.length; i++) {
    const row = anchors[i]
    const source = anchors[i - 1]
    if (!row || !source) continue
    if (
      source.filesChanged === 0 &&
      source.insertions === 0 &&
      source.deletions === 0
    ) {
      out.set(row.gitHash, { filesChanged: [], insertions: 0, deletions: 0 })
      continue
    }
    out.set(row.gitHash, {
      filesChanged: source.filePaths.slice(),
      insertions: source.insertions,
      deletions: source.deletions,
    })
  }

  const newest = anchors[0]
  if (newest) {
    const newestStats = await fileHistoryBulkDiffVsDisk([newest.gitHash])
    const stats = newestStats.get(newest.gitHash)
    if (stats) out.set(newest.gitHash, stats)
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
