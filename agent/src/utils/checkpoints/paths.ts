/**
 * Path helpers for the shadow-git checkpoint store.
 *
 * Layout (see docs/checkpoints-v2-design.md):
 *   ~/.axiomate/checkpoints/
 *     store/                          ← single bare-ish git repo
 *       refs/axiomate/<hash16>        ← per-project branch tip
 *       indexes/<hash16>              ← per-project git index
 *       projects/<hash16>.json        ← {workdir, created_at, last_touch}
 *       info/exclude
 *     .last_prune
 *
 * <hash16> = sha256(absoluteWorkdir).slice(0, 16). Same project across N
 * worktrees → same hash → same ref → blob dedup is automatic.
 */

import { createHash } from 'crypto'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { getConfigHomeDir } from '../envUtils.js'

const CHECKPOINTS_DIRNAME = 'checkpoints'
const STORE_DIRNAME = 'store'
const INDEXES_DIRNAME = 'indexes'
const PROJECTS_DIRNAME = 'projects'
const INFO_DIRNAME = 'info'
const EXCLUDE_FILENAME = 'exclude'
const REF_PREFIX = 'refs/axiomate'
const LAST_PRUNE_FILENAME = '.last_prune'
const METRICS_FILENAME = 'metrics.jsonl'

/**
 * Root of the checkpoints subsystem under ~/.axiomate/.
 *
 * **Test isolation**: honors `AXIOMATE_CHECKPOINT_BASE` env var (Decision #12,
 * 2026-05-21). Tests set it to a tmpdir in `beforeAll` so the real
 * `~/.axiomate/checkpoints/` is never touched. Production code path
 * unchanged when the env var is unset. Mirrors Hermes' `CHECKPOINT_BASE`
 * module-level override.
 *
 * The override is read on every call (not cached) so a test process can
 * mutate `process.env` without re-importing — vitest does this between
 * `beforeAll`/`afterAll` blocks and we want each block's env to take effect.
 * The cost is negligible: one env lookup per checkpoint git invocation.
 */
export function getCheckpointBase(): string {
  const override = process.env.AXIOMATE_CHECKPOINT_BASE
  if (override && override.length > 0) {
    return normalizePath(override)
  }
  return join(getConfigHomeDir(), CHECKPOINTS_DIRNAME)
}

/** Bare-ish shadow git repo. */
export function getStoreDir(): string {
  return join(getCheckpointBase(), STORE_DIRNAME)
}

/** Marker file for 24h auto-prune idempotency. */
export function getLastPrunePath(): string {
  return join(getCheckpointBase(), LAST_PRUNE_FILENAME)
}

/**
 * Append-only JSONL ring buffer of recent snapshot outcomes (one row per
 * `createSnapshot` invocation). Capped at ~100 entries by the metrics
 * module — see `metrics.ts`. Sits at the checkpoints base (not inside
 * `store/`) because it's axiomate observability, not a git artifact, and
 * `git fsck` shouldn't see it.
 */
export function getMetricsPath(): string {
  return join(getCheckpointBase(), METRICS_FILENAME)
}

/**
 * Canonical absolute path for any user-supplied workdir-like string.
 *
 * Direct port of Hermes' `_normalize_path` (`tools/checkpoint_manager.py::_normalize_path` —
 * `Path(value).expanduser().resolve()`). Hermes calls this at every API
 * entry point — validators, hashers, env builders, metadata writers — so
 * downstream code never has to think about tildes, relative bits, or `..`.
 *
 * We mirror that strategy: `validateRelativePath` and the Phase 2 store
 * API boundary route every workdir-shaped input through this function
 * before doing anything that depends on path identity (hashing, comparing,
 * writing metadata).
 *
 * Behavior:
 *   - Leading `~` → user home (`~`, `~/foo`; `~user` is NOT supported, same
 *     as Hermes — Python's `expanduser` does support it, but it's vanishingly
 *     rare in practice and Node has no equivalent).
 *   - `path.resolve()` against process.cwd() handles relative input.
 *   - No filesystem access — symlinks are not followed (`realpath`-free).
 */
export function normalizePath(value: string): string {
  let v = value
  if (v === '~') {
    v = homedir()
  } else if (v.startsWith('~/') || v.startsWith('~\\')) {
    v = join(homedir(), v.slice(2))
  }
  return resolve(v)
}

/**
 * Stable 16-hex-char identifier for a project derived from its absolute
 * worktree path. Two worktrees of the same project (same abs path) collide
 * intentionally so blobs dedup; a worktree at a different abs path is a
 * different project.
 *
 * IMPORTANT contract: callers MUST pass an already-resolved absolute path
 * (e.g. `path.resolve(workdir)`). This function is a pure value-layer
 * function and does not canonicalize for you. Hashing `'C:\\proj\\.\\sub'`
 * vs `'C:\\proj\\sub'` would produce two different hashes — silently
 * breaking blob dedup. Phase 2 store API enforces normalization at its
 * boundary; downstream of that, hashes are stable.
 *
 * Case sensitivity is intentionally preserved: `/Proj/foo` and `/proj/foo`
 * are treated as distinct projects (see paths.test.ts:30-34). On
 * case-insensitive filesystems the user's actual abs path is what we get,
 * and we trust the OS to give us a single canonical form per real project.
 */
