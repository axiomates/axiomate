import { isAbsolute, normalize, resolve } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import {
  getFsImplementation,
  resolveDeepestExistingAncestorSync,
  safeResolvePath,
} from './fsOperations.js'

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

function caseFoldRegistryKey(key: string): string {
  return process.platform === 'win32' ? key.toLowerCase() : key
}

function registryPathKey(filePath: string): string {
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return caseFoldRegistryKey(normalize(filePath))
  }

  const fs = getFsImplementation()
  const absolutePath = isAbsolute(filePath)
    ? filePath
    : resolve(fs.cwd(), filePath)
  const resolvedExisting = safeResolvePath(fs, absolutePath)
  const resolvedPath = resolvedExisting.isCanonical
    ? resolvedExisting.resolvedPath
    : (resolveDeepestExistingAncestorSync(fs, absolutePath) ?? absolutePath)

  return caseFoldRegistryKey(normalize(resolvedPath))
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

export function getFileStateRegistryPathKeyForTests(filePath: string): string {
  return registryPathKey(filePath)
}

export function recordFileRead(
  context: FileStateContext,
  filePath: string,
): void {
  getOwnerId(context)
  const normalizedPath = normalize(filePath)
  const registryKey = registryPathKey(filePath)
  const fileState = context.readFileState.get(normalizedPath)
  if (fileState) fileState.registrySequence = ++sequence
  if (fileState) {
    rememberReadPathForRegistryKey(context, normalizedPath, registryKey)
  }
}

export function noteFileWrite(
  context: FileStateContext,
  filePath: string,
): void {
  const ownerId = getOwnerId(context)
  const writeSequence = ++sequence
  const normalizedPath = normalize(filePath)
  const registryKey = registryPathKey(filePath)
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
  const registryKey = registryPathKey(filePath)
  const lastWriter = lastWriterByPath.get(registryKey)
  if (!lastWriter || lastWriter.ownerId === ownerId) return false

  const readPath =
    getReadPathByRegistryKey(context).get(registryKey) ?? normalize(filePath)
  const readStamp = context.readFileState.get(readPath)
  if (!readStamp) return true

  return (
    readStamp.registrySequence === undefined ||
    lastWriter.sequence > readStamp.registrySequence
  )
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
    Array.from(filePaths, path => [registryPathKey(path), normalize(path)]),
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
  const registryKey = registryPathKey(filePath)
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
    return await callback()
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
  return pathLockDepths.get(registryPathKey(filePath)) ?? 0
}

export function clearFileStateRegistryForTests(): void {
  sequence = 0
  nextOwnerId = 0
  ownerIdsByReadFileState = new WeakMap()
  readPathByRegistryKeyByReadFileState = new WeakMap()
  lastWriterByPath.clear()
  pathLockTails.clear()
  pathLockDepths.clear()
}
