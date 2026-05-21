/**
 * `countFilesUnder` — pre-stage file-count guard for `createSnapshot`.
 *
 * Decision #13 (locked 2026-05-21): walk the workdir respecting
 * `DEFAULT_EXCLUDES` + `.gitignore`, abort once count exceeds the cap.
 * The point is to bail BEFORE paying the cost of `git add -A` on a
 * 100k-file monorepo. Hermes does this with `_dir_file_count`
 * (`tools/checkpoint_manager.py:515-525`) using `Path.rglob('*')` —
 * we go a step further by also honoring excludes during the walk so
 * `node_modules/` etc. don't even get traversed.
 *
 * Implementation choices:
 *   - `ignore` package (already in deps, used by `hooks/fileSuggestions.ts`)
 *     for gitignore matching. Same semantics as `git add -A` will use.
 *   - Recursive `readdir(..., { withFileTypes: true })` — single syscall
 *     per directory, no extra `stat` per entry.
 *   - Breadth-first via an array stack. Order doesn't matter for counting,
 *     but a stack avoids the recursion-depth limit on pathological trees.
 *   - `enoent`-tolerant: a directory that disappears during the walk is
 *     skipped silently. AV scans / live-edit races shouldn't fail the
 *     guard; they should fail forward into the snapshot.
 *
 * Symlinks are treated as files (not followed). Same as `git add -A` —
 * git stores the symlink itself, never the target.
 */

import ignore, { type Ignore } from 'ignore'
import { readdir, readFile } from 'fs/promises'
import { relative, sep } from 'path'
import { DEFAULT_EXCLUDES } from './paths.js'

/**
 * Result of `countFilesUnder`.
 *
 * `count` is the actual count when below the cap; when `aborted: true`
 * it's the cap+1 (we stop the walk the moment we cross it). Callers
 * check `aborted` first — `count` is informational only when aborted.
 */
export interface CountFilesResult {
  count: number
  aborted: boolean
}

export interface CountFilesOptions {
  /** Hard cap. Walk aborts once `count > max`. */
  max: number
  /**
   * Extra patterns merged with `DEFAULT_EXCLUDES`. Phase 2 doesn't pass
   * any, but the hook exists for Phase 5 (`/checkpoints` may want a
   * dry-run with custom excludes).
   */
  extraExcludes?: readonly string[]
}

/**
 * Walk `root` and return the number of files visible to `git add -A`,
 * stopping early once we exceed `opts.max`.
 *
 * Caller responsibility: pass an absolute, canonical `root`. We do not
 * normalize here — Phase 2's `createSnapshot` boundary already canonicalizes.
 */
export async function countFilesUnder(
  root: string,
  opts: CountFilesOptions,
): Promise<CountFilesResult> {
  const ig = (ignore as unknown as () => Ignore)()
  ig.add([...DEFAULT_EXCLUDES, ...(opts.extraExcludes ?? [])])
  await loadGitignoreInto(ig, root)

  let count = 0
  const stack: string[] = [root]

  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Directory vanished or unreadable — match Hermes 523 (swallow).
      continue
    }

    for (const entry of entries) {
      const full = `${dir}${sep}${entry.name}`
      const rel = toIgnorePath(root, full, entry.isDirectory())
      if (rel === null) continue
      if (ig.ignores(rel)) continue

      if (entry.isDirectory()) {
        stack.push(full)
      } else {
        count++
        if (count > opts.max) {
          return { count, aborted: true }
        }
      }
    }
  }

  return { count, aborted: false }
}

/**
 * Convert an absolute child path to the form `ignore` expects (POSIX
 * separators, relative to root, trailing slash for directories so
 * directory-only patterns like `node_modules/` match correctly).
 *
 * Returns null for the root itself (relative is empty) — there's nothing
 * to test against and we'd accidentally match `*` patterns.
 */
function toIgnorePath(
  root: string,
  abs: string,
  isDirectory: boolean,
): string | null {
  let r = relative(root, abs)
  if (r.length === 0) return null
  if (sep !== '/') r = r.split(sep).join('/')
  return isDirectory ? `${r}/` : r
}

/**
 * Read the project's `.gitignore` at root (if any) and merge into the
 * ignore matcher. We deliberately do NOT walk into nested `.gitignore`
 * files — that's a TODO matching git's actual semantics, but for the
 * file-count guard the top-level rules are 95% of the value at 5% of
 * the cost. The actual snapshot uses `git add -A` which honors nested
 * gitignores natively, so we don't lose precision in the snapshot
 * itself, only in the bail-early estimate.
 *
 * Hermes does not honor `.gitignore` in `_dir_file_count` at all —
 * we go one step further than parity here, costing this small helper.
 */
async function loadGitignoreInto(ig: Ignore, root: string): Promise<void> {
  try {
    const content = await readFile(`${root}${sep}.gitignore`, 'utf-8')
    ig.add(content)
  } catch {
    // No .gitignore, or unreadable — fine, DEFAULT_EXCLUDES still applies.
  }
}