export function projectHash(absoluteWorkdir: string): string {
  return createHash('sha256').update(absoluteWorkdir).digest('hex').slice(0, 16)
}

/** Branch ref name for this project inside the shadow store. */
export function refName(hash: string): string {
  return `${REF_PREFIX}/${hash}`
}

/**
 * Namespace prefix for 6C1 anchor-keep refs. These protect snapshots
 * referenced by recent session JSONLs from being orphan/stale-pruned.
 *
 * The prefix is intentionally NOT 16-hex so it never collides with
 * `refs/axiomate/<hash16>` project refs. Walks that assume "all refs
 * under refs/axiomate are project refs" must filter this prefix out
 * (see `prune.ts::listProjectRefs`).
 */
export const KEEP_REF_PREFIX = `${REF_PREFIX}/_keep`
export const ACTIVE_REF_PREFIX = `${REF_PREFIX}/_active`

/**
 * Anchor-keep ref name: `refs/axiomate/_keep/<projectHash16>/<sessionId>`.
 *
 * `<projectHash16>` is the same identifier used for the live project ref
 * — embedding it here lets the expire pass derive the owning project from
 * the ref name alone, no fan-out scan. `<sessionId>` is the axiomate
 * session UUID. One keep-ref per (project, session) pair.
 */
export function keepRefName(projectHash: string, sessionId: string): string {
  return `${KEEP_REF_PREFIX}/${projectHash}/${sessionId}`
}

export function activeRewindRefName(projectHash: string, token: string): string {
  return `${ACTIVE_REF_PREFIX}/${projectHash}/${token}`
}

export function parseActiveRewindRefName(
  ref: string,
): { projectHash: string; token: string; createdAtMs: number } | null {
  if (!ref.startsWith(`${ACTIVE_REF_PREFIX}/`)) return null
  const tail = ref.slice(ACTIVE_REF_PREFIX.length + 1)
  const slash = tail.indexOf('/')
  if (slash < 0) return null
  const projectHash = tail.slice(0, slash)
  const token = tail.slice(slash + 1)
  if (projectHash.length !== 16 || !/^[0-9a-f]{16}$/.test(projectHash)) return null
  if (token.length === 0) return null
  const dash = token.indexOf('-')
  if (dash <= 0) return null
  const createdAtMs = Number.parseInt(token.slice(0, dash), 10)
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null
  return { projectHash, token, createdAtMs }
}

/**
 * Inverse of `keepRefName`. Returns null on any shape mismatch — corrupt
 * refs that somehow landed under `_keep/` are skipped, not crashed-on.
 *
 * Validates `projectHash` is exactly 16 hex chars (matches `projectHash`
 * output) so a typo'd ref like `_keep/wat/foo` doesn't escape detection.
 */
export function parseKeepRefName(
  ref: string,
): { projectHash: string; sessionId: string } | null {
  if (!ref.startsWith(`${KEEP_REF_PREFIX}/`)) return null
  const tail = ref.slice(KEEP_REF_PREFIX.length + 1)
  const slash = tail.indexOf('/')
  if (slash < 0) return null
  const projectHash = tail.slice(0, slash)
  const sessionId = tail.slice(slash + 1)
  if (projectHash.length !== 16 || !/^[0-9a-f]{16}$/.test(projectHash)) return null
  if (sessionId.length === 0) return null
  return { projectHash, sessionId }
}

/** Per-project git index file inside the shadow store. */
export function indexPath(hash: string): string {
  return join(getStoreDir(), INDEXES_DIRNAME, hash)
}

/** Per-project metadata JSON path: { workdir, created_at, last_touch }. */
export function projectMetaPath(hash: string): string {
  return join(getStoreDir(), PROJECTS_DIRNAME, `${hash}.json`)
}

/**
 * `info/exclude` is git's per-repo gitignore equivalent. It intentionally
 * contains only the tiny defaults below so `git check-ignore` can evaluate
 * user `.gitignore` files without reintroducing broad checkpoint-specific
 * exclusions.
 */
export function infoExcludePath(): string {
  return join(getStoreDir(), INFO_DIRNAME, EXCLUDE_FILENAME)
}

/**
 * Minimal default exclude patterns for the shadow store.
 *
 * Policy: checkpointing primarily follows the user's own `.gitignore`.
 * These defaults only cover VCS metadata, dependency trees that are almost
 * never useful for rewind, and tiny OS junk files. Build outputs, logs,
 * framework caches, lockfiles, secrets, and language-specific artifacts are
 * included unless the user explicitly ignores them.
 *
 * Format: gitignore-style. One pattern per line. Trailing slash means
 * directory-only. `*.ext` matches at any depth (gitignore default).
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  // VCS metadata — skipped by collectCheckpointFiles as hard metadata too.
  '.git/',
  '.hg/',
  '.svn/',

  // Dependency trees. Project-specific generated outputs should live in
  // the user's own .gitignore instead of this global checkpoint list.
  'node_modules/',

  // OS / editor junk
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
] as const
