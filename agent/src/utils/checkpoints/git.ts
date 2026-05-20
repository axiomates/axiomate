/**
 * `runCheckpointGit` — thin wrapper around `execFileNoThrow(gitExe(), ...)`
 * that injects the isolated `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` env
 * built by `gitEnv.ts`, applies a configurable timeout, and returns a typed
 * result that callers can pattern-match on without try/catch.
 *
 * Mirrors Hermes' `_run_git()` (`tools/checkpoint_manager.py:282-332`):
 *   - silent on success
 *   - structured failure (timeout vs non-zero exit vs git-not-found)
 *   - never throws
 *
 * Spawn pattern: direct `git.exe` (or `git`) with array args. We never go
 * through a shell, so there's no path-quoting hazard, no glob expansion
 * surprises, and no dependency on git-bash being available for *this* code
 * path. Same approach as `context.ts:50` and `hooks/fileSuggestions.ts:267`.
 */

import { stat } from 'fs/promises'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import {
  checkpointGitEnv,
  checkpointInitEnv,
  type CheckpointGitEnvOptions,
} from './gitEnv.js'
import { normalizePath } from './paths.js'

/**
 * Default timeout for checkpoint git invocations (milliseconds).
 *
 * 30s matches Hermes' `_GIT_TIMEOUT` default. Most operations complete in
 * tens of ms; the timeout exists for AV-scan stalls on Windows, slow disks,
 * and the rare large-monorepo `git add -A`. `git gc` callers should pass
 * a longer timeout explicitly.
 */
export const DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS = 30_000

/**
 * Override default via `AXIOMATE_CHECKPOINT_TIMEOUT` (seconds, like Hermes).
 * Bounded [10s, 600s] so a malformed env value can't disable the safety net.
 */
function resolveTimeoutMs(): number {
  const raw = process.env.AXIOMATE_CHECKPOINT_TIMEOUT
  if (!raw) return DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS
  const seconds = Number.parseInt(raw, 10)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS
  }
  const clamped = Math.max(10, Math.min(600, seconds))
  return clamped * 1000
}

/** Outcome of a checkpoint git invocation. Never thrown. */
export type CheckpointGitResult =
  | { ok: true; stdout: string; stderr: string }
  | {
      ok: false
      reason: 'non-zero-exit' | 'timeout' | 'git-not-found' | 'spawn-error'
      code: number
      stdout: string
      stderr: string
      message: string
    }

export interface RunCheckpointGitOptions extends CheckpointGitEnvOptions {
  /** Override default 30s timeout. */
  timeoutMs?: number
  /**
   * Exit codes other than 0 that should still be treated as `ok: true`.
   * Useful for plumbing commands like `git diff-index --quiet` (returns 1
   * when there are differences — that's success for "are there changes?")
   * or `rev-parse --verify` against a not-yet-existing ref (128).
   */
  allowedExitCodes?: ReadonlySet<number>
  /** Stdin to feed the process. Only used for a couple of plumbing paths. */
  input?: string
}

/**
 * Run `git <args>` against the shadow store with full isolation.
 *
 * Returns a discriminated union — callers should handle `result.ok` first
 * before reading stdout/stderr. Errors are *never* thrown, matching the
 * "checkpoints must never block the agent" contract.
 *
 * Pre-flight: validates that `workTree` exists and is a directory before
 * spawning. Mirrors Hermes' `_run_git` (`tools/checkpoint_manager.py:287-295`)
 * which catches the case where workdir was deleted between calls (e.g.
 * `rm -rf` from BashTool against the agent's own cwd) and returns a clean
 * error string instead of git's confusing "fatal: not a git repository".
 */
