import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import type { FileState } from './fileStateCache.js'
import {
  getFsImplementation,
  resolveDeepestExistingAncestorSync,
  safeResolvePath,
} from './fsOperations.js'
import { throwFileHarnessFailure } from './fileHarnessFailures.js'

type FileStateContext = Pick<ToolUseContext, 'agentId' | 'readFileState'>

type WriteStamp = {
  ownerId: string
  sequence: number
}

const MAX_GLOBAL_WRITERS = 4096

let ownerIdsByReadFileState = new WeakMap<
  ToolUseContext['readFileState'],
  string
>()
let readPathByRegistryKeyByReadFileState = new WeakMap<
  ToolUseContext['readFileState'],
  Map<string, string>
>()

let nextOwnerId = 0
let sequence = 0
const lastWriterByPath = new Map<string, WriteStamp>()
const pathLockTails = new Map<string, Promise<void>>()
const pathLockDepths = new Map<string, number>()
const heldPathLocks = new AsyncLocalStorage<Set<string>>()
const macCaseSensitivityByDevice = new Map<number, boolean>()

type RegistryPathKeyOptions = {
  platform?: NodeJS.Platform
  macCaseInsensitive?: boolean
}

function getOwnerId(context: FileStateContext): string {
  if (context.agentId) return `agent:${context.agentId}`

  const existing = ownerIdsByReadFileState.get(context.readFileState)
  if (existing) return existing

  const ownerId = `context:${++nextOwnerId}`
  ownerIdsByReadFileState.set(context.readFileState, ownerId)
  return ownerId
}

function capMap<TKey, TValue>(map: Map<TKey, TValue>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}

function windowsRegistryPathKey(key: string): string {
  return key.toLowerCase()
}

function linuxRegistryPathKey(key: string): string {
  return key
}

function findExistingDirectoryForCaseProbe(
  filePath: string,
): string | undefined {
  const fs = getFsImplementation()
  let dir = dirname(filePath)
  while (dir !== dirname(dir)) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir
    } catch {}
    dir = dirname(dir)
  }

  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}

function isDirectoryCaseSensitiveOnMac(dirPath: string): boolean {
  const fs = getFsImplementation()
  let device: number | undefined
  try {
    device = fs.statSync(dirPath).dev
    const cached = macCaseSensitivityByDevice.get(device)
    if (cached !== undefined) return cached
  } catch {}

  const probeName = `.axiomate-case-probe-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`
  const probePath = join(dirPath, probeName)
  const oppositeCasePath = join(dirPath, probeName.toUpperCase())

  try {
    fs.appendFileSync(probePath, '', { mode: 0o600 })
    const caseSensitive = !fs.existsSync(oppositeCasePath)
    if (device !== undefined) {
      macCaseSensitivityByDevice.set(device, caseSensitive)
    }
    return caseSensitive
  } catch {
    // If probing is blocked, keep this path conservative and do not fold. Do
    // not cache the failure at device level; another directory on the same
    // volume may be probeable.
    return true
  } finally {
    try {
      fs.unlinkSync(probePath)
    } catch {}
  }
}

function macRegistryPathKey(
  key: string,
  options?: RegistryPathKeyOptions,
  allowProbe = true,
): string {
  const caseInsensitive =
    options?.macCaseInsensitive ??
    (() => {
      if (!allowProbe) return false
      const dir = findExistingDirectoryForCaseProbe(key)
      return dir === undefined ? false : !isDirectoryCaseSensitiveOnMac(dir)
    })()
  return caseInsensitive ? key.toLowerCase() : key
}

function platformRegistryPathKey(
  key: string,
  options?: RegistryPathKeyOptions,
  allowMacProbe = true,
): string {
  const platform = options?.platform ?? process.platform
  switch (platform) {
    case 'win32':
      return windowsRegistryPathKey(key)
    case 'darwin':
      return macRegistryPathKey(key, options, allowMacProbe)
    case 'linux':
      return linuxRegistryPathKey(key)
    default:
      return key
  }
}

