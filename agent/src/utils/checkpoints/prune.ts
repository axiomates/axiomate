/**
 * `pruneCheckpoints` — auto-maintenance for the shadow-git store.
 *
 * Runs four passes against `~/.axiomate/checkpoints/store/`:
 *   1. Orphan       — drop refs whose project workdir no longer exists on disk.
 *   2. Stale        — drop refs whose `last_touch` is older than `retentionDays`.
 *   3. Snapshot cap — for each surviving ref, rebuild to keep only the most
 *                     recent N commits (N from globalConfig
 *                     `checkpointsMaxSnapshotsPerProject`). Mirrors
 *                     createSnapshot's write-time ring buffer so lowering the
 *                     cap re-tightens existing refs without waiting for the
 *                     next snapshot.
 *   4. Size         — while total store size exceeds `maxTotalSizeMb`, drop
 *                     the oldest commit per ref (round-robin) until under cap
 *                     or no progress made in a full round.
 *
 * Followed (or interleaved) by `git reflog expire --expire=now --all` +
 * `git gc --prune=now --quiet` (3× timeout). gc runs unconditionally
 * after pass 1+2 and at the end of pass 3 — Hermes `prune_checkpoints`::1375-1382 / 1446-1452.
 *
 * Triggered async from `backgroundHousekeeping.ts:runVerySlowOps()` once
 * the user has been idle ≥1 minute and ≥10 minutes after boot. `bareMode`
 * (`--print` and similar) skips the whole housekeeping stack, so prune
 * never runs in non-interactive sessions.
 *
 * Idempotency throttle: writes `~/.axiomate/checkpoints/.last_prune` on
 * success. Subsequent calls within `MIN_INTERVAL_HOURS` short-circuit
 * unless `forceNow=true`. Hermes `maybe_auto_prune_checkpoints:1462-1526`.
 *
 * Fail-open contract: never throws. Per-step failures collect into
 * `report.errors[]`; the caller (`runVerySlowOps`) ignores the report
 * and just lets the next housekeeping cycle retry.
 */

