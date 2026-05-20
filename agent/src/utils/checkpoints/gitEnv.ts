/**
 * Build the environment for spawning git against the Checkpoints v2 shadow
 * store, completely isolated from the user's project `.git/` and gitconfig.
 *
 * Direct port of Hermes' `_git_env()` (`tools/checkpoint_manager.py:236-269`).
 * The notes there explain the consequences of *not* doing this: GPG signing
 * configured in `~/.gitconfig` would fire pinentry GUI prompts on every file
 * write; credential helpers would launch interactive flows; signing hooks
 * would either break background snapshots or pollute output.
 *
 * The five environment variables below give us:
 *   - GIT_DIR            redirects all git operations to the shadow store
 *   - GIT_WORK_TREE      tells git which worktree to snapshot (the user's project)
 *   - GIT_INDEX_FILE     per-project index → no race between concurrent worktrees
 *   - GIT_CONFIG_GLOBAL  point ~/.gitconfig at /dev/null  (NUL on Windows)
 *   - GIT_CONFIG_SYSTEM  point /etc/gitconfig at /dev/null
 *   - GIT_CONFIG_NOSYSTEM "1" — defense in depth even if GIT_CONFIG_SYSTEM
 *                        leaks via cmake/scoop/etc
 *
 * Two unset:
 *   - GIT_NAMESPACE                       inherited values would shadow our refs
 *   - GIT_ALTERNATE_OBJECT_DIRECTORIES    avoid pulling in unrelated object DBs
 *
 * Result: shadow git operates on its own GIT_DIR, the user's project `.git/`
 * is never touched, `git status` / `git log` / `git stash` in the user's
 * project remain completely unaffected.
 */

export interface CheckpointGitEnvOptions {
  /** Absolute path to the bare-ish shadow store. */
  store: string
  /** Absolute path to the worktree this snapshot is for (the user's project). */
  workTree: string
  /**
   * Per-project git index file. Omit only for operations that don't touch
   * the index (e.g. `git init --bare` rejects GIT_WORK_TREE; some plumbing
   * commands like `rev-parse --verify` don't need an index).
   */
  indexFile?: string
}

/**
 * Returns a `process.env`-shaped object suitable for `execFileNoThrow(...)`'s
 * `env` field. Keeps PATH and other system bits from the parent so git can
 * still find its helpers; only overrides the git-specific config locations
 * and store pointers.
 */
export function checkpointGitEnv(
  opts: CheckpointGitEnvOptions,
): NodeJS.ProcessEnv {
  const env = { ...process.env }

  env.GIT_DIR = opts.store
  env.GIT_WORK_TREE = opts.workTree

  if (opts.indexFile) {
    env.GIT_INDEX_FILE = opts.indexFile
  } else {
    delete env.GIT_INDEX_FILE
  }

  // Defense in depth — these would otherwise alias our refs or pull in
  // unrelated object DBs from the parent environment.
  delete env.GIT_NAMESPACE
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES

  // Mute user gitconfig — avoids:
  //   - GPG pinentry GUI prompts (commit.gpgsign=true)
  //   - credential helper invocations
  //   - signing hooks that wedge background snapshots
  // The Windows null device is "NUL" (no path), unlike POSIX "/dev/null".
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_GLOBAL = nullDev
  env.GIT_CONFIG_SYSTEM = nullDev
  env.GIT_CONFIG_NOSYSTEM = '1'

  // Belt-and-suspenders: even though we mute config, some git invocations
  // (auth helpers, askpass programs) can still try to prompt. With no TTY
  // we'd hang until the timeout fires. Force git to fail fast instead.
  env.GIT_TERMINAL_PROMPT = '0'

  return env
}

/**
 * Specialized variant for `git init --bare` and similar commands that reject
 * GIT_WORK_TREE. Same isolation, no worktree binding.
 */
export function checkpointInitEnv(opts: { store: string }): NodeJS.ProcessEnv {
  const env = { ...process.env }
  env.GIT_DIR = opts.store
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_NAMESPACE
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_GLOBAL = nullDev
  env.GIT_CONFIG_SYSTEM = nullDev
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}
