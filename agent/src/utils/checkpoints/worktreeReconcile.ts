import { lstat, mkdtemp, rm, rmdir, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { prepareSnapshotTree, MAX_FILE_SIZE_MB } from './createSnapshot.js'
import { dropOversizeFromIndex } from './dropOversizeFromIndex.js'
import { runCheckpointGit } from './git.js'
import { stageWorktreeSnapshotIndex } from './snapshotIndex.js'
import { logForDebugging } from '../debug.js'
import { isENOENT } from '../errors.js'
import { logError } from '../log.js'
import { expandPath } from '../path.js'
import {
  readNulPathspecFile,
  streamGitPathspecFromDiff,
} from '../fileHistoryRewindPathspec.js'

const DIFF_HAS_CHANGES = new Set([0, 1])
const RECONCILE_PATHSPEC_PREFIX = 'axiomate-rewind-'

export type WorktreeReconcilePlan = {
  store: string
  workdir: string
  /** Per-rewind scratch index used by restore/verify git commands. */
  indexFile: string
  targetHash: string
  currentTree: string
  tempDir: string
  checkoutPathspecFile: string
  deletePathspecFile: string
  checkoutCount: number
  deleteCount: number
  touchedCount: number
}

export async function prepareWorktreeReconcilePlan(
  workdir: string,
  targetHash: string,
): Promise<WorktreeReconcilePlan> {
  const tempDir = await mkdtemp(join(tmpdir(), RECONCILE_PATHSPEC_PREFIX))
  try {
    const reconcileIndexFile = join(tempDir, 'reconcile.index')
    const prepared = await prepareSnapshotTree(expandPath(workdir), {
      indexFile: reconcileIndexFile,
    })
    if (prepared.ok === false) {
      if (prepared.skipped === 'too-many-files') {
        throw new Error('too-many-files')
      }
      throw new Error(prepared.message ?? prepared.skipped)
    }

    const checkoutPathspecFile = join(tempDir, 'checkout-paths.nul')
    const deletePathspecFile = join(tempDir, 'delete-paths.nul')
    const deleteCount = await writePathspecFromDiff({
      store: prepared.store,
      workdir: prepared.canonical,
      indexFile: prepared.indexFile,
      args: [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        '--diff-filter=A',
        targetHash,
        prepared.treeHash,
      ],
      pathspecFile: deletePathspecFile,
    })
    const checkoutCount = await writePathspecFromDiff({
      store: prepared.store,
      workdir: prepared.canonical,
      indexFile: prepared.indexFile,
      args: [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        '--diff-filter=AMT',
        prepared.treeHash,
        targetHash,
      ],
      pathspecFile: checkoutPathspecFile,
    })

    return {
      store: prepared.store,
      workdir: prepared.canonical,
      indexFile: reconcileIndexFile,
      targetHash,
      currentTree: prepared.treeHash,
      tempDir,
      checkoutPathspecFile,
      deletePathspecFile,
      checkoutCount,
      deleteCount,
      touchedCount: checkoutCount + deleteCount,
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function writePathspecFromDiff(args: {
  store: string
  workdir: string
  indexFile: string
  args: string[]
  pathspecFile: string
}): Promise<number> {
  const diff = await streamGitPathspecFromDiff({
    store: args.store,
    workTree: args.workdir,
    indexFile: args.indexFile,
    gitArgs: args.args,
    pathspecFile: args.pathspecFile,
  })
  if (diff.ok === false) throw new Error(`diff: ${diff.message}`)
  return diff.count
}

export async function applyWorktreeReconcilePlan(
  plan: WorktreeReconcilePlan,
): Promise<void> {
  logForDebugging(
    `WorktreeReconcile: path apply delete=${plan.deleteCount} checkout=${plan.checkoutCount}`,
  )
  if (plan.checkoutCount > 0) {
    await removeCheckoutConflicts(plan)
    const checkout = await runCheckpointGit(
      [
        'restore',
        `--source=${plan.targetHash}`,
        `--pathspec-from-file=${plan.checkoutPathspecFile}`,
        '--pathspec-file-nul',
      ],
      {
        store: plan.store,
        workTree: plan.workdir,
        indexFile: plan.indexFile,
        timeoutMs: 60_000,
      },
    )
    if (checkout.ok === false) {
      throw new Error(`checkout: ${checkout.message}`)
    }
  }

  await deletePathspecPaths(plan)
}

async function removeCheckoutConflicts(plan: WorktreeReconcilePlan): Promise<void> {
  for await (const rel of readNulPathspecFile(plan.checkoutPathspecFile)) {
    const abs = resolveGitRelativePathForReconcile(plan.workdir, rel)
    // Only clear type conflicts that would make `git checkout <target> -- path`
    // fail: a target file path currently occupied by a directory, or a target
    // descendant whose parent is currently a file. Current-only files are
    // deleted later, after checkout succeeds.
    await removeFileAncestors(abs, plan.workdir)
    try {
      const stat = await lstat(abs)
      if (stat.isDirectory()) await rm(abs, { recursive: true, force: true })
    } catch (err: unknown) {
      if (!isENOENT(err)) logError(err)
    }
  }
}

async function removeFileAncestors(abs: string, root: string): Promise<void> {
  const normalizedRoot = canonicalPathKey(root)
  let current = dirname(abs)
  while (isPathInsideRoot(current, normalizedRoot)) {
    try {
      const stat = await lstat(current)
      if (stat.isFile()) {
        await unlink(current)
        return
      }
    } catch (err: unknown) {
      if (!isENOENT(err)) logError(err)
      return
    }
    current = dirname(current)
  }
}

async function deletePathspecPaths(plan: WorktreeReconcilePlan): Promise<void> {
  if (plan.deleteCount === 0) return
  for await (const rel of readNulPathspecFile(plan.deletePathspecFile)) {
    const abs = resolveGitRelativePathForReconcile(plan.workdir, rel)
    try {
      await unlink(abs)
      await removeEmptyParents(dirname(abs), plan.workdir)
      logForDebugging(`WorktreeReconcile: Deleted ${abs}`)
    } catch (err: unknown) {
      if (!isENOENT(err)) logError(err)
    }
  }
}

export function resolveGitRelativePathForReconcile(workdir: string, rel: string): string {
  if (rel.length === 0) throw new Error('empty pathspec record')
  if (rel.includes('\0')) throw new Error('pathspec record contains null byte')
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`unsafe absolute pathspec record: ${rel}`)
  }
  const normalizedWorkdir = normalize(resolve(expandPath(workdir)))
  const abs = resolve(normalizedWorkdir, rel)
  if (!isPathInsideRoot(abs, canonicalPathKey(normalizedWorkdir))) {
    throw new Error(`unsafe pathspec record outside worktree: ${rel}`)
  }
  return abs
}

function canonicalPathKey(path: string): string {
  const normalized = normalize(resolve(path))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInsideRoot(path: string, root: string): boolean {
  const relFromRoot = relative(root, canonicalPathKey(path))
  return (
    relFromRoot.length > 0 &&
    !relFromRoot.startsWith('..') &&
    !isAbsolute(relFromRoot)
  )
}

async function removeEmptyParents(dir: string, root: string): Promise<void> {
  const normalizedRoot = canonicalPathKey(root)
  let current = dir
  while (isPathInsideRoot(current, normalizedRoot)) {
    try {
      await rmdir(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

export async function verifyWorktreeReconcileTouchedPaths(
  plan: WorktreeReconcilePlan,
): Promise<boolean> {
  if (plan.touchedCount === 0) return true
  const files = [
    [plan.checkoutPathspecFile, plan.checkoutCount] as const,
    [plan.deletePathspecFile, plan.deleteCount] as const,
  ]
  for (const [pathspecFile, count] of files) {
    if (count === 0) continue
    const diff = await runCheckpointGit(
      [
        'diff',
        '--quiet',
        plan.targetHash,
        `--pathspec-from-file=${pathspecFile}`,
        '--pathspec-file-nul',
      ],
      {
        store: plan.store,
        workTree: plan.workdir,
        indexFile: plan.indexFile,
        allowedExitCodes: DIFF_HAS_CHANGES,
      },
    )
    if (diff.ok === false) return true
    if (diff.code === 1) return false
  }
  return true
}

export async function verifyWorktreeReconcileFullTree(
  plan: WorktreeReconcilePlan,
): Promise<boolean> {
  const stage = await stageWorktreeSnapshotIndex({
    store: plan.store,
    workTree: plan.workdir,
    indexFile: plan.indexFile,
  })
  if (stage.ok === false) {
    logForDebugging(
      `WorktreeReconcile: final full-tree verification stage failed (${stage.message}); treating as inconclusive`,
    )
    return true
  }

  await dropOversizeFromIndex({
    store: plan.store,
    workTree: plan.workdir,
    indexFile: plan.indexFile,
    maxFileSizeMb: MAX_FILE_SIZE_MB,
  })

  const diff = await runCheckpointGit(
    ['diff', '--cached', '--quiet', plan.targetHash, '--'],
    {
      store: plan.store,
      workTree: plan.workdir,
      indexFile: plan.indexFile,
      allowedExitCodes: DIFF_HAS_CHANGES,
    },
  )
  if (diff.ok === false) {
    logForDebugging(
      `WorktreeReconcile: final full-tree verification diff failed (${diff.message}); treating as inconclusive`,
    )
    return true
  }
  return diff.code === 0
}

export async function cleanupWorktreeReconcilePlan(
  plan: WorktreeReconcilePlan,
): Promise<void> {
  await rm(plan.tempDir, { recursive: true, force: true }).catch(() => {})
}