import { existsSync, readdirSync, statSync, type Dirent } from 'fs'
import { stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import {
  DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS,
  probeGitAvailable,
  runCheckpointGit,
} from './git.js'
import {
  getCheckpointBase,
  getLastPrunePath,
  getStoreDir,
  indexPath,
  KEEP_REF_PREFIX,
  keepRefName,
  parseKeepRefName,
  projectMetaPath,
  refName,
} from './paths.js'
import { loadProjectMetas as loadProjectMetasShared } from './projectMetas.js'
import type { ProjectMeta } from './projectMetas.js'
import { pruneRefToMaxN } from './pruneRefToMaxN.js'
import {
  extractGitHashes,
  listRecentSessionsForWorkdir,
  DEFAULT_KEEP_WINDOW_DAYS,
} from './sessionScan.js'

/**
 * Hard upper bound on size-cap drop iterations. Matches Hermes `prune_checkpoints`::1387
 * (`for _i in range(20)`). Defends against pathological cases where
 * dropping commits doesn't shrink the store fast enough to converge in
 * finite time.
 */
const SIZE_CAP_MAX_ITERATIONS = 20

/**
 * Minimum commits kept per ref during size-cap. We never want to delete
 * a project's *last* snapshot (would lose all rewindability). Hermes
 * 1409 (`if count <= 1: continue`) enforces the same invariant.
 */
const KEEP_LAST_N_PER_REF = 1

const REF_MISSING = new Set([128])
const REFS_PREFIX = 'refs/axiomate'

/**
 * Default retention for stale-pass (days). 30d preserves recent work
 * across normal context switches while letting abandoned project refs
 * age out before they become permanent disk clutter.
 */
export const DEFAULT_RETENTION_DAYS = 30

/**
 * Default cross-project size cap (MB). 1 GB is a conservative product
 * default: enough for meaningful rewind history with git object
 * deduplication, small enough that unattended checkpointing feels safe.
 */
export const DEFAULT_MAX_TOTAL_SIZE_MB = 1000

/**
 * Default per-project snapshot cap, used when globalConfig
 * `checkpointsMaxSnapshotsPerProject` is unset or invalid. Mirrors
 * `MAX_SNAPSHOTS` in createSnapshot.ts so write-time and prune-time
 * caps agree by default; users overriding via /config override both.
 */
export const DEFAULT_MAX_SNAPSHOTS_PER_REF = 1000

/**
 * Minimum interval between auto-prune runs. 24h matches Hermes
 * `maybe_auto_prune_checkpoints` default and is the throttle that keeps
 * the maintenance hook cheap on every boot.
 */
export const MIN_INTERVAL_HOURS = 24

export interface PruneOptions {
  /** Override default 30-day retention. Use `0` to disable stale pass. */
  retentionDays?: number
  /** Override default 1000 MB (1 GB) cap. Use `0` to disable size pass. */
  maxTotalSizeMb?: number
  /**
   * Override per-project snapshot cap. Defaults to globalConfig
   * `checkpointsMaxSnapshotsPerProject` (or `DEFAULT_MAX_SNAPSHOTS_PER_REF`
   * if unset). Use `0` to disable the snapshot-cap pass entirely.
   * Tests use this to assert cap behavior without touching globalConfig.
   */
  maxSnapshotsPerRef?: number
  /** Bypass the `.last_prune` 24h marker. */
  forceNow?: boolean
  /**
   * When true, the orphan pass is suppressed: refs whose workdir has
   * vanished from disk are left untouched. Stale + size-cap still run.
   * Mirrors Hermes' `prune_checkpoints(delete_orphans=False)` (function
   * param) and `hermes_cli/checkpoints.py::cmd_prune --keep-orphans`
   * (CLI flag). Use case: workdir is temporarily missing (external
   * drive disconnected, in-flight rename, planned re-clone) and the
   * user wants a window to restore the path before the ref is dropped.
   * Default `false` — current behavior is the right default.
   */
  keepOrphans?: boolean
}

export interface PruneReport {
  /** True when the marker said "ran recently" and the whole pass was a no-op. */
  skipped: boolean
  /** True when git is unavailable on this host. */
  gitMissing: boolean
  /** Refs deleted because their workdir vanished. */
  orphanRefsRemoved: number
  /**
   * Project metas whose workdir is missing but were left intact because
   * `keepOrphans` was set. Always 0 when the flag is unset. Surfaces in
   * the prune output so users can see the safety valve actually fired.
   */
  orphanRefsSkipped: number
  /** Refs deleted because last_touch was outside the retention window. */
  staleRefsRemoved: number
  /**
   * Refs whose commit count was truncated by the snapshot-count pass.
   * Each ref is counted at most once even if many commits were dropped.
   */
  snapshotCapRefsTouched: number
  /** Total commits dropped across all refs during the snapshot-count pass. */
  snapshotCapCommitsDropped: number
  /** Refs whose oldest commit was dropped at least once during size cap. */
  sizeCapRefsTouched: number
  /** Total commits dropped across all refs during size cap. */
  sizeCapCommitsDropped: number
  /**
   * 6C1 anchor-keep counters. `keepRefsAnchored` rises by one per
   * (project, session) pair we wrote a `refs/axiomate/_keep/...` ref
   * for before dropping the project's main ref. `keepRefsExpired` counts
   * existing keep-refs cleaned up because their session JSONL is gone or
   * outside the keep window. `sessionsScanned` is the number of recent
   * session transcripts inspected — used by tests to assert the scan
   * actually ran when expected.
   */
  keepRefsAnchored: number
  keepRefsExpired: number
  sessionsScanned: number
  /**
   * 0/1/2 — intermediate gc runs unless we short-circuit on entry; final gc
   * runs only when `maxTotalSizeMb > 0`. Both are unconditional within their
   * branches (Hermes parity).
   */
  gcInvocations: number
  /** Bytes freed (storeBytesBefore − storeBytesAfter). May be 0 or negative on a noisy fs. */
  bytesFreed: number
  /** Per-step errors. Never throws; everything that goes wrong lands here. */
  errors: string[]
}

const EMPTY_REPORT: Omit<PruneReport, 'skipped' | 'gitMissing'> = {
  orphanRefsRemoved: 0,
  orphanRefsSkipped: 0,
  staleRefsRemoved: 0,
  snapshotCapRefsTouched: 0,
  snapshotCapCommitsDropped: 0,
  sizeCapRefsTouched: 0,
  sizeCapCommitsDropped: 0,
  keepRefsAnchored: 0,
  keepRefsExpired: 0,
  sessionsScanned: 0,
  gcInvocations: 0,
  bytesFreed: 0,
  errors: [],
}

/**
 * Run the full prune cycle. Returns a structured report — never throws.
 *
 * Phase 4 complete: passes 1+2+3 + intermediate gc + final gc + wired
 * into `backgroundHousekeeping.ts:runVerySlowOps`.
 */
export async function pruneCheckpoints(
  opts: PruneOptions = {},
): Promise<PruneReport> {
  // 1. Soft-disable when git is missing. Same pattern as createSnapshot.
  if (!(await probeGitAvailable())) {
    return { skipped: false, gitMissing: true, ...EMPTY_REPORT }
  }

  // 2. 24h idempotency marker. Hermes `maybe_auto_prune_checkpoints:1488`
  //    — read the marker, compare to now, short-circuit if too recent.
  //    Corrupt or unreadable markers are treated as "no prior run" (Hermes
  //    line 1497 swallows the parse error silently). forceNow bypasses.
  if (!opts.forceNow && isMarkerRecent()) {
    return { skipped: true, gitMissing: false, ...EMPTY_REPORT }
  }

  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS
  const maxTotalSizeMb = opts.maxTotalSizeMb ?? DEFAULT_MAX_TOTAL_SIZE_MB
  // Snapshot cap: explicit opts (tests) win, then globalConfig, then default.
  // Validate the config value so a corrupt/missing/non-numeric entry falls
  // back gracefully instead of disabling the pass or throwing on multiply.
  const maxSnapshotsPerRef = (() => {
    if (typeof opts.maxSnapshotsPerRef === 'number') return opts.maxSnapshotsPerRef
    const configured = getGlobalConfig().checkpointsMaxSnapshotsPerProject
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
      return configured
    }
    return DEFAULT_MAX_SNAPSHOTS_PER_REF
  })()
  const report: PruneReport = {
    skipped: false,
    gitMissing: false,
    ...EMPTY_REPORT,
    errors: [],
  }
  const store = getStoreDir()
  const base = getCheckpointBase()
  // Hermes `prune_checkpoints:1260` snapshots size at the very start so
  // `bytes_freed` reflects orphan + stale + size-cap together.
  const sizeBefore = dirSizeBytes(base)

  // 3. Pass 1 — orphan: workdir gone from disk → drop ref + index + meta.
  // 4. Pass 2 — stale:  last_touch outside retention window → drop too.
  //    Both passes share `loadProjectMetas` and `dropProjectRef` so the
  //    file IO + ref delete sequence is identical between them. Hermes
  //    `prune_checkpoints` interleaves them in one loop (lines 1255-1370);
  //    we split for clarity since the report fields are separate counts.
  const metas = await loadProjectMetas(report)
  const cutoffSec = retentionDays > 0
    ? Math.floor(Date.now() / 1000) - retentionDays * 86400
    : null

  // 6C1 expire pass — clean up keep-refs whose session JSONL is gone
  // or outside the keep window. Must run BEFORE the orphan/stale loop:
  // expiry depends on project metadata that the loop deletes, so going
  // last would mean every keep-ref under a freshly-orphaned project
  // gets misclassified as "project meta missing → orphan keep-ref".
  await expireKeepRefs(store, metas, report)

  for (const meta of metas) {
    // Orphan check first — wins over stale if both apply (Hermes `prune_checkpoints`::1289-1298).
    const exists = await directoryExists(meta.workdir)
    if (!exists) {
      // `keepOrphans`: short-circuit before anchoring + dropping. The
      // anchor pass is a no-op when no ref is being deleted, so skipping
      // it here is the right semantic — keep-refs are "save what we can
      // before deletion", not "always anchor". `orphanRefsSkipped` lets
      // the report surface that the safety valve fired.
      if (opts.keepOrphans === true) {
        report.orphanRefsSkipped++
        continue
      }
      // 6C1 anchor pass — before dropping a project ref, write keep-refs
      // for any recent session that still references reachable commits
      // on this ref. Errors are accumulated; failure to anchor never
      // blocks the underlying drop.
      await anchorRecentSessions(store, meta, report)
      const dropped = await dropProjectRef(store, meta, report)
      if (dropped) report.orphanRefsRemoved++
      continue
    }
    if (cutoffSec !== null && meta.last_touch < cutoffSec) {
      await anchorRecentSessions(store, meta, report)
      const dropped = await dropProjectRef(store, meta, report)
      if (dropped) report.staleRefsRemoved++
    }
  }

  // 4b. Pass 3 — per-project snapshot-count cap. For each surviving ref,
  //     rebuild to keep only the most recent N commits via pruneRefToMaxN.
  //     Mirrors the write-time ring buffer in createSnapshot.ts so users
  //     who lower their config N see existing refs shrink immediately.
  //     Runs before intermediate gc so reclaimed objects fold into the
  //     same gc that orphan/stale already trigger.
  if (maxSnapshotsPerRef > 0) {
    await runSnapshotCapPass(store, maxSnapshotsPerRef, report)
  }

  // 5. Intermediate gc — reflog expire + gc --prune=now. Runs unconditionally
  //    (Hermes `prune_checkpoints`::1375-1382). The `reflog expire --all` step makes commits
  //    unreachable so `gc --prune=now` can actually free objects.
  const gcOk = await runReflogExpireAndGc(store, report)
  if (gcOk) report.gcInvocations++

  // 6. Pass 3 — cross-project size cap. Drops oldest commits round-robin
  //    until the store is under the byte cap. Final gc inside this pass
  //    only runs when the cap actually triggered (Hermes `_enforce_size_cap`::1090-1095 early
  //    return + 1164-1171 unconditional gc within the > cap branch).
  if (maxTotalSizeMb > 0) {
    await runSizeCapPass(store, maxTotalSizeMb, report)
  }

  // 7. Compute bytes freed. Hermes `bytes_freed = max(prev, before − after)`
  //    (line 1457). Cap at 0 since a noisy fs can grow under us between
  //    the two stat passes — reporting "negative bytes freed" would
  //    confuse the user-facing /checkpoints status output more than it
  //    informs.
  const sizeAfter = dirSizeBytes(base)
  report.bytesFreed = Math.max(0, sizeBefore - sizeAfter)

  // 8. Touch marker on success. Hermes `maybe_auto_prune_checkpoints:1508`.
  await writeMarker(report)

  return report
}

