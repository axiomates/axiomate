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

export function clearFileStateRegistryForTests(): void {
  sequence = 0
  nextOwnerId = 0
  lastWriterByPath.clear()
}