export function getFileStateRegistryPathKey(
  filePath: string,
  options?: RegistryPathKeyOptions,
): string {
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return platformRegistryPathKey(normalize(filePath), options, false)
  }

  const fs = getFsImplementation()
  const absolutePath = isAbsolute(filePath)
    ? filePath
    : resolve(fs.cwd(), filePath)
  const resolvedExisting = safeResolvePath(fs, absolutePath)
  const resolvedPath = resolvedExisting.isCanonical
    ? resolvedExisting.resolvedPath
    : (resolveDeepestExistingAncestorSync(fs, absolutePath) ?? absolutePath)

  return platformRegistryPathKey(normalize(resolvedPath), options)
}

function getReadPathByRegistryKey(
  context: FileStateContext,
): Map<string, string> {
  let paths = readPathByRegistryKeyByReadFileState.get(context.readFileState)
  if (paths) return paths

  paths = new Map()
  readPathByRegistryKeyByReadFileState.set(context.readFileState, paths)
  return paths
}

function rememberReadPathForRegistryKey(
  context: FileStateContext,
  filePath: string,
  registryKey: string,
): void {
  getReadPathByRegistryKey(context).set(registryKey, normalize(filePath))
}

export function getFileStateRegistryPathKeyForTests(
  filePath: string,
  options?: RegistryPathKeyOptions,
): string {
  return getFileStateRegistryPathKey(filePath, options)
}

export function recordFileRead(
  context: FileStateContext,
  filePath: string,
): void {
  getOwnerId(context)
  const normalizedPath = normalize(filePath)
  const registryKey = getFileStateRegistryPathKey(filePath)
  const fileState = context.readFileState.get(normalizedPath)
  if (fileState) fileState.registrySequence = ++sequence
  if (fileState) {
    rememberReadPathForRegistryKey(context, normalizedPath, registryKey)
  }
}

export function setObservedFileState(
  context: FileStateContext,
  filePath: string,
  fileState: FileState,
): void {
  context.readFileState.set(filePath, fileState)
  recordFileRead(context, filePath)
}

export function setObservedFileStateIfNewer(
  context: FileStateContext,
  filePath: string,
  fileState: FileState,
): boolean {
  const existing = context.readFileState.get(filePath)
  if (existing && existing.timestamp >= fileState.timestamp) {
    return false
  }
  context.readFileState.set(filePath, fileState)
  if (fileState.registrySequence === undefined) {
    recordFileRead(context, filePath)
  } else {
    rememberReadPathForRegistryKey(
      context,
      normalize(filePath),
      getFileStateRegistryPathKey(filePath),
    )
  }
  return true
}

export function noteFileWrite(
  context: FileStateContext,
  filePath: string,
): void {
  const ownerId = getOwnerId(context)
  const writeSequence = ++sequence
  const normalizedPath = normalize(filePath)
  const registryKey = getFileStateRegistryPathKey(filePath)
  lastWriterByPath.delete(registryKey)
  lastWriterByPath.set(registryKey, {
    ownerId,
    sequence: writeSequence,
  })
  capMap(lastWriterByPath, MAX_GLOBAL_WRITERS)

  const fileState = context.readFileState.get(normalizedPath)
  if (fileState) fileState.registrySequence = writeSequence
  if (fileState) {
    rememberReadPathForRegistryKey(context, normalizedPath, registryKey)
  }
}