/**
 * Read every `projects/<hash16>.json`. Delegates to the shared loader
 * in `projectMetas.ts` and forwards its `errors[]` into the prune
 * report. Phase 5 storeStatus uses the same loader without the report
 * indirection.
 */
async function loadProjectMetas(report: PruneReport): Promise<ProjectMeta[]> {
  const { metas, errors } = await loadProjectMetasShared()
  for (const err of errors) report.errors.push(err)
  return metas
}

/** True if the path exists on disk and is a directory. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path)
    return st.isDirectory()
  } catch {
    return false
  }
}

/**
 * Delete the ref, the index file, and the project meta for `hash`.
 * Steps are best-effort and order-independent — failure of one step
 * still tries the others. Returns true if the ref delete succeeded
 * (the load-bearing step; without it the snapshots remain reachable).
 *
 * Mirrors Hermes `_drop_project_ref` (1311-1340) — same step set,
 * same fail-soft semantics, errors collected rather than raised.
 */
async function dropProjectRef(
  store: string,
  meta: ProjectMeta,
  report: PruneReport,
): Promise<boolean> {
  const ref = refName(meta.hash)

  // 1. Delete the ref. We use the store as workTree because the
  //    project workdir may already be gone (orphan case). update-ref -d
  //    doesn't read the worktree; it only needs GIT_DIR.
  const del = await runCheckpointGit(['update-ref', '-d', ref], {
    store,
    workTree: store,
  })
  if (del.ok === false) {
    report.errors.push(`update-ref -d ${ref}: ${del.message}`)
    return false
  }

  // 2. Delete the per-project index file. Best-effort.
  await safeUnlink(indexPath(meta.hash), report)

  // 3. Delete the project meta. Best-effort.
  await safeUnlink(projectMetaPath(meta.hash), report)

  return true
}

