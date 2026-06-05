/**
 * Shared shadow-git checkpoint store API.
 *
 * Public surface (built up across Phase 2 commits):
 *   - ensureStore()     idempotent init of the shared store
 *   - createSnapshot()  Phase 2 follow-up
 *   - listSnapshots()   Phase 2 follow-up
 *   - rollback()        Phase 2 follow-up
 *
 * Architecture: one bare-ish repo at `~/.axiomate/checkpoints/store/`,
 * per-project ref `refs/axiomate/<hash16>`, per-project index file under
 * `indexes/<hash16>`. Git's content-addressable object DB gives us blob
 * dedup across worktrees for free — that dedup is the design driver.
 *
 * Adapted from Hermes' `_init_store` / `_register_project` family
 * (`tools/checkpoint_manager.py::_init_store / ::_register_project`).
 * The big divergence: we do not port Hermes' v1→v2 migration shim.
 * Axiomate has no v1 — the shadow-git store is the first and only
 * fileHistory backend on user installs.
 */

import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import {
  logCheckpointDiagnostic,
  quoteDiagnostic,
} from './diagnostics.js'
import { runCheckpointGit, runCheckpointGitInit } from './git.js'
import {
  DEFAULT_EXCLUDES,
  getCheckpointBase,
  getStoreDir,
  infoExcludePath,
  normalizePath,
} from './paths.js'

/**
 * Outcome of `ensureStore`. Never throws — checkpoints subsystem must
 * never block the agent. On failure, the caller (Phase 3 swap point in
 * fileHistory) treats it like a transient error: log and continue, retry
 * next turn. Mirrors Hermes' `_init_store` returning `Optional[str]` —
 * `None` for success, error string for failure.
 */
export type EnsureStoreResult =
  | { ok: true; store: string }
  | { ok: false; reason: string }

/**
 * Idempotent init of the shared shadow-git store.
 *
 * Order matters here:
 *   1. mkdir base + store + indexes/ + projects/  (bail early if a parent
 *      is unwritable — saves us a confusing git error later)
 *   2. If `HEAD` already exists, return success without re-running init.
 *      This is the hot path — every snapshot/listSnapshots/rollback call
 *      goes through `ensureStore`, and they happen many times per session.
 *   3. `git init --bare <store>` with `runCheckpointGitInit` (no
 *      GIT_WORK_TREE, since init rejects it — see gitEnv.ts).
 *   4. Repo-local config writes:
 *        - `commit.gpgsign=false` + `tag.gpgSign=false` — belt-and-
 *          suspenders. We already mute user gitconfig via
 *          GIT_CONFIG_GLOBAL=NUL, but this protects the case where a
 *          future helper sets `GIT_CONFIG_PARAMETERS` or a system
 *          attribute leaks through.
 *        - `gc.auto=0` — we run gc explicitly in Phase 4 prune, not
 *          opportunistically. Hermes does the same (line 441).
 *        - `user.email` / `user.name` — git refuses to commit without
 *          them when no global config is readable, and we've muted the
 *          global config. Distinct values from Hermes (`hermes@local`)
 *          so we can recognize axiomate commits in shared dev repos.
 *   5. `info/exclude` — write the full DEFAULT_EXCLUDES list ONCE on
 *      first init only (this whole `try { mkdir + writeFile }` block is
 *      gated by the HEAD-existence check above). Subsequent ensureStore
 *      calls early-return at step 2 and never touch the file. Matches
 *      Hermes (line 445-447 also runs only inside `_init_store`'s post-
 *      `git init` path). Implication: user edits to `info/exclude` are
 *      preserved; if we ever want to roll out new excludes, we'll need
 *      a versioned bump (excluded for now — `DEFAULT_EXCLUDES` is the
 *      one-and-only source).
 *
 * Returns `{ ok: true, store }` on success, `{ ok: false, reason }` on
 * any failure. Caller logs and proceeds without checkpoints for that
 * call. Logging is done here at debug level so failures are discoverable
 * in `~/.axiomate/debug/*.log`.
 */
