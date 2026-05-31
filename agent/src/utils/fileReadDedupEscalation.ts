import { normalize } from 'path'
import type { ToolUseContext } from '../Tool.js'
import type { FileState } from './fileStateCache.js'

export type FileReadDedupEscalationLevel = 'none' | 'reread-loop' | 'stop'

export type FileReadDedupEscalation = {
  path: string
  count: number
  level: FileReadDedupEscalationLevel
}

type TrackerState = {
  path: string
  readState: FileState
  offset: number
  limit: number | undefined
  count: number
}

const trackersByReadFileState = new WeakMap<
  ToolUseContext['readFileState'],
  TrackerState
>()

function escalationLevel(count: number): FileReadDedupEscalationLevel {
  if (count >= 3) return 'stop'
  if (count >= 2) return 'reread-loop'
  return 'none'
}

export function recordFileReadDedupHit(
  context: Pick<ToolUseContext, 'readFileState'>,
  filePath: string,
  readState: FileState,
  offset: number,
  limit: number | undefined,
): FileReadDedupEscalation {
  const path = normalize(filePath)
  const previous = trackersByReadFileState.get(context.readFileState)
  const count =
    previous &&
    previous.path === path &&
    previous.readState === readState &&
    previous.offset === offset &&
    previous.limit === limit
      ? previous.count + 1
      : 1

  trackersByReadFileState.set(context.readFileState, {
    path,
    readState,
    offset,
    limit,
    count,
  })

  return {
    path,
    count,
    level: escalationLevel(count),
  }
}

export function clearFileReadDedupHits(
  context: Pick<ToolUseContext, 'readFileState'>,
  filePath: string,
): void {
  const previous = trackersByReadFileState.get(context.readFileState)
  if (!previous || previous.path !== normalize(filePath)) return
  trackersByReadFileState.delete(context.readFileState)
}

export function buildFileReadDedupEscalationHint(
  escalation:
    | Pick<FileReadDedupEscalation, 'count' | 'level'>
    | undefined,
): string {
  if (!escalation || escalation.level === 'none') return ''
  if (escalation.level === 'stop') {
    return (
      '\n\nSTOP: repeated Read calls are returning the same unchanged-content stub. ' +
      'Use the earlier Read result already in this conversation, or read a different offset/range if you need new context.'
    )
  }
  return (
    '\n\nRepeated Read calls are returning the same unchanged-content stub. ' +
    'Use the earlier Read result already in this conversation instead of rereading the same unchanged range.'
  )
}
