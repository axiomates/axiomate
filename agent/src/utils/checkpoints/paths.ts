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

/** Per-project git index file inside the shadow store. */
export function indexPath(hash: string): string {
  return join(getStoreDir(), INDEXES_DIRNAME, hash)
}

/** Per-project metadata JSON path: { workdir, created_at, last_touch }. */
export function projectMetaPath(hash: string): string {
  return join(getStoreDir(), PROJECTS_DIRNAME, `${hash}.json`)
}

/**
 * `info/exclude` is git's per-repo gitignore equivalent. We write the
 * `DEFAULT_EXCLUDES` list here every `ensureStore()` call so the file is
 * authoritative — users editing the store directly is not a supported
 * workflow.
 */
export function infoExcludePath(): string {
  return join(getStoreDir(), INFO_DIRNAME, EXCLUDE_FILENAME)
}

/**
 * Default `info/exclude` patterns for the shadow store.
 *
 * Policy (locked in design memo): snapshot only state that affects agent
 * continuity. Exclude build artifacts, caches, dependency locks, native
 * binaries, virtualenvs, secrets, and OS/IDE junk. Settings files like
 * `agent/.axiomate/settings.local.json` are deliberately *not* excluded
 * here — they are user-facing config and should be rewindable.
 *
 * Format: gitignore-style. One pattern per line. Trailing slash means
 * directory-only. `*.ext` matches at any depth (gitignore default).
 *
 * Ported from Hermes `tools/checkpoint_manager.py:DEFAULT_EXCLUDES` and
 * extended for Visual Studio C++/C#, Rust, Java/Gradle/Maven, iOS/Xcode,
 * Android/Gradle, Bun/JS toolchains, and lockfiles that aren't part of
 * agent continuity.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  // VCS — never snapshot the user's own .git/
  '.git/',
  '.hg/',
  '.svn/',

  // Dependency / package managers
  'node_modules/',
  'bower_components/',
  'jspm_packages/',
  'vendor/',
  '.pnpm-store/',
  '.yarn/',

  // Generic build output
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.parcel-cache/',
  '.vite/',

  // Visual Studio (C++ / C# / .NET) — important for Windows users
  'bin/',
  'obj/',
  '.vs/',
  '*.pdb',
  '*.ilk',
  '*.idb',
  '*.tlog',
  '*.exp',
  '*.lib',
  '*.cache',
  '*.suo',
  '*.user',
  '*.userosscache',
  '*.sln.docstates',
  // NuGet
  'packages/',
  '*.nupkg',
  '*.nuget.props',
  '*.nuget.targets',
  // ReSharper
  '_ReSharper*/',
  '*.[Rr]e[Ss]harper',
  '*.DotSettings.user',

  // Rust / Cargo
  // (target/ already covered above)
  // Cargo.lock NOT excluded — for binary crates it's part of reproducibility

  // Java / Gradle / Maven
  '.gradle/',
  '*.class',
  '*.jar',
  '*.war',
  '*.ear',
  '.mvn/',

  // Python
  '__pycache__/',
  '*.pyc',
  '*.pyo',
  '*.pyd',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.tox/',
  '*.egg-info/',
  '.eggs/',
  // Virtualenvs
  '.venv/',
  'venv/',
  'env/',
  '.python-version',

  // Caches / coverage
  '.cache/',
  'coverage/',
  '.coverage',
  '.nyc_output/',
  'htmlcov/',

  // iOS / Xcode
  '*.xcworkspace/xcuserdata/',
  '*.xcodeproj/xcuserdata/',
  'DerivedData/',
  'Pods/',

  // Android / Gradle
  'app/build/',
  '*.apk',
  '*.aab',
  '*.dex',

  // Native compiled binaries (cross-language)
  '*.so',
  '*.dylib',
  '*.dll',
  '*.o',
  '*.a',
  '*.exe',
  '*.obj',

  // Media / large binaries — bloat the store, not part of agent continuity
  '*.mp4',
  '*.mov',
  '*.mkv',
  '*.webm',
  '*.avi',
  '*.zip',
  '*.tar',
  '*.tar.gz',
  '*.tgz',
  '*.7z',
  '*.rar',
  '*.iso',
  '*.dmg',

  // Lockfiles — regenerable from manifests; not agent-continuity state
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  // Note: Cargo.lock and Gemfile.lock are intentionally NOT excluded —
  // for application-level projects they are part of reproducibility

  // Secrets (defense in depth — agent should never write these anyway)
  '.env',
  '.env.*',
  '.env.local',
  '.env.*.local',

  // OS / editor junk
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '*.swp',
  '*.swo',
  '*~',
  '.idea/',
  '.vscode/',

  // Logs
  '*.log',
  'logs/',

  // Hermes-style worktree convention — don't recursively snapshot siblings
  '.worktrees/',

  // Axiomate's own per-project agent state — not user worktree continuity.
  // Note: agent/.axiomate/settings.local.json IS rewindable (locked decision)
  // because it lives under the project's own agent/ subtree, not at root.
  // The pattern below only excludes a top-level .axiomate/ if the project
  // root happens to be Axiomate itself.
  '/.axiomate/',
] as const