export async function ensureStore(): Promise<EnsureStoreResult> {
  const store = normalizePath(getStoreDir())
  const indexesDir = join(store, 'indexes')
  const projectsDir = join(store, 'projects')
  const infoDir = join(store, 'info')

  try {
    await mkdir(store, { recursive: true })
    await mkdir(indexesDir, { recursive: true })
    await mkdir(projectsDir, { recursive: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logForDebugging(`ensureStore: mkdir failed: ${msg}`)
    logCheckpointDiagnostic(
      () =>
        `ensureStore mkdir failed store=${quoteDiagnostic(store)} ` +
        `message=${quoteDiagnostic(msg)}`,
    )
    return { ok: false, reason: `mkdir failed: ${msg}` }
  }

  // Idempotency check — Hermes line 404. `HEAD` is the marker file
  // `git init --bare` writes last, so its presence is a reliable signal
  // the prior init completed cleanly (vs. a half-initialized store
  // where init was interrupted between mkdir and HEAD write).
  if (existsSync(join(store, 'HEAD'))) {
    return { ok: true, store }
  }

  const initResult = await runCheckpointGitInit(['init', '--bare', store], {
    store,
  })
  if (initResult.ok === false) {
    logForDebugging(
      `ensureStore: git init --bare failed (reason=${initResult.reason}, ` +
        `code=${initResult.code}): ${initResult.message}`,
    )
    logCheckpointDiagnostic(
      () =>
        `ensureStore git-init failed store=${quoteDiagnostic(store)} ` +
        `reason=${initResult.reason} code=${initResult.code} ` +
        `message=${quoteDiagnostic(initResult.message)}`,
    )
    return {
      ok: false,
      reason: `git init failed: ${initResult.message}`,
    }
  }

  // Repo-local config. We don't care if any single config write fails —
  // the env-level mute (GIT_CONFIG_GLOBAL=NUL) is the primary defense.
  // But we DO care if multiple fail in a row, since that signals a
  // broken store. Track failures and bail if config is unreachable.
  const configCommands: ReadonlyArray<readonly [string, string]> = [
    ['commit.gpgsign', 'false'],
    ['tag.gpgSign', 'false'],
    ['gc.auto', '0'],
    ['user.email', 'axiomate@local'],
    ['user.name', 'Axiomate Checkpoint'],
  ]
  let configFailures = 0
  // Match Hermes (`tools/checkpoint_manager.py::_init_store`) by passing the base
  // dir (store's parent, ~/.axiomate/checkpoints) as workTree. `git config`
  // doesn't actually read the worktree, so any directory works — but using
  // `base` keeps the spawn cwd outside the bare-ish store, which is the
  // semantic Hermes settled on.
  const configWorkTree = normalizePath(getCheckpointBase())
  for (const [key, value] of configCommands) {
    const r = await runCheckpointGit(['config', key, value], {
      store,
      workTree: configWorkTree,
    })
    if (r.ok === false) {
      configFailures++
      logForDebugging(
        `ensureStore: git config ${key} failed: ${r.message}`,
      )
      logCheckpointDiagnostic(
        () =>
          `ensureStore git-config failed key=${quoteDiagnostic(key)} ` +
          `store=${quoteDiagnostic(store)} reason=${r.reason} code=${r.code} ` +
          `message=${quoteDiagnostic(r.message)}`,
      )
    }
  }
  if (configFailures === configCommands.length) {
    logCheckpointDiagnostic(
      () =>
        `ensureStore failed all repo-local git config writes store=${quoteDiagnostic(store)}`,
    )
    return {
      ok: false,
      reason: 'all repo-local git config writes failed',
    }
  }

  try {
    await mkdir(infoDir, { recursive: true })
    await writeFile(
      infoExcludePath(),
      DEFAULT_EXCLUDES.join('\n') + '\n',
      'utf-8',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logForDebugging(`ensureStore: info/exclude write failed: ${msg}`)
    logCheckpointDiagnostic(
      () =>
        `ensureStore info-exclude write failed path=${quoteDiagnostic(infoExcludePath())} ` +
        `message=${quoteDiagnostic(msg)}`,
    )
    return { ok: false, reason: `info/exclude write failed: ${msg}` }
  }

  logForDebugging(`Initialized checkpoint store at ${store}`)
  return { ok: true, store }
}
