import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { beforeAll, describe, expect, test } from 'vitest'
import { asAgentId } from '../../../../types/ids.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
} from '../../../../utils/fileStateCache.js'
import { noteFileWrite } from '../../../../utils/fileStateRegistry.js'
import {
  appendSubagentFileStateReminderToResult,
  appendSubagentFileStateReminderToText,
  appendSubagentFileStateReminderToOptionalText,
  captureSubagentFileStateReminderSnapshot,
} from '../../../../tools/AgentTool/fileStateReminder.js'
import {
  allowToolUse,
  getHarnessCwd,
  makeToolContext,
  mockFileHarnessRuntime,
  parentMessage,
  setupFileHarness,
} from '../FileHarness/helpers.js'

mockFileHarnessRuntime()
setupFileHarness()

let FileReadTool: Awaited<
  typeof import('../../../../tools/FileReadTool/FileReadTool.js')
>['FileReadTool']

beforeAll(async () => {
  ;({ FileReadTool } = await import(
    '../../../../tools/FileReadTool/FileReadTool.js'
  ))
}, 120_000)

function makeAgentResult(content = 'child done') {
  return {
    agentId: 'child-agent',
    agentType: 'test-agent',
    content: [{ type: 'text' as const, text: content }],
    totalDurationMs: 1,
    totalTokens: 2,
    totalToolUseCount: 3,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  }
}

describe('AgentTool file state reminders', () => {
  function recordStructuredChildWrite(
    parentContext: ReturnType<typeof makeToolContext>,
    path: string,
    agentId: ReturnType<typeof asAgentId>,
  ): void {
    const childReadFileState = cloneFileStateCache(parentContext.readFileState)
    childReadFileState.set(path, {
      content: 'after\n',
      timestamp: 2,
      offset: undefined,
      limit: undefined,
    })
    noteFileWrite(
      {
        agentId,
        readFileState: childReadFileState,
      },
      path,
    )
  }

  test('appends a reminder when a subagent wrote a file the parent had read', async () => {
    const path = join(getHarnessCwd(), 'parent-read.txt')
    await writeFile(path, 'before\n', 'utf8')
    const parentContext = makeToolContext()
    await FileReadTool.call(
      { file_path: path },
      parentContext,
      allowToolUse,
      parentMessage,
    )

    const snapshot = captureSubagentFileStateReminderSnapshot(parentContext)
    recordStructuredChildWrite(
      parentContext,
      path,
      asAgentId('achild000000000401'),
    )

    const result = appendSubagentFileStateReminderToResult(
      makeAgentResult(),
      parentContext,
      snapshot,
    )

    expect(result.content).toHaveLength(2)
    expect(result.content[1]?.text).toContain('subagent modified files')
    expect(result.content[1]?.text).toContain('parent-read.txt')
  })

  test('does not append a reminder for files outside the parent read snapshot', async () => {
    const path = join(getHarnessCwd(), 'unread.txt')
    await writeFile(path, 'before\n', 'utf8')
    const parentContext = makeToolContext()
    const snapshot = captureSubagentFileStateReminderSnapshot(parentContext)

    noteFileWrite(
      {
        agentId: asAgentId('achild000000000402'),
        readFileState: createFileStateCacheWithSizeLimit(10),
      },
      path,
    )

    const result = appendSubagentFileStateReminderToResult(
      makeAgentResult(),
      parentContext,
      snapshot,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.text).toBe('child done')
  })

  test('appends the same reminder to background notification text', async () => {
    const path = join(getHarnessCwd(), 'background-read.txt')
    await writeFile(path, 'before\n', 'utf8')
    const parentContext = makeToolContext()
    await FileReadTool.call(
      { file_path: path },
      parentContext,
      allowToolUse,
      parentMessage,
    )
    const snapshot = captureSubagentFileStateReminderSnapshot(parentContext)
    recordStructuredChildWrite(
      parentContext,
      path,
      asAgentId('achild000000000403'),
    )

    const text = appendSubagentFileStateReminderToText(
      'child done',
      parentContext,
      snapshot,
    )

    expect(text).toContain('child done')
    expect(text).toContain('subagent modified files')
    expect(text).toContain('background-read.txt')
  })

  test('creates notification text from only the reminder when no partial text exists', async () => {
    const path = join(getHarnessCwd(), 'notification-only-read.txt')
    await writeFile(path, 'before\n', 'utf8')
    const parentContext = makeToolContext()
    await FileReadTool.call(
      { file_path: path },
      parentContext,
      allowToolUse,
      parentMessage,
    )
    const snapshot = captureSubagentFileStateReminderSnapshot(parentContext)
    recordStructuredChildWrite(
      parentContext,
      path,
      asAgentId('achild000000000404'),
    )

    const text = appendSubagentFileStateReminderToOptionalText(
      undefined,
      parentContext,
      snapshot,
    )

    expect(text).toContain('subagent modified files')
    expect(text).toContain('notification-only-read.txt')
  })

  test('keeps empty notification text absent when no reminder is needed', async () => {
    const parentContext = makeToolContext()
    const snapshot = captureSubagentFileStateReminderSnapshot(parentContext)

    const text = appendSubagentFileStateReminderToOptionalText(
      undefined,
      parentContext,
      snapshot,
    )

    expect(text).toBeUndefined()
  })
})
