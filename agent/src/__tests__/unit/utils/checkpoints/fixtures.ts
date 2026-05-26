/**
 * Test fixture: build N commits on a per-project ref by running the
 * raw plumbing chain (write-tree + commit-tree + update-ref) against
 * a real shadow store. Used by pruneRefToMaxN.test.ts and the future
 * createSnapshot/listSnapshots/rollback test suites.
 *
 * Lives in __tests__/ so it's never imported by production code.
 */

import { writeFileSync } from 'fs'
import { join } from 'path'
import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'

export interface FixtureCommitOpts {
  store: string
  workTree: string
  indexFile: string
  ref: string
  /** Files to write at workdir before each snapshot. Path → content. */
  files: Record<string, string>
  /** Commit subject. */
  subject: string
}

/**
 * Build a single commit on `ref` against the supplied files. Mirrors
 * the createSnapshot plumbing route — use this from tests so we don't
 * couple to createSnapshot's full pipeline before it's written.
 *
 * Returns the new commit SHA. Throws on any plumbing failure (tests
 * want loud failures, not silent pass-throughs).
 */
export async function buildFixtureCommit(
  opts: FixtureCommitOpts,
): Promise<string> {
  for (const [rel, content] of Object.entries(opts.files)) {
    writeFileSync(join(opts.workTree, rel), content)
  }

  const env = {
    store: opts.store,
    workTree: opts.workTree,
    indexFile: opts.indexFile,
  }

  const add = await runCheckpointGit(['add', '-A'], env)
  if (add.ok === false) throw new Error(`fixture add failed: ${add.message}`)

  const writeTree = await runCheckpointGit(['write-tree'], env)
  if (writeTree.ok === false) {
    throw new Error(`fixture write-tree failed: ${writeTree.message}`)
  }
  const treeSha = writeTree.stdout.trim()

  // Look up current ref (if any) for parent.
  const showRef = await runCheckpointGit(
    ['rev-parse', '--verify', opts.ref],
    { ...env, allowedExitCodes: new Set([128]) },
  )
  const parent =
    showRef.ok === true && showRef.stdout.trim().length > 0
      ? showRef.stdout.trim()
      : null

  const commitArgs = [
    'commit-tree',
    treeSha,
    '-m',
    opts.subject,
    '--no-gpg-sign',
  ]
  if (parent !== null) {
    commitArgs.splice(2, 0, '-p', parent)
  }
  const commit = await runCheckpointGit(commitArgs, env)
  if (commit.ok === false) {
    throw new Error(`fixture commit-tree failed: ${commit.message}`)
  }
  const newSha = commit.stdout.trim()

  const update = await runCheckpointGit(
    ['update-ref', opts.ref, newSha],
    env,
  )
  if (update.ok === false) {
    throw new Error(`fixture update-ref failed: ${update.message}`)
  }

  return newSha
}