async function safeUnlink(path: string, report: PruneReport): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return // Already gone — fine.
    report.errors.push(`unlink ${path}: ${(err as Error).message}`)
  }
}

/**
 * 6C1 anchor pass — write `refs/axiomate/_keep/<projectHash>/<sessionId>`
 * for every recent session whose JSONL transcript references at least one
 * commit reachable from this project's about-to-be-dropped ref.
 *
 * Anchors the ref's current TIP. Anchoring tip preserves every session
 * hash that's an ancestor of tip (which they all are, since they were
 * snapshotted earlier on the same chain) without needing to resolve
 * "the latest session-referenced ancestor" explicitly. Trade-off: we
 * keep slightly more history than strictly required. That's fine — the
 * keep-ref expires when the session JSONL ages out, so the cost is
 * bounded.
 *
 * Best-effort. Errors land in `report.errors`; the caller still drops
 * the project ref afterward. Failure to anchor is strictly worse than
 * succeeding, never worse than not running at all.
 */
async function anchorRecentSessions(
  store: string,
  meta: ProjectMeta,
  report: PruneReport,
): Promise<void> {
  // Fresh-install short-circuit. Mirrors the guard in `runReflogExpireAndGc`
  // (prune.ts:494) — we're called from inside the orphan/stale loop, but
  // the loop may have populated `metas` from a stale projects/ dir while
  // the store/ tree doesn't exist yet.
  if (!existsSync(store)) return

  // 1. Resolve current tip. No tip → nothing to anchor.
  const ref = refName(meta.hash)
  const tipR = await runCheckpointGit(
    ['rev-parse', '--verify', `${ref}^{commit}`],
    { store, workTree: store, allowedExitCodes: new Set([0, 128]) },
  )
  if (tipR.ok === false || tipR.code !== 0) return
  const tipSha = tipR.stdout.trim()
  if (tipSha.length === 0) return

  // 2. List recent session JSONLs for this workdir.
  const candidates = await listRecentSessionsForWorkdir(meta.workdir, {
    windowDays: DEFAULT_KEEP_WINDOW_DAYS,
  })
  report.sessionsScanned += candidates.length
  if (candidates.length === 0) return

  // 3. For each candidate, check whether ANY referenced gitHash is an
  //    ancestor of tip. If so, anchor a keep-ref at tip. We don't need
  //    to identify which hash — ancestor of tip means all session hashes
  //    on this ref's chain remain reachable.
  for (const cand of candidates) {
    const { hashes, error } = await extractGitHashes(cand.jsonlPath)
    if (error !== null) {
      report.errors.push(`session ${cand.sessionId}: ${error}`)
      continue
    }
    if (hashes.size === 0) continue

    let anchorWorthy = false
    for (const hash of hashes) {
      const ancR = await runCheckpointGit(
        ['merge-base', '--is-ancestor', hash, ref],
        { store, workTree: store, allowedExitCodes: new Set([0, 1, 128]) },
      )
      if (ancR.ok === false) continue
      if (ancR.code === 0) {
        anchorWorthy = true
        break
      }
    }
    if (!anchorWorthy) continue

    const keep = keepRefName(meta.hash, cand.sessionId)
    const upR = await runCheckpointGit(
      ['update-ref', keep, tipSha],
      { store, workTree: store },
    )
    if (upR.ok === false) {
      report.errors.push(`update-ref ${keep}: ${upR.message}`)
      continue
    }
    report.keepRefsAnchored++
  }
}