export function wasFileModifiedAfterReadByAnotherContext(
  context: FileStateContext,
  filePath: string,
): boolean {
  const ownerId = getOwnerId(context)
  const registryKey = getFileStateRegistryPathKey(filePath)
  const lastWriter = lastWriterByPath.get(registryKey)
  if (!lastWriter || lastWriter.ownerId === ownerId) return false

  const readPath =
    getReadPathByRegistryKey(context).get(registryKey) ?? normalize(filePath)
  const readStamp = context.readFileState.get(readPath)
  if (!readStamp) return true

  // A read state with no registrySequence was not observed live through this
  // process's read path — it was reconstructed from the transcript or injected
  // across a compact/resume boundary (e.g. the --print startup seed). Its
  // logical read order is unknowable, so this in-process write-ordering
  // heuristic cannot judge it. Abstain and let the caller's mtime/content
  // staleness gate decide, instead of falsely reporting a sibling write. This
  // is the same downgrade already accepted for cross-process teammate writes
  // (mtime/content + checkpoint), per migration plan decisions #10 and #24.
  if (readStamp.registrySequence === undefined) return false

  return lastWriter.sequence > readStamp.registrySequence
}

export function getFileStateRegistrySequence(): number {
  return sequence
}

export function getKnownReadFilePaths(context: FileStateContext): string[] {
  getOwnerId(context)
  return Array.from(context.readFileState.keys())
}

export function getPathsWrittenByOtherContextsSince(
  context: FileStateContext,
  sinceSequence: number,
  filePaths: Iterable<string>,
): string[] {
  const ownerId = getOwnerId(context)
  const paths = new Map(
    Array.from(filePaths, path => [
      getFileStateRegistryPathKey(path),
      normalize(path),
    ]),
  )
  const stalePaths: string[] = []

  for (const [registryKey, lastWriter] of lastWriterByPath) {
    const path = paths.get(registryKey)
    if (!path) continue
    if (lastWriter.ownerId === ownerId) continue
    if (lastWriter.sequence <= sinceSequence) continue

    const readPath = getReadPathByRegistryKey(context).get(registryKey) ?? path
    const readStamp = context.readFileState.get(readPath)
    if (
      readStamp?.registrySequence !== undefined &&
      readStamp.registrySequence >= lastWriter.sequence
    ) {
      continue
    }
    stalePaths.push(path)
  }

  return stalePaths.sort()
}

export async function withFileStatePathLock<T>(
  filePath: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  const registryKey = getFileStateRegistryPathKey(filePath)
  const heldLocks = heldPathLocks.getStore()
  if (heldLocks?.has(registryKey)) {
    throwFileHarnessFailure(
      `File state path lock is not reentrant for path: ${filePath}`,
      'path_lock_reentry',
      'execution',
      filePath,
    )
  }

  const previousTail = pathLockTails.get(registryKey)
  let release!: () => void
  const currentGate = new Promise<void>(resolve => {
    release = resolve
  })
  const currentTail = (previousTail ?? Promise.resolve()).then(
    () => currentGate,
    () => currentGate,
  )

  pathLockTails.set(registryKey, currentTail)
  pathLockDepths.set(
    registryKey,
    (pathLockDepths.get(registryKey) ?? 0) + 1,
  )

  try {
    if (previousTail) {
      await previousTail.catch(() => {})
    }
    return await heldPathLocks.run(
      new Set([...(heldLocks ?? []), registryKey]),
      callback,
    )
  } finally {
    release()
    const nextDepth = (pathLockDepths.get(registryKey) ?? 1) - 1
    if (nextDepth <= 0) {
      pathLockDepths.delete(registryKey)
    } else {
      pathLockDepths.set(registryKey, nextDepth)
    }
    if (pathLockTails.get(registryKey) === currentTail) {
      pathLockTails.delete(registryKey)
    }
  }
}

export function getFileStatePathLockDepthForTests(filePath: string): number {
  return pathLockDepths.get(getFileStateRegistryPathKey(filePath)) ?? 0
}

export function clearFileStateRegistryForTests(): void {
  sequence = 0
  nextOwnerId = 0
  ownerIdsByReadFileState = new WeakMap()
  readPathByRegistryKeyByReadFileState = new WeakMap()
  lastWriterByPath.clear()
  pathLockTails.clear()
  pathLockDepths.clear()
  macCaseSensitivityByDevice.clear()
}
