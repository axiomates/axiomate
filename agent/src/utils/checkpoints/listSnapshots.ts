/**
 * `listSnapshots` — read the per-project ref backwards (newest → oldest)
 * and return structured entries for `/checkpoints list` and Phase 6 UX.
 *
 * Direct port of Hermes `list_checkpoints` (`tools/checkpoint_manager.py::CheckpointManager.list_checkpoints`).
 *
 * Parity with Hermes:
 *   - `git log <ref> --format=%H|%h|%aI|%s -n <max>` with allowedExitCodes
 *     {128, 129} so a not-yet-existing ref is treated as "no snapshots"
 *     rather than an error.
 *   - For each commit, `git diff --shortstat <hash>~1 <hash>` to populate
 *     filesChanged / insertions / deletions. Hermes runs these serially
 *     (line 688); we run them in parallel via `Promise.all` for latency.
 *   - The first (root) commit has no `<hash>~1` so the diff returns 128
 *     and the stat fields stay at 0 — same fail-open behavior as Hermes.
 *
 * Above-Hermes addition: `reason` is parsed via `parseCommitSubject` so
 * UI consumers can distinguish structured `axiomate:msgid:label` subjects
 * from raw subjects without re-parsing on the consumer side. Decision #14.
 *
 * Returns `[]` (not an error) on any failure path — store missing,
 * git failure, ref absent. Checkpoints subsystem must never block, and
 * "no snapshots to list" is a valid state.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { runCheckpointGit } from './git.js'
import {
  getStoreDir,
  normalizePath,
  projectHash,
  refName,
} from './paths.js'
import { parseCommitSubject, type ParsedReason } from './reason.js'
import { ensureStore } from './store.js'

/** Default page size — matches Hermes `_max_snapshots = 100`. */
export const LIST_DEFAULT_LIMIT = 100

/** {128: ref doesn't exist, 129: bad arg / unknown ref form} → empty list. */
const REF_NOT_PRESENT = new Set([128, 129])

export interface SnapshotEntry {
  /** Full SHA-1, 40 hex chars. */
  hash: string
  /** Abbreviated SHA, length controlled by git's `core.abbrev` (default 7). */
  shortHash: string
  /** Author timestamp in ISO 8601 with timezone (`%aI`). */
  timestamp: string
  /** Raw commit subject as stored. */
  subject: string
  /** Parsed structured form — `kind: 'axiomate'` for our own commits. */
  reason: ParsedReason
  /** From `git diff --shortstat`; 0 for the root commit (no parent diff). */
  filesChanged: number
  /** From `git diff --shortstat`. */
  insertions: number
  /** From `git diff --shortstat`. */
  deletions: number
}

export interface ListSnapshotsOptions {
  /** Hard cap on rows returned. Default `LIST_DEFAULT_LIMIT`. */
  limit?: number
  /**
   * If `false`, skip the per-commit `git diff --shortstat` invocations.
   * Saves N spawns on a list-only consumer that doesn't care about
   * change stats (Phase 6 resume integration may want this). Default `true`.
   */
  withStats?: boolean
}

/**
 * List snapshots for `workdir`, newest first.
 *
 * Never throws; returns `[]` on any failure (no store, no ref, git error).
 * The snapshot subsystem is best-effort — a missing list is no worse than
 * an empty list from the caller's POV.
 */
export async function listSnapshots(
  workdir: string,
  opts: ListSnapshotsOptions = {},
): Promise<SnapshotEntry[]> {
  const limit = opts.limit ?? LIST_DEFAULT_LIMIT
  const withStats = opts.withStats ?? true
  if (limit <= 0) return []

  const canonical = normalizePath(workdir)
  const storeDir = getStoreDir()

  // Hermes `list_checkpoints`::662 short-circuits on missing HEAD before calling git. Mirror
  // that — saves one spawn for the common "first run, no checkpoints yet"
  // case on machines where the user has never used /checkpoints.
  if (!existsSync(join(storeDir, 'HEAD'))) {
    return []
  }

  // ensureStore is cheap when HEAD already exists (idempotency check at
  // line 97), but we still call it so an upstream test or first-use path
  // that reaches listSnapshots before any snapshot has the store materialized.
  const storeResult = await ensureStore()
  if (storeResult.ok === false) {
    logForDebugging(
      `listSnapshots: ensureStore failed: ${storeResult.reason}`,
    )
    return []
  }
  const store = storeResult.store

  const ref = refName(projectHash(canonical))

  const logResult = await runCheckpointGit(
    ['log', ref, '--format=%H|%h|%aI|%s', '-n', String(limit)],
    {
      store,
      workTree: canonical,
      allowedExitCodes: REF_NOT_PRESENT,
    },
  )
  if (logResult.ok === false) {
    logForDebugging(`listSnapshots: git log failed: ${logResult.message}`)
    return []
  }
  // ref exists but is empty (just-pruned, just-created store): both empty
  // stdout and a non-zero exit caught by allowedExitCodes land here.
  if (logResult.stdout.length === 0) return []

  const rows = logResult.stdout
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => parseLogLine(line))
    .filter((row): row is SnapshotEntry => row !== null)

  if (!withStats) return rows

  // One git log --shortstat instead of N per-row diffs. Saves N-1 spawns.
  // On Windows ~40ms per spawn × N anchors is the dominant picker latency
  // cost; this batched form is sub-50ms regardless of N. Parses output
  // shape:
  //   commit <hash>
  //    N files changed, M insertions(+), K deletions(-)
  // The custom format `--format=---%H` makes the per-commit boundary
  // unambiguous and lets us skip the default header entirely. A row with
  // zero diff (root commit, or empty diff) gets no shortstat line — left
  // at zero, matching the per-row fallback behavior.
  const statResult = await runCheckpointGit(
    [
      'log',
      ref,
      '--shortstat',
      '--format=---%H',
      '-n',
      String(limit),
    ],
    {
      store,
      workTree: canonical,
      allowedExitCodes: REF_NOT_PRESENT,
    },
  )
  if (statResult.ok === false) {
    logForDebugging(`listSnapshots: shortstat fetch failed: ${statResult.message}`)
    return rows
  }
  applyBatchedShortstat(statResult.stdout, rows)

  return rows
}

