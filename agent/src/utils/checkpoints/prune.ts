/**
 * `pruneCheckpoints` — auto-maintenance for the shadow-git store.
 *
 * Runs three passes against `~/.axiomate/checkpoints/store/`:
 *   1. Orphan — drop refs whose project workdir no longer exists on disk.
 *   2. Stale  — drop refs whose `last_touch` is older than `retentionDays`.
 *   3. Size   — while total store size exceeds `maxTotalSizeMb`, drop the
 *               oldest commit per ref (round-robin) until under cap or no
 *               progress made in a full round.
 *
 * Followed (or interleaved) by `git reflog expire --expire=now --all` +
 * `git gc --prune=now --quiet` (3× timeout). gc runs unconditionally
 * after pass 1+2 and at the end of pass 3 — Hermes 1375-1382 / 1446-1452.
 *
 * Triggered async from `backgroundHousekeeping.ts:runVerySlowOps()` once
 * the user has been idle ≥1 minute and ≥10 minutes after boot. `bareMode`
 * (`--print` and similar) skips the whole housekeeping stack, so prune
 * never runs in non-interactive sessions.
 *
 * Idempotency throttle: writes `~/.axiomate/checkpoints/.last_prune` on
 * success. Subsequent calls within `MIN_INTERVAL_HOURS` short-circuit
 * unless `forceNow=true`. Hermes `maybe_auto_prune_checkpoints:1462-1525`.
 *
 * Fail-open contract: never throws. Per-step failures collect into
 * `report.errors[]`; the caller (`runVerySlowOps`) ignores the report
 * and just lets the next housekeeping cycle retry.
 */

import { existsSync, readdirSync, statSync, type Dirent } from 'fs'
import { readdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
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
  projectMetaPath,
  refName,
} from './paths.js'

/**
 * Hard upper bound on size-cap drop iterations. Matches Hermes 1113.
 * Defends against pathological cases where dropping commits doesn't
 * shrink the store fast enough to converge in finite time.
 */
const SIZE_CAP_MAX_ITERATIONS = 20

/**
 * Minimum commits kept per ref during size-cap. We never want to delete
 * a project's *last* snapshot (would lose all rewindability). Hermes
 * line 1126-1127 enforces the same invariant.
 */
const KEEP_LAST_N_PER_REF = 1

const REF_MISSING = new Set([128])
const REFS_PREFIX = 'refs/axiomate'

/**
 * Default retention for stale-pass (days). 14d is a deliberate divergence
 * from Hermes' 7d — Axiomate sessions tend to span longer dogfood arcs and
 * losing rewindability after a week is a sharp UX regression. Re-evaluate
 * after dogfood data lands.
 */
export const DEFAULT_RETENTION_DAYS = 14

/**
 * Default cross-project size cap (MB). Mirrors Hermes' typical operator
 * default; bounded by the per-project ring buffer (MAX_SNAPSHOTS=100) so
 * the cap rarely triggers in normal use.
 */
export const DEFAULT_MAX_TOTAL_SIZE_MB = 500

/**
 * Minimum interval between auto-prune runs. 24h matches Hermes
 * `maybe_auto_prune_checkpoints` default and is the throttle that keeps
 * the maintenance hook cheap on every boot.
 */
export const MIN_INTERVAL_HOURS = 24

export interface PruneOptions {
  /** Override default 14-day retention. Use `0` to disable stale pass. */
  retentionDays?: number
  /** Override default 500 MB cap. Use `0` to disable size pass. */
  maxTotalSizeMb?: number
  /** Bypass the `.last_prune` 24h marker. */
  forceNow?: boolean
}

export interface PruneReport {
  /** True when the marker said "ran recently" and the whole pass was a no-op. */
  skipped: boolean
  /** True when git is unavailable on this host. */
  gitMissing: boolean
  /** Refs deleted because their workdir vanished. */
  orphanRefsRemoved: number
  /** Refs deleted because last_touch was outside the retention window. */
  staleRefsRemoved: number
  /** Refs whose oldest commit was dropped at least once during size cap. */
  sizeCapRefsTouched: number
  /** Total commits dropped across all refs during size cap. */
  sizeCapCommitsDropped: number
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
  staleRefsRemoved: 0,
  sizeCapRefsTouched: 0,
  sizeCapCommitsDropped: 0,
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