export async function runCheckpointGit(
  args: string[],
  opts: RunCheckpointGitOptions,
): Promise<CheckpointGitResult> {
  // Canonicalize once at the boundary. Mirrors Hermes `_run_git:287` —
  // every downstream consumer (pre-flight stat, GIT_WORK_TREE, spawn cwd)
  // sees the same canonical path. Without this, a caller passing `~/proj`
  // would land a literal `~` in GIT_WORK_TREE *and* in spawn cwd; Node
  // does not tilde-expand at the chdir syscall, so spawn would fail.
  const workTree = normalizePath(opts.workTree)
  const workdirCheck = await ensureWorkTree(workTree)
  if (workdirCheck) return workdirCheck

  const env = checkpointGitEnv({
    store: opts.store,
    workTree,
    indexFile: opts.indexFile,
  })
  // Align cwd with GIT_WORK_TREE so cwd-relative git operations (some
  // hooks, plumbing edge cases) see the same directory the env points at.
  // Hermes does the same (`_run_git` line 307: `cwd=str(normalized_working_dir)`).
  return runWithEnv(args, env, opts, workTree)
}

/**
 * Variant for `git init --bare` and friends that reject GIT_WORK_TREE.
 * Same isolation, no worktree binding.
 */
export async function runCheckpointGitInit(
  args: string[],
  opts: {
    store: string
    timeoutMs?: number
    allowedExitCodes?: ReadonlySet<number>
  },
): Promise<CheckpointGitResult> {
  const env = checkpointInitEnv({ store: opts.store })
  // No cwd: init operates on the bare store, the parent process's cwd
  // doesn't matter, and forcing a cwd that may not exist (the user's
  // workdir might still be the agent boot dir) is just noise.
  return runWithEnv(args, env, opts, undefined)
}

/**
 * Pre-flight check: workTree exists and is a directory. Returns null on
 * success, a typed failure result on missing/wrong-type. Hermes-style
 * (lines 287-295) — better diagnostics than letting git fail with
 * "not a git repository" when the actual problem is a deleted workdir.
 */
async function ensureWorkTree(
  workTree: string,
): Promise<CheckpointGitResult | null> {
  try {
    const st = await stat(workTree)
    if (!st.isDirectory()) {
      return {
        ok: false,
        reason: 'spawn-error',
        code: -1,
        stdout: '',
        stderr: '',
        message: `working directory is not a directory: ${workTree}`,
      }
    }
    return null
  } catch {
    return {
      ok: false,
      reason: 'spawn-error',
      code: -1,
      stdout: '',
      stderr: '',
      message: `working directory not found: ${workTree}`,
    }
  }
}

async function runWithEnv(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: {
    timeoutMs?: number
    allowedExitCodes?: ReadonlySet<number>
    input?: string
  },
  cwd: string | undefined,
): Promise<CheckpointGitResult> {
  const timeout = opts.timeoutMs ?? resolveTimeoutMs()
  const exe = gitExe()
  const result = await execFileNoThrowWithCwd(exe, args, {
    env,
    timeout,
    preserveOutputOnError: true,
    cwd,
    input: opts.input,
    stdin: opts.input !== undefined ? 'pipe' : 'ignore',
  })

  const { stdout, stderr, code, error } = result

  if (code === 0) {
    return { ok: true, stdout, stderr }
  }

  if (opts.allowedExitCodes?.has(code)) {
    return { ok: true, stdout, stderr }
  }

  // execFileNoThrow surfaces a `signal` field via its error message for
  // killed-by-signal cases (most relevant: SIGTERM on timeout). It also
  // populates `error` with execa's shortMessage which contains "timed out"
  // or "ENOENT" wording we can pattern-match on.
  const message = error || stderr || `git exited with code ${code}`
  const lower = message.toLowerCase()

  let reason: 'non-zero-exit' | 'timeout' | 'git-not-found' | 'spawn-error' =
    'non-zero-exit'
  if (lower.includes('timed out') || lower.includes('timedout')) {
    reason = 'timeout'
  } else if (lower.includes('enoent') || lower.includes('not found')) {
    reason = 'git-not-found'
  } else if (code < 0 || Number.isNaN(code)) {
    reason = 'spawn-error'
  }

  return { ok: false, reason, code, stdout, stderr, message }
}