/**
 * 6C1 expire pass — clean up keep-refs whose session JSONL is gone or
 * outside the keep window. Runs once per prune cycle, before the
 * orphan/stale loop, so freshly-orphaned project metas are still
 * available to resolve the workdir → session-dir path.
 */
async function expireKeepRefs(
  store: string,
  metas: readonly ProjectMeta[],
  report: PruneReport,
): Promise<void> {
  // See guard explanation in `anchorRecentSessions`.
  if (!existsSync(store)) return

  const r = await runCheckpointGit(
    ['for-each-ref', '--format=%(refname)', KEEP_REF_PREFIX],
    { store, workTree: store, allowedExitCodes: REF_MISSING },
  )
  if (r.ok === false) {
    report.errors.push(`for-each-ref _keep: ${r.message}`)
    return
  }
  const refs = r.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  if (refs.length === 0) return

  const metaByHash = new Map(metas.map(m => [m.hash, m]))
  const cutoffSec = Math.floor(Date.now() / 1000) - DEFAULT_KEEP_WINDOW_DAYS * 86400

  for (const ref of refs) {
    const parsed = parseKeepRefName(ref)
    if (parsed === null) {
      // Corrupt ref under _keep/ — drop it. Hermes-style fail-clean.
      await deleteKeepRef(store, ref, report)
      continue
    }
    const meta = metaByHash.get(parsed.projectHash)
    if (meta === undefined) {
      // Project meta already pruned in a prior cycle; the keep-ref is
      // orphaned by definition.
      await deleteKeepRef(store, ref, report)
      continue
    }
    const candidates = await listRecentSessionsForWorkdir(meta.workdir, {
      windowDays: DEFAULT_KEEP_WINDOW_DAYS,
    })
    const live = candidates.find(c => c.sessionId === parsed.sessionId)
    if (live === undefined || live.mtimeSec < cutoffSec) {
      await deleteKeepRef(store, ref, report)
    }
  }
}

async function deleteKeepRef(
  store: string,
  ref: string,
  report: PruneReport,
): Promise<void> {
  const r = await runCheckpointGit(
    ['update-ref', '-d', ref],
    { store, workTree: store },
  )
  if (r.ok === false) {
    report.errors.push(`update-ref -d ${ref}: ${r.message}`)
    return
  }
  report.keepRefsExpired++
}

/**
 * `git reflog expire --expire=now --all` + `git gc --prune=now --quiet`.
 * Both run with 3× the default checkpoint git timeout — Hermes `prune_checkpoints`::1378
 * uses a similar long-timeout pattern.
 *
 * Returns true if both commands ran and succeeded. On failure of
 * either, collects the error and returns false. Also returns false
 * (without pushing any error) when the store directory hasn't been
 * created yet — that's a no-op, not a failure.
 */
