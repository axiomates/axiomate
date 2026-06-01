import type { ToolUseContext } from '../../Tool.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  getFileStateRegistrySequence,
  getKnownReadFilePaths,
  getPathsWrittenByOtherContextsSince,
} from '../../utils/fileStateRegistry.js'
import type { AgentToolResult } from './agentToolUtils.js'

const MAX_REMINDER_PATHS = 8

export type SubagentFileStateReminderSnapshot = {
  sequence: number
  parentReadPaths: string[]
}

export function captureSubagentFileStateReminderSnapshot(
  parentContext: Pick<ToolUseContext, 'agentId' | 'readFileState'>,
): SubagentFileStateReminderSnapshot {
  return {
    sequence: getFileStateRegistrySequence(),
    parentReadPaths: getKnownReadFilePaths(parentContext),
  }
}

function buildSubagentFileStateReminder(
  parentContext: Pick<ToolUseContext, 'agentId' | 'readFileState'>,
  snapshot: SubagentFileStateReminderSnapshot,
): string | null {
  if (snapshot.parentReadPaths.length === 0) return null

  const paths = getPathsWrittenByOtherContextsSince(
    parentContext,
    snapshot.sequence,
    snapshot.parentReadPaths,
  )
  if (paths.length === 0) return null

  const displayPaths = paths.slice(0, MAX_REMINDER_PATHS).map(getDisplayPath)
  const more =
    paths.length > MAX_REMINDER_PATHS
      ? ` (+${paths.length - MAX_REMINDER_PATHS} more)`
      : ''

  return `[NOTE: subagent modified files the parent previously read. Re-read before editing: ${displayPaths.join(', ')}${more}]`
}

export function appendSubagentFileStateReminderToResult<
  TResult extends AgentToolResult,
>(
  result: TResult,
  parentContext: Pick<ToolUseContext, 'agentId' | 'readFileState'>,
  snapshot: SubagentFileStateReminderSnapshot,
): TResult {
  const reminder = buildSubagentFileStateReminder(parentContext, snapshot)
  if (!reminder) return result

  return {
    ...result,
    content: [...result.content, { type: 'text', text: reminder }],
  }
}

export function appendSubagentFileStateReminderToText(
  text: string,
  parentContext: Pick<ToolUseContext, 'agentId' | 'readFileState'>,
  snapshot: SubagentFileStateReminderSnapshot,
): string {
  const reminder = buildSubagentFileStateReminder(parentContext, snapshot)
  return reminder ? `${text}\n\n${reminder}` : text
}

export function appendSubagentFileStateReminderToOptionalText(
  text: string | undefined,
  parentContext: Pick<ToolUseContext, 'agentId' | 'readFileState'>,
  snapshot: SubagentFileStateReminderSnapshot,
): string | undefined {
  const reminder = buildSubagentFileStateReminder(parentContext, snapshot)
  if (!reminder) return text
  return text ? `${text}\n\n${reminder}` : reminder
}
