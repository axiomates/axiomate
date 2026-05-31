import { normalize } from 'path'
import type { ToolUseContext } from '../Tool.js'
import type { FileHarnessFailureReason } from './fileHarnessFailures.js'
import type { FileState } from './fileStateCache.js'

export type FileEditFailureEscalationReason = Extract<
  FileHarnessFailureReason,
  'string_not_found' | 'multiple_match'
>

export type FileEditFailureEscalationLevel = 'none' | 'reread' | 'stop'

export type FileEditFailureEscalation = {
  reason: FileEditFailureEscalationReason
  path: string
  count: number
  level: FileEditFailureEscalationLevel
}

type FailureKey = {
  path: string
  reason: FileEditFailureEscalationReason
  readState: FileState
}

type TrackerState = FailureKey & {
  count: number
}

const trackersByReadFileState = new WeakMap<
  ToolUseContext['readFileState'],
  TrackerState
>()

function escalationLevel(count: number): FileEditFailureEscalationLevel {
  if (count >= 3) return 'stop'
  if (count >= 2) return 'reread'
  return 'none'
}

function isFileEditFailureEscalation(
  value: unknown,
): value is FileEditFailureEscalation {
  return (
    value !== null &&
    typeof value === 'object' &&
    'reason' in value &&
    (value.reason === 'string_not_found' ||
      value.reason === 'multiple_match') &&
    'path' in value &&
    typeof value.path === 'string' &&
    'count' in value &&
    typeof value.count === 'number' &&
    'level' in value &&
    (value.level === 'none' ||
      value.level === 'reread' ||
      value.level === 'stop')
  )
}

function ordinal(value: number): string {
  const suffix =
    value % 100 >= 11 && value % 100 <= 13
      ? 'th'
      : value % 10 === 1
        ? 'st'
        : value % 10 === 2
          ? 'nd'
          : value % 10 === 3
            ? 'rd'
            : 'th'
  return `${value}${suffix}`
}

export function buildFileEditFailureEscalationHint(
  meta: Record<string, unknown> | undefined,
): string | null {
  const escalation = meta?.fileEditFailureEscalation
  if (!isFileEditFailureEscalation(escalation)) return null
  if (escalation.level === 'none') return null

  const failureDescription =
    escalation.reason === 'multiple_match'
      ? '`old_string` matched multiple locations'
      : '`old_string` was not found'
  const recovery =
    escalation.reason === 'multiple_match'
      ? 'Read the target area again, then provide a longer unique `old_string`, or set `replace_all` only if every match should change.'
      : 'Read the target area again before trying another Edit; do not guess from stale context.'

  if (escalation.level === 'stop') {
    return (
      `\n\nSTOP: this is the ${ordinal(escalation.count)} consecutive ` +
      `FileEdit failure for this file since the last usable read: ${failureDescription}. ` +
      recovery
    )
  }

  return (
    `\n\nThis is the ${ordinal(escalation.count)} consecutive FileEdit failure ` +
    `for this file since the last usable read: ${failureDescription}. ${recovery}`
  )
}

export function recordFileEditMatchFailure(
  context: Pick<ToolUseContext, 'readFileState'>,
  filePath: string,
  reason: FileEditFailureEscalationReason,
): FileEditFailureEscalation {
  const path = normalize(filePath)
  const readState = context.readFileState.get(path)
  const previous = trackersByReadFileState.get(context.readFileState)
  const count =
    previous &&
    previous.path === path &&
    previous.reason === reason &&
    previous.readState === readState
      ? previous.count + 1
      : 1

  if (readState) {
    trackersByReadFileState.set(context.readFileState, {
      path,
      reason,
      readState,
      count,
    })
  } else {
    trackersByReadFileState.delete(context.readFileState)
  }

  return {
    reason,
    path,
    count,
    level: escalationLevel(count),
  }
}

export function clearFileEditMatchFailure(
  context: Pick<ToolUseContext, 'readFileState'>,
  filePath: string,
): void {
  const previous = trackersByReadFileState.get(context.readFileState)
  if (!previous || previous.path !== normalize(filePath)) return
  trackersByReadFileState.delete(context.readFileState)
}