  for (const meta of metas) {
    // Orphan check first — wins over stale if both apply (Hermes 1289-1298).
    const exists = await directoryExists(meta.workdir)
    if (!exists) {
      const dropped = await dropProjectRef(store, meta, report)
      if (dropped) report.orphanRefsRemoved++
      continue
    }
    if (cutoffSec !== null && meta.last_touch < cutoffSec) {
      const dropped = await dropProjectRef(store, meta, report)
      if (dropped) report.staleRefsRemoved++
    }
  }

  // 5. Intermediate gc — reflog expire + gc --prune=now. Runs unconditionally
  //    (Hermes 1375-1382). The `reflog expire --all` step makes commits
  //    unreachable so `gc --prune=now` can actually free objects.
  const gcOk = await runReflogExpireAndGc(store, report)
  if (gcOk) report.gcInvocations++

  // 6. Pass 3 — cross-project size cap. Drops oldest commits round-robin
  //    until the store is under the byte cap. Final gc inside this pass
  //    only runs when the cap actually triggered (Hermes 1090-1095 early
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

interface ProjectMeta {
  hash: string
  workdir: string
  created_at: number
  last_touch: number
}

/**
 * Read every `projects/<hash16>.json`. Corrupt or unreadable files are
 * pushed into `report.errors` and skipped — never throw, never lose
 * other projects to one bad file. Mirrors Hermes `_load_projects:1233-1252`.
 */
async function loadProjectMetas(report: PruneReport): Promise<ProjectMeta[]> {
  const projectsDir = join(getStoreDir(), 'projects')
  let entries: string[]
  try {
    entries = await readdir(projectsDir)
  } catch (err) {
    // Missing projects/ dir means no snapshots ever taken — not an error.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      report.errors.push(`readdir projects: ${(err as Error).message}`)
    }
    return []
  }

  const metas: ProjectMeta[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const hash = entry.slice(0, -'.json'.length)
    if (hash.length !== 16) continue // Defensive — projectHash is fixed-width.
    const path = join(projectsDir, entry)
    try {
      const raw = await readFile(path, 'utf-8')
      const obj = JSON.parse(raw) as Partial<ProjectMeta>
      if (
        typeof obj.workdir === 'string' &&
        typeof obj.created_at === 'number' &&
        typeof obj.last_touch === 'number'
      ) {
        metas.push({
          hash,
          workdir: obj.workdir,
          created_at: obj.created_at,
          last_touch: obj.last_touch,
        })
      } else {
        report.errors.push(`malformed meta: ${entry}`)
      }
    } catch (err) {
      report.errors.push(`read meta ${entry}: ${(err as Error).message}`)
    }
  }
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
 * `git reflog expire --expire=now --all` + `git gc --prune=now --quiet`.
 * Both run with 3× the default checkpoint git timeout — Hermes 1378
 * uses a similar long-timeout pattern.
 *
 * Returns true if both commands succeeded. On failure of either,
 * collects the error and returns false (gc invocation does not count
 * toward `report.gcInvocations`).
 */
async function runReflogExpireAndGc(
  store: string,
  report: PruneReport,
): Promise<boolean> {
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
 * matches Hermes 1388 `_dir_size_bytes(store)`. We measure `base` only at
 * entry/exit for the user-facing `bytesFreed` field, which deliberately
 * counts everything under `~/.axiomate/checkpoints/` (including the
 * `.last_prune` marker) so it lines up with what `du` would report.
 *
 * Final gc only runs when this function actually entered (size > cap at
 * start). Hermes 1385 early-skip + 1446-1453 unconditional gc within the
 * `> cap_bytes` branch.
 */
async function runSizeCapPass(
  store: string,
  maxMb: number,
  report: PruneReport,
): Promise<void> {
  const capBytes = maxMb * 1024 * 1024
  // Match Hermes 1388 — measure the store dir for cap decisions, not base.
  // base may grow with files outside the store's control (`.last_prune`,
  // future legacy archives), and Hermes deliberately bounds the cap to
  // what the bare repo itself holds.
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

  // Final gc — Hermes 1446-1453. Unconditional within this branch.
  if (await runReflogExpireAndGc(store, report)) report.gcInvocations++
}

/**
 * Enumerate `refs/axiomate/*` via `for-each-ref`. Returns [] on any
 * failure or when no refs exist (the store has no project commits yet).
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
 * at the end. Hermes 1117-1159 inlines the same sequence. If we needed
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
 */
function dirSizeBytes(path: string): number {
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