async function runReflogExpireAndGc(
  store: string,
  report: PruneReport,
): Promise<boolean> {
  // Fresh install: nothing has called `ensureStore()` yet, so the
  // shadow-git dir doesn't exist on disk. Both `git reflog expire` and
  // `git gc` would fail with "fatal: cannot change to '<store>': No
  // such file or directory" and pollute `report.errors`, which would
  // then make the CLI `axiomate checkpoints prune` exit 1 on what is
  // really a no-op. Skip cleanly without recording an error or a gc
  // invocation.
  if (!existsSync(store)) return false

  const longTimeout = DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS * 3

  const reflog = await runCheckpointGit(
    ['reflog', 'expire', '--expire=now', '--all'],
    { store, workTree: store, timeoutMs: longTimeout },
  )
  if (reflog.ok === false) {
    report.errors.push(`reflog expire: ${reflog.message}`)
    return false
  }

  const gc = await runCheckpointGit(
    ['gc', '--prune=now', '--quiet'],
    { store, workTree: store, timeoutMs: longTimeout },
  )
  if (gc.ok === false) {
    report.errors.push(`gc: ${gc.message}`)
    return false
  }
  return true
}

/**
 * Returns true when the marker file exists and was written less than
 * `MIN_INTERVAL_HOURS` ago. Any read or parse failure → false (treat as
 * "no recent run"). Hermes `_validate_unix_time:1497` silently passes
 * through corrupt markers.
 *
 * Future-dated markers (Windows clock-granularity skew, user clock jumps)
 * are treated as recent — the safe direction is "wait for the marker to
 * age out" rather than "run prune immediately on a wonky clock".
 */
function isMarkerRecent(): boolean {
  const path = getLastPrunePath()
  if (!existsSync(path)) return false
  try {
    // Use mtime rather than file content. The marker's content has been
    // a unix timestamp string in Hermes, but mtime is what `_validate_unix_time`
    // ultimately ends up reading after parsing the body — we save a parse
    // step. Both axes (mtime + content-stamp) tell the same story.
    const st = statSync(path)
    const ageMs = Date.now() - st.mtimeMs
    const minIntervalMs = MIN_INTERVAL_HOURS * 60 * 60 * 1000
    return ageMs < minIntervalMs
  } catch {
    return false
  }
}

/**
 * Write the marker. Body is a unix-ms timestamp for human inspection;
 * `isMarkerRecent` reads mtime, not the body.
 */
