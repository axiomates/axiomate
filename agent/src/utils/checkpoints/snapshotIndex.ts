/**
 * Filesystem-backed checkpoint staging.
 *
 * Checkpoint snapshots are file-system snapshots stored in a Git object
 * database, not Git repository snapshots. We intentionally do not let
 * `git add -A` decide what a nested `.git` means: VCS metadata entries
 * are skipped, while ordinary files below embedded repositories are
 * captured by their current bytes.
 */

import { mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { isAbsolute, join, relative, sep } from 'path'
import { runCheckpointGit } from './git.js'

const CHECK_IGNORE_OK = new Set([1])
const MAX_DIRS_PER_IGNORE_BATCH = 128
const MAX_PATHS_PER_STDIN_BATCH = 4096
const MAX_STDIN_BYTES = 1_000_000
const MAX_DISCOVERY_CONCURRENCY = 4
const VCS_METADATA_NAMES = new Set(['.git', '.hg', '.svn'])
const GIT_METADATA_NAME = '.git'
const DISCOVERY_INDEX_PREFIX = 'axiomate-checkpoint-discovery-'

type DirQueueItem = {
  abs: string
  ignoreRoot: string
}

type DirProbeRecord = {
  abs: string
  ignoreRoot: string
  probe: string
}

type LimitProbeRecord =
  | {
      kind: 'dir'
      abs: string
      ignoreRoot: string
      probe: string
    }
  | {
      kind: 'file'
      ignoreRoot: string
      probe: string
      rel: string
    }

type ScanRoot = {
  abs: string
  prefix: string
}

export type CollectCheckpointFilesResult =
  | { ok: true; paths: string[] }
  | { ok: false; message: string }

export type StageWorktreeSnapshotIndexResult =
  | { ok: true; paths: string[] }
  | { ok: false; message: string }

export async function collectCheckpointFiles(args: {
  store: string
  workTree: string
  indexFile?: string
  maxFiles?: number
}): Promise<CollectCheckpointFilesResult> {
  let discoveryDir: string | null = null
  try {
    discoveryDir = await mkdtemp(join(tmpdir(), DISCOVERY_INDEX_PREFIX))
    const rootDiscoveryIndexFile = join(discoveryDir, 'roots.index')

    if (args.maxFiles !== undefined) {
      return await collectCheckpointFilesWithLimit({
        store: args.store,
        workTree: args.workTree,
        indexFile: rootDiscoveryIndexFile,
        maxFiles: args.maxFiles,
      })
    }

    const roots = await discoverScanRoots({
      store: args.store,
      workTree: args.workTree,
      indexFile: rootDiscoveryIndexFile,
    })
    if (roots.ok === false) return roots

    const listed = await mapWithConcurrency(
      roots.roots,
      MAX_DISCOVERY_CONCURRENCY,
      (root, index) =>
        listFilesForScanRoot({
          store: args.store,
          scanRoot: root,
          allRoots: roots.roots,
          discoveryIndexFile: join(discoveryDir, `files-${index}.index`),
        }),
    )
    const out: string[] = []
    for (const result of listed) {
      if (result.ok === false) return result
      out.push(...result.paths)
    }
    return { ok: true, paths: out }
  } catch (err) {
    return { ok: false, message: `collect files: ${errorMessage(err)}` }
  } finally {
    if (discoveryDir !== null) {
      await rm(discoveryDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function collectCheckpointFilesWithLimit(args: {
  store: string
  workTree: string
  indexFile: string
  maxFiles: number
}): Promise<CollectCheckpointFilesResult> {
  const queue: DirQueueItem[] = [
    { abs: args.workTree, ignoreRoot: args.workTree },
  ]
  const out: string[] = []

  while (queue.length > 0) {
    const dirs = queue.splice(0, MAX_DIRS_PER_IGNORE_BATCH)
    const records: LimitProbeRecord[] = []
    const probesByIgnoreRoot = new Map<string, string[]>()

    for (const dir of dirs) {
      let entries
      try {
        entries = await readdir(dir.abs, { withFileTypes: true })
      } catch {
        continue
      }

      const hasGitMetadata = entries.some(entry => entry.name === GIT_METADATA_NAME)
      const ignoreRoot =
        hasGitMetadata && dir.abs !== dir.ignoreRoot ? dir.abs : dir.ignoreRoot

      for (const entry of entries) {
        if (VCS_METADATA_NAMES.has(entry.name)) continue

        const full = join(dir.abs, entry.name)
        const rel = toGitPath(args.workTree, full)
        if (rel.length === 0) continue

        if (entry.isDirectory()) {
          const probe = toGitPath(ignoreRoot, full)
          appendProbe(probesByIgnoreRoot, ignoreRoot, probe)
          records.push({ kind: 'dir', abs: full, ignoreRoot, probe })
          continue
        }

        if (!(entry.isFile() || entry.isSymbolicLink())) continue
        const probe = toGitPath(ignoreRoot, full)
        appendProbe(probesByIgnoreRoot, ignoreRoot, probe)
        records.push({ kind: 'file', ignoreRoot, probe, rel })
      }
    }

    if (records.length === 0) continue

    const ignoredByRoot = new Map<string, Set<string>>()
    for (const [ignoreRoot, probes] of probesByIgnoreRoot) {
      const ignored = await checkIgnored({
        store: args.store,
        workTree: ignoreRoot,
        indexFile: args.indexFile,
        probes,
      })
      if (ignored.ok === false) return ignored
      ignoredByRoot.set(ignoreRoot, ignored.paths)
    }

    for (const record of records) {
      if (ignoredByRoot.get(record.ignoreRoot)?.has(record.probe)) continue
      if (record.kind === 'dir') {
        queue.push({ abs: record.abs, ignoreRoot: record.ignoreRoot })
      } else {
        out.push(record.rel)
        if (out.length > args.maxFiles) return { ok: true, paths: out }
      }
    }
  }

  return { ok: true, paths: out }
}

async function discoverScanRoots(args: {
  store: string
  workTree: string
  indexFile: string
}): Promise<{ ok: true; roots: ScanRoot[] } | { ok: false; message: string }> {
  const queue: DirQueueItem[] = [
    { abs: args.workTree, ignoreRoot: args.workTree },
  ]
  const roots: ScanRoot[] = []
  const seenRoots = new Set<string>()

  while (queue.length > 0) {
    const dirs = queue.splice(0, MAX_DIRS_PER_IGNORE_BATCH)
    const records: DirProbeRecord[] = []
    const probesByIgnoreRoot = new Map<string, string[]>()

    for (const dir of dirs) {
      let entries
      try {
        entries = await readdir(dir.abs, { withFileTypes: true })
      } catch {
        // Directory vanished or is unreadable. Checkpointing is best-effort;
        // skip this subtree and let the next snapshot observe the new state.
        continue
      }

      const hasGitMetadata = entries.some(entry => entry.name === GIT_METADATA_NAME)
      const ignoreRoot =
        hasGitMetadata && dir.abs !== dir.ignoreRoot ? dir.abs : dir.ignoreRoot

      if (dir.abs === args.workTree || hasGitMetadata) {
        addScanRoot({
          roots,
          seenRoots,
          workTree: args.workTree,
          abs: dir.abs,
        })
      }

      for (const entry of entries) {
        if (VCS_METADATA_NAMES.has(entry.name)) continue
        if (!entry.isDirectory()) continue

        const full = join(dir.abs, entry.name)
        const probe = toGitPath(ignoreRoot, full)
        appendProbe(probesByIgnoreRoot, ignoreRoot, probe)
        records.push({ abs: full, ignoreRoot, probe })
      }
    }

    if (records.length === 0) continue

    const ignoredByRoot = new Map<string, Set<string>>()
    for (const [ignoreRoot, probes] of probesByIgnoreRoot) {
      const ignored = await checkIgnored({
        store: args.store,
        workTree: ignoreRoot,
        indexFile: args.indexFile,
        probes,
      })
      if (ignored.ok === false) return ignored
      ignoredByRoot.set(ignoreRoot, ignored.paths)
    }

    for (const record of records) {
      if (ignoredByRoot.get(record.ignoreRoot)?.has(record.probe)) continue
      queue.push({ abs: record.abs, ignoreRoot: record.ignoreRoot })
    }
  }

  return { ok: true, roots }
}

async function listFilesForScanRoot(args: {
  store: string
  scanRoot: ScanRoot
  allRoots: ScanRoot[]
  discoveryIndexFile: string
  stopAfter?: number
}): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  try {
    await rm(args.discoveryIndexFile, { force: true })
  } catch (err) {
    return {
      ok: false,
      message: `reset discovery index: ${errorMessage(err)}`,
    }
  }

  const result = await runCheckpointGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    {
      store: args.store,
      workTree: args.scanRoot.abs,
      indexFile: args.discoveryIndexFile,
    },
  )
  if (result.ok === false) {
    return { ok: false, message: `ls-files: ${result.message}` }
  }

  const paths: string[] = []
  const nestedPrefixes = nestedScanRootPrefixes(args.scanRoot, args.allRoots)
  for (const rel of splitGitZ(result.stdout)) {
    if (rel.endsWith('/')) continue
    if (hasVcsMetadataSegment(rel)) continue
    if (isUnderAnyPrefix(rel, nestedPrefixes)) continue

    const path =
      args.scanRoot.prefix.length > 0 ? `${args.scanRoot.prefix}/${rel}` : rel
    paths.push(path)
    if (args.stopAfter !== undefined && paths.length > args.stopAfter) {
      return { ok: true, paths }
    }
  }

  return { ok: true, paths }
}

export async function stageWorktreeSnapshotIndex(args: {
  store: string
  workTree: string
  indexFile: string
  timeoutMs?: number
}): Promise<StageWorktreeSnapshotIndexResult> {
  const first = await stageWorktreeSnapshotIndexOnce(args)
  if (first.ok === true) return first

  // Most failures here are races: a candidate path disappeared or changed
  // type between collection and update-index. Rebuild from an empty index
  // once so live-edit churn does not unnecessarily drop a checkpoint.
  const second = await stageWorktreeSnapshotIndexOnce(args)
  if (second.ok === true) return second
  return {
    ok: false,
    message: `${first.message}; retry failed: ${second.message}`,
  }
}

async function stageWorktreeSnapshotIndexOnce(args: {
  store: string
  workTree: string
  indexFile: string
  timeoutMs?: number
}): Promise<StageWorktreeSnapshotIndexResult> {
  const clear = await runCheckpointGit(['read-tree', '--empty'], {
    store: args.store,
    workTree: args.workTree,
    indexFile: args.indexFile,
  })
  if (clear.ok === false) {
    return { ok: false, message: `read-tree --empty: ${clear.message}` }
  }

  const collected = await collectCheckpointFiles({
    store: args.store,
    workTree: args.workTree,
    indexFile: args.indexFile,
  })
  if (collected.ok === false) return collected

  for (const batch of pathBatches(collected.paths)) {
    const input = Buffer.from(`${batch.join('\0')}\0`, 'utf-8')
    const update = await runCheckpointGit(
      ['update-index', '--add', '-z', '--stdin'],
      {
        store: args.store,
        workTree: args.workTree,
        indexFile: args.indexFile,
        timeoutMs: args.timeoutMs,
        input,
      },
    )
    if (update.ok === false) {
      return { ok: false, message: `update-index: ${update.message}` }
    }
  }

  return { ok: true, paths: collected.paths }
}

async function checkIgnored(args: {
  store: string
  workTree: string
  indexFile?: string
  probes: string[]
}): Promise<{ ok: true; paths: Set<string> } | { ok: false; message: string }> {
  const ignored = new Set<string>()
  for (const probes of pathBatches(args.probes)) {
    const input = Buffer.from(`${probes.join('\0')}\0`, 'utf-8')
    const result = await runCheckpointGit(
      ['check-ignore', '--stdin', '-z', '--no-index'],
      {
        store: args.store,
        workTree: args.workTree,
        indexFile: args.indexFile,
        allowedExitCodes: CHECK_IGNORE_OK,
        input,
      },
    )
    if (result.ok === false) {
      return { ok: false, message: `check-ignore: ${result.message}` }
    }
    if (result.stdout.length === 0) continue
    for (const rel of result.stdout.split('\0')) {
      if (rel.length > 0) ignored.add(rel)
    }
  }
  return { ok: true, paths: ignored }
}

function appendProbe(
  groups: Map<string, string[]>,
  ignoreRoot: string,
  probe: string,
): void {
  const group = groups.get(ignoreRoot)
  if (group) {
    group.push(probe)
  } else {
    groups.set(ignoreRoot, [probe])
  }
}

function addScanRoot(args: {
  roots: ScanRoot[]
  seenRoots: Set<string>
  workTree: string
  abs: string
}): void {
  if (args.seenRoots.has(args.abs)) return
  args.seenRoots.add(args.abs)
  args.roots.push({
    abs: args.abs,
    prefix: toGitPath(args.workTree, args.abs),
  })
}

function nestedScanRootPrefixes(
  scanRoot: ScanRoot,
  allRoots: ScanRoot[],
): string[] {
  const prefixes: string[] = []

  for (const root of allRoots) {
    if (root.abs === scanRoot.abs) continue

    const rel = relative(scanRoot.abs, root.abs)
    if (
      rel.length === 0 ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      continue
    }

    prefixes.push(`${toGitPath(scanRoot.abs, root.abs)}/`)
  }

  return prefixes
}

function isUnderAnyPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some(prefix => path.startsWith(prefix))
}

function hasVcsMetadataSegment(path: string): boolean {
  return path.split('/').some(segment => VCS_METADATA_NAMES.has(segment))
}

function splitGitZ(stdout: string): string[] {
  return stdout.split('\0').filter(p => p.length > 0)
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next++
      results[index] = await fn(items[index], index)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function* pathBatches(paths: string[]): Generator<string[]> {
  let batch: string[] = []
  let bytes = 0

  for (const p of paths) {
    const pathBytes = Buffer.byteLength(p, 'utf-8') + 1
    if (
      batch.length > 0 &&
      (batch.length >= MAX_PATHS_PER_STDIN_BATCH ||
        bytes + pathBytes > MAX_STDIN_BYTES)
    ) {
      yield batch
      batch = []
      bytes = 0
    }
    batch.push(p)
    bytes += pathBytes
  }

  if (batch.length > 0) yield batch
}

function toGitPath(root: string, abs: string): string {
  const rel = relative(root, abs)
  return sep === '/' ? rel : rel.split(sep).join('/')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
