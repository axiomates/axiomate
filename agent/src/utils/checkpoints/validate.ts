/**
 * Input validation helpers for the Checkpoints v2 shadow-git store.
 *
 * Direct port of Hermes' `_validate_commit_hash` and `_validate_file_path`
 * (`tools/checkpoint_manager.py:155-186`). These exist to defend against:
 *
 *   1. Git argument injection via `-`-prefixed values that would be
 *      interpreted as flags (e.g. `-p`, `--patch`, `--upload-pack`).
 *   2. Path traversal escaping the snapshotted working directory.
 *
 * Each validator returns `null` for valid input or an error string. Returning
 * a string (instead of throwing) lets callers log the failure and fail-open
 * without unwinding the call stack — matches the "never raises" contract
 * Hermes uses for its checkpoint code path.
 */

import { isAbsolute, relative, resolve, sep } from 'path'
import { normalizePath } from './paths.js'

/** Valid git commit hash: 4–64 hex chars (short SHA-1 through full SHA-256). */
const COMMIT_HASH_RE = /^[0-9a-fA-F]{4,64}$/

/**
 * Validate a commit hash before passing it to git as a positional argument.
 *
 * Returns `null` if valid, otherwise an error string suitable for logging.
 *
 * Why: a value like `-p` or `--patch` would be parsed as a git flag instead
 * of a revision specifier, potentially turning `git checkout <hash> -- .`
 * into `git checkout --patch -- .`. The `^[0-9a-fA-F]{4,64}$` regex also
 * implicitly rejects `-` because hex doesn't contain it, but the explicit
 * leading-dash check makes the intent visible to readers.
 */
export function validateCommitHash(commitHash: string): string | null {
  if (!commitHash || !commitHash.trim()) {
    return 'Empty commit hash'
  }
  if (commitHash.startsWith('-')) {
    return `Invalid commit hash (must not start with '-'): ${JSON.stringify(commitHash)}`
  }
  if (!COMMIT_HASH_RE.test(commitHash)) {
    return `Invalid commit hash (expected 4-64 hex characters): ${JSON.stringify(commitHash)}`
  }
  return null
}

/**
 * Validate a path passed to `git checkout <hash> -- <path>` to ensure it
 * stays within the snapshotted worktree.
 *
 * Returns `null` if valid, otherwise an error string.
 *
 * Rules:
 *   - non-empty
 *   - relative (absolute paths can address arbitrary filesystem locations)
 *   - resolves to a location inside `workingDir`
 *
 * Implementation note: we use `path.relative` + the absence of a `..` prefix
 * rather than Python's `Path.resolve().relative_to()` because Node has no
 * direct equivalent. The result is the same: any traversal that escapes
 * `workingDir` produces a relative path starting with `..`.
 */
export function validateRelativePath(
  filePath: string,
  workingDir: string,
): string | null {
  if (!filePath || !filePath.trim()) {
    return 'Empty file path'
  }
  if (isAbsolute(filePath)) {
    return `File path must be relative, got absolute path: ${JSON.stringify(filePath)}`
  }
  // Canonicalize workdir first (tilde-expand, resolve relatives) — matches
  // Hermes `_validate_file_path` calling `_normalize_path(working_dir)`
  // before doing the relative-to check.
  const absWorkdir = normalizePath(workingDir)
  const resolved = resolve(absWorkdir, filePath)
  const rel = relative(absWorkdir, resolved)
  // `relative` returns '..' or a string starting with '..' + sep when the
  // resolved path escapes the base. An empty string means resolved === base,
  // which is fine (refers to workdir itself).
  if (rel === '..' || rel.startsWith('..' + sep)) {
    return `File path escapes the working directory via traversal: ${JSON.stringify(filePath)}`
  }
  return null
}