async function writeMarker(report: PruneReport): Promise<void> {
  try {
    await writeFile(getLastPrunePath(), String(Date.now()), 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logForDebugging(`pruneCheckpoints: marker write failed: ${msg}`)
    report.errors.push(`marker write: ${msg}`)
  }
}

/**
 * Cross-project size cap. Drops the oldest commit from each ref in
 * round-robin fashion until the store is under `maxMb` MB or no progress
 * was made in a full round. Direct port of Hermes `prune_checkpoints`
 * size-cap branch (1385-1453).
 *
 * Per-round `droppedThisRound` reset matches Hermes line 1399 (inside the
 * outer 20-iter loop). The anti-livelock break out at line 1444-1445 is
 * the same.
 *
 * Inner-loop size measurement uses the store dir, not the base dir —
 * matches Hermes `prune_checkpoints`::1388 `_dir_size_bytes(store)`. We measure `base` only at
 * entry/exit for the user-facing `bytesFreed` field, which deliberately
 * counts everything under `~/.axiomate/checkpoints/` (including the
 * `.last_prune` marker) so it lines up with what `du` would report.
 *
 * Final gc only runs when this function actually entered (size > cap at
 * start). Hermes `prune_checkpoints`::1385 early-skip + 1446-1453 unconditional gc within the
 * `> cap_bytes` branch.
 */
async function runSizeCapPass(
  store: string,
  maxMb: number,
  report: PruneReport,
): Promise<void> {
  const capBytes = maxMb * 1024 * 1024
  // Match Hermes `prune_checkpoints`::1388 — measure the store dir for cap decisions, not base.
  // base may grow with files outside the store's control (`.last_prune` and
  // anything future tooling drops in `~/.axiomate/checkpoints/`), and the
  // cap is meant to bound what the bare repo itself holds.
  if (dirSizeBytes(store) <= capBytes) return

  logForDebugging(
    `pruneCheckpoints: size-cap triggered — store=${Math.round(dirSizeBytes(store) / (1024 * 1024))}MB cap=${maxMb}MB`,
  )

  const refs = await listProjectRefs(store, report)
  if (refs.length === 0) {
    // Nothing to trim from. Still run the final gc — the store was over
    // cap and we want any unreachable objects reclaimed regardless.
    if (await runReflogExpireAndGc(store, report)) report.gcInvocations++
    return
  }

  // Track which refs have been touched this run so the report counts
  // unique refs, not iterations.
  const touchedRefs = new Set<string>()

  for (let iter = 0; iter < SIZE_CAP_MAX_ITERATIONS; iter++) {
    if (dirSizeBytes(store) <= capBytes) break

    let droppedThisRound = false
    for (const ref of refs) {
      const dropped = await dropOldestCommitFromRef(store, ref, report)
      if (dropped) {
        droppedThisRound = true
        report.sizeCapCommitsDropped++
        touchedRefs.add(ref)
      }
    }
    if (!droppedThisRound) break
  }
  report.sizeCapRefsTouched = touchedRefs.size

  // Final gc — Hermes `prune_checkpoints`::1446-1453. Unconditional within this branch.
  if (await runReflogExpireAndGc(store, report)) report.gcInvocations++
}

/**
 * Per-project snapshot-count cap. For each surviving project ref,
 * rebuild to its last `maxN` commits via `pruneRefToMaxN`. Mirrors
 * the write-time ring buffer in `createSnapshot.ts` so lowering the
 * cap via `/config` (or `PruneOptions.maxSnapshotsPerRef`) shrinks
 * existing refs on the next prune — without this pass the new cap
 * only takes effect on the NEXT snapshot per project.
 *
 * Skips refs already removed by orphan/stale passes — uses
 * `listProjectRefs` (`for-each-ref`) so deleted refs are naturally
 * absent from the iteration set.
 *
 * Counts dropped commits by comparing rev-list count before/after
 * `pruneRefToMaxN`. `touchedRefs` is a Set so a ref counts at most
 * once per pass.
 *
 * Caller guards `maxN > 0` — `runSnapshotCapPass` does not run when
 * the cap is disabled.
 */
async function runSnapshotCapPass(
  store: string,
  maxN: number,
  report: PruneReport,
): Promise<void> {
  // Fresh-install guard: same as `runReflogExpireAndGc` — `for-each-ref`
  // against a non-existent store dir would push a cosmetic error into
  // `report.errors` and surface as exit 1 on what is a no-op.
  if (!existsSync(store)) return
  const refs = await listProjectRefs(store, report)
  if (refs.length === 0) return
  const base = getCheckpointBase()
  const touchedRefs = new Set<string>()
  for (const ref of refs) {
    const beforeResult = await runCheckpointGit(
      ['rev-list', '--count', ref],
      { store, workTree: base, allowedExitCodes: REF_MISSING },
    )
    if (beforeResult.ok === false) {
      report.errors.push(`snapshot-cap rev-list (before): ${ref}`)
      continue
    }
    const beforeCount = Number.parseInt(beforeResult.stdout.trim(), 10)
    if (!Number.isFinite(beforeCount) || beforeCount <= maxN) continue

    const newCount = await pruneRefToMaxN({
      store,
      workTree: base,
      ref,
      maxN,
    })
    if (newCount === null) {
      report.errors.push(`snapshot-cap pruneRefToMaxN: ${ref}`)
      continue
    }
    const dropped = beforeCount - newCount
    if (dropped > 0) {
      report.snapshotCapCommitsDropped += dropped
      touchedRefs.add(ref)
    }
  }
  report.snapshotCapRefsTouched = touchedRefs.size
}

/**
 * Enumerate `refs/axiomate/*` via `for-each-ref`. Returns [] on any
 * failure or when no refs exist (the store has no project commits yet).
 *
 * Filters out the 6C1 `_keep/` namespace — those refs are managed by
 * the keep-ref passes and are NOT project refs. A caller iterating this
 * list is doing per-project work (size cap rotation, etc.); pulling in
 * keep-refs would either rotate them away (defeats their purpose) or
 * mistreat them as projects.
 *
 * Pinned by `store.test.ts` "Phase 4 anchor: refs/axiomate/* enumerable"
 * — if the ref-location convention ever changes, that test fails first.
 */
async function listProjectRefs(
  store: string,
  report: PruneReport,
): Promise<string[]> {
  const r = await runCheckpointGit(
    ['for-each-ref', '--format=%(refname)', REFS_PREFIX],
    { store, workTree: store, allowedExitCodes: REF_MISSING },
  )
  if (r.ok === false) {
    report.errors.push(`for-each-ref: ${r.message}`)
    return []
  }
  return r.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .filter(s => !s.startsWith(`${KEEP_REF_PREFIX}/`))
}

/**
 * Drop the oldest commit from `ref` by rebuilding the chain without it.
 * Returns true if a commit was actually dropped, false if the ref has
 * fewer than KEEP_LAST_N_PER_REF + 1 commits left (i.e., dropping
 * would violate the keep-at-least-one invariant), or any plumbing
 * step failed.
 *
 * The chain rebuild is structurally identical to `pruneRefToMaxN`
 * (per-project ring buffer) — same `commit-tree` walk, same `update-ref`
 * at the end. Hermes `_enforce_size_cap`::1117-1159 inlines the same sequence. If we needed
 * to add a third call site (e.g. user-driven `/checkpoints clear-old`),
 * extracting `dropOldestCommitsFromRef(ref, n)` as a shared helper
 * would be the right move — Phase 4 commit 5 (optional).
 */
async function dropOldestCommitFromRef(
  store: string,
  ref: string,
  report: PruneReport,
): Promise<boolean> {
  // 1. Count commits on the ref. We use `<ref>^{commit}` rather than the
  //    bare ref name so git's revision parser cannot confuse the ref with
  //    a path of the same name. After our `update-ref` rebuild, the
  //    ref's loose file may have been replaced or moved into packed-refs;
  //    in some intermediate states, bare-name `rev-list` fails with
  //    `ambiguous argument: both revision and filename` because the
  //    workTree contains a directory at `refs/axiomate/`.
  const countR = await runCheckpointGit(
    ['rev-list', '--count', `${ref}^{commit}`],
    { store, workTree: store, allowedExitCodes: REF_MISSING },
  )
  if (countR.ok === false) {
    report.errors.push(`rev-list --count ${ref}: ${countR.message}`)
    return false
  }
  const count = Number.parseInt(countR.stdout.trim(), 10)
  if (!Number.isFinite(count) || count <= KEEP_LAST_N_PER_REF) return false

  // 2. List commits oldest → newest. Drop index 0, keep the rest. Same
  //    `^{commit}` peel as above for ambiguity-resistance.
  const listR = await runCheckpointGit(
    ['rev-list', '--reverse', `${ref}^{commit}`],
    { store, workTree: store },
  )
  if (listR.ok === false || listR.stdout.length === 0) {
    if (listR.ok === false) report.errors.push(`rev-list ${ref}: ${listR.message}`)
    return false
  }
  const commits = listR.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  const keep = commits.slice(1)
  if (keep.length === 0) return false

  // 3. Walk forward, rebuilding the chain on the original trees.
  let newParent: string | null = null
  for (const sha of keep) {
    const treeR = await runCheckpointGit(
      ['rev-parse', `${sha}^{tree}`],
      { store, workTree: store },
    )
    if (treeR.ok === false || treeR.stdout.trim().length === 0) {
      if (treeR.ok === false) report.errors.push(`rev-parse tree ${sha}: ${treeR.message}`)
      return false
    }
    const treeSha = treeR.stdout.trim()

    const subjR = await runCheckpointGit(
      ['log', '--format=%s', '-1', sha],
      { store, workTree: store },
    )
    const subject = subjR.ok === true && subjR.stdout.length > 0
      ? subjR.stdout.split('\n')[0]
      : 'checkpoint'

    const args = newParent === null
      ? ['commit-tree', treeSha, '-m', subject, '--no-gpg-sign']
      : ['commit-tree', treeSha, '-p', newParent, '-m', subject, '--no-gpg-sign']
    const ctR = await runCheckpointGit(args, { store, workTree: store })
    if (ctR.ok === false || ctR.stdout.trim().length === 0) {
      if (ctR.ok === false) report.errors.push(`commit-tree on ${ref}: ${ctR.message}`)
      return false
    }
    newParent = ctR.stdout.trim()
  }
  if (newParent === null) return false

  // 4. Repoint the ref. No CAS — concurrent snapshot writers use CAS, but
  //    prune holds no concurrent contract; if a snapshot lands during this
  //    op the worst case is the snapshot's update-ref CAS fails next turn
  //    (createSnapshot returns 'race') — which is the existing behavior.
  const upR = await runCheckpointGit(
    ['update-ref', ref, newParent],
    { store, workTree: store },
  )
  if (upR.ok === false) {
    report.errors.push(`update-ref ${ref}: ${upR.message}`)
    return false
  }
  return true
}

/**
 * Best-effort recursive byte size of `path`. Returns 0 on any error
 * (matches Hermes `_dir_size_bytes:528-540`). Synchronous because
 * the prune outer loop reads it on every iteration; switching to
 * async would force serializing 20 round-trips through the event
 * loop where the underlying syscalls are cheap.
 *
 * Exported so Phase 5 `storeStatus` can read store size without
 * duplicating the helper or re-spawning a `du`-equivalent.
 */
export function dirSizeBytes(path: string): number {
  let total = 0
  const stack: string[] = [path]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      try {
        if (ent.isDirectory()) {
          stack.push(full)
        } else if (ent.isFile()) {
          total += statSync(full).size
        }
      } catch {
        // Skip — file may have vanished mid-walk.
      }
    }
  }
  return total
}
