import { normalize } from 'path'
import type { ToolUseContext } from '../Tool.js'

type FileStateContext = Pick<ToolUseContext, 'agentId' | 'readFileState'>

type WriteStamp = {
  ownerId: string
  sequence: number
}

const MAX_GLOBAL_WRITERS = 4096

const ownerIdsByReadFileState = new WeakMap<ToolUseContext['readFileState'], string>()

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

export function recordFileRead(
  context: FileStateContext,
  filePath: string,
): void {
  getOwnerId(context)
  const fileState = context.readFileState.get(normalize(filePath))
  if (fileState) fileState.registrySequence = ++sequence
}

export function noteFileWrite(
  context: FileStateContext,
  filePath: string,
): void {
  const ownerId = getOwnerId(context)
  const writeSequence = ++sequence
  const normalizedPath = normalize(filePath)
  lastWriterByPath.set(normalizedPath, {
    ownerId,
    sequence: writeSequence,
  })
  capMap(lastWriterByPath, MAX_GLOBAL_WRITERS)

  const fileState = context.readFileState.get(normalizedPath)
  if (fileState) fileState.registrySequence = writeSequence
}

export function wasFileModifiedAfterReadByAnotherContext(
  context: FileStateContext,
  filePath: string,
): boolean {
  const ownerId = getOwnerId(context)
  const normalizedPath = normalize(filePath)
  const lastWriter = lastWriterByPath.get(normalizedPath)
  if (!lastWriter || lastWriter.ownerId === ownerId) return false

  const readStamp = context.readFileState.get(normalizedPath)
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
  const paths = new Set(Array.from(filePaths, path => normalize(path)))
  const stalePaths: string[] = []

  for (const [path, lastWriter] of lastWriterByPath) {
    if (!paths.has(path)) continue
    if (lastWriter.ownerId === ownerId) continue
    if (lastWriter.sequence <= sinceSequence) continue

    const readStamp = context.readFileState.get(path)
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
  const normalizedPath = normalize(filePath)
  const previousTail = pathLockTails.get(normalizedPath)
  let release!: () => void
  const currentGate = new Promise<void>(resolve => {
    release = resolve
  })
  const currentTail = (previousTail ?? Promise.resolve()).then(
    () => currentGate,
    () => currentGate,
  )

  pathLockTails.set(normalizedPath, currentTail)
  pathLockDepths.set(
    normalizedPath,
    (pathLockDepths.get(normalizedPath) ?? 0) + 1,
  )

  try {
    if (previousTail) {
      await previousTail.catch(() => {})
    }
    return await callback()
  } finally {
    release()
    const nextDepth = (pathLockDepths.get(normalizedPath) ?? 1) - 1
    if (nextDepth <= 0) {
      pathLockDepths.delete(normalizedPath)
    } else {
      pathLockDepths.set(normalizedPath, nextDepth)
    }
    if (pathLockTails.get(normalizedPath) === currentTail) {
      pathLockTails.delete(normalizedPath)
    }
  }
}

export function getFileStatePathLockDepthForTests(filePath: string): number {
  return pathLockDepths.get(normalize(filePath)) ?? 0
}

export function clearFileStateRegistryForTests(): void {
  sequence = 0
  nextOwnerId = 0
  lastWriterByPath.clear()
  pathLockTails.clear()
  pathLockDepths.clear()
}