/**
 * Parse one `--format=%H|%h|%aI|%s` line into a SnapshotEntry. Returns
 * null on malformed lines so a single bad row can't kill the whole list.
 *
 * `subject` is allowed to contain `|` (the `--format` produces exactly 3
 * separators before %s). We split with limit 4 — `parts[3]` is the
 * unsplit remainder.
 */
function parseLogLine(line: string): SnapshotEntry | null {
  const parts = splitMax(line, '|', 4)
  if (parts.length !== 4) return null
  const [hash, shortHash, timestamp, subject] = parts
  if (hash.length === 0 || shortHash.length === 0) return null
  return {
    hash,
    shortHash,
    timestamp,
    subject,
    reason: parseCommitSubject(subject),
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  }
}

/**
 * Split `s` on `delim` into at most `n` parts. `String.prototype.split`
 * truncates instead of preserving the remainder, which would silently
 * lose subjects containing literal `|` characters. Mirrors Python's
 * `str.split(sep, maxsplit=n-1)` behavior used by Hermes line 677.
 */
function splitMax(s: string, delim: string, n: number): string[] {
  const out: string[] = []
  let rest = s
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.indexOf(delim)
    if (idx < 0) {
      out.push(rest)
      return out
    }
    out.push(rest.slice(0, idx))
    rest = rest.slice(idx + delim.length)
  }
  out.push(rest)
  return out
}

/**
 * Parse `git log --shortstat --format=---<hash>` output into the rows.
 * Walks the stdout once, tracking the current commit (set when seeing
 * `---<hash>`) and applying any subsequent shortstat line to that
 * commit's row.
 *
 * Output shape (whitespace varies):
 *   ---<hash1>
 *
 *    3 files changed, 12 insertions(+), 4 deletions(-)
 *   ---<hash2>
 *   ---<hash3>
 *
 *    1 file changed, 2 insertions(+)
 *
 * Commits with no diff (root commit, empty diff) have no shortstat
 * line — left at the parseLogLine default of 0/0/0.
 */
function applyBatchedShortstat(stdout: string, rows: SnapshotEntry[]): void {
  const byHash = new Map<string, SnapshotEntry>()
  for (const row of rows) byHash.set(row.hash, row)

  let currentRow: SnapshotEntry | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('---')) {
      const hash = line.slice(3).trim()
      currentRow = byHash.get(hash)
      continue
    }
    if (!currentRow) continue
    if (!line.includes('changed')) continue
    applyShortstat(line, currentRow)
    currentRow = undefined // one shortstat per commit; defensive reset
  }
}

/**
 * Parse `git diff --shortstat` output into the entry's stat fields.
 *
 * Shape: ` 3 files changed, 12 insertions(+), 4 deletions(-)`. Any
 * field can be absent (single insertion → `1 insertion(+)`), so we
 * regex each independently. Hermes `list_checkpoints`::699-709 same shape.
 */
function applyShortstat(stat: string, entry: SnapshotEntry): void {
  const filesMatch = stat.match(/(\d+) files? changed/)
  if (filesMatch) entry.filesChanged = Number.parseInt(filesMatch[1], 10)
  const insMatch = stat.match(/(\d+) insertions?\(\+\)/)
  if (insMatch) entry.insertions = Number.parseInt(insMatch[1], 10)
  const delMatch = stat.match(/(\d+) deletions?\(-\)/)
  if (delMatch) entry.deletions = Number.parseInt(delMatch[1], 10)
}
