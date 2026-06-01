import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppState } from '../../../../state/AppState.js'
import { createAssistantMessage } from '../../../../utils/messages.js'
import { AbortError } from '../../../../utils/errors.js'
import { createFileStateCacheWithSizeLimit } from '../../../../utils/fileStateCache.js'
import {
  clearFileStateRegistryForTests,
  noteFileWrite,
  recordFileRead,
} from '../../../../utils/fileStateRegistry.js'
import {
  getPendingNotificationsSnapshot,
  resetPendingNotifications,
} from '../../../../utils/messageQueueManager.js'
import { asAgentId } from '../../../../types/ids.js'
import type { ToolUseContext } from '../../../../Tool.js'
import { runAsyncAgentLifecycle } from '../../../../tools/AgentTool/agentToolUtils.js'
import { captureSubagentFileStateReminderSnapshot } from '../../../../tools/AgentTool/fileStateReminder.js'
import {
  getHarnessCwd,
  makeToolContext,
  mockFileHarnessRuntime,
  setupFileHarness,
} from '../FileHarness/helpers.js'

mockFileHarnessRuntime()
setupFileHarness()

vi.mock('../../../../services/AgentSummary/agentSummary.js', () => ({
  startAgentSummarization: vi.fn(() => ({ stop: vi.fn() })),
}))

vi.mock('../../../../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))

vi.mock('../../../../utils/sessionStorage.js', () => ({
  getAgentTranscriptPath: (agentId: string) =>
    join(getHarnessCwd(), `${agentId}.jsonl`),
  recordQueueOperation: vi.fn(async () => {}),
}))

vi.mock('../../../../utils/task/diskOutput.js', () => ({
  evictTaskOutput: vi.fn(async () => {}),
  getTaskOutputPath: (taskId: string) => join(getHarnessCwd(), `${taskId}.out`),
  initTaskOutputAsSymlink: vi.fn(async () => {}),
}))

let registerAsyncAgent: typeof import('../../../../tasks/LocalAgentTask/LocalAgentTask.js')['registerAsyncAgent']

beforeAll(async () => {
  ;({ registerAsyncAgent } = await import(
    '../../../../tasks/LocalAgentTask/LocalAgentTask.js'
  ))
}, 120_000)

function createStateHarness(): {
  getState: () => AppState
  setState: (updater: (prev: AppState) => AppState) => void
} {
  let state = {
    tasks: {},
    speculation: { status: 'idle' },
  } as AppState
  return {
    getState: () => state,
    setState: updater => {
      state = updater(state)
    },
  }
}

function makeMetadata() {
  return {
    prompt: 'child prompt',
    resolvedAgentModel: 'test-model',
    isBuiltInAgent: false,
    startTime: Date.now(),
    agentType: 'test-agent',
    isAsync: true,
  }
}

function makeAssistant(text: string) {
  return createAssistantMessage({
    content: text,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
      inference_geo: null,
      iterations: null,
      speed: null,
    },
  })
}

async function* streamThenThrow(error: Error) {
  yield makeAssistant('partial child result')
  throw error
}

async function* throwImmediately(error: Error) {
  throw error
  yield makeAssistant('unreachable')
}

function seedParentReadAndChildWrite(
  parentContext: ToolUseContext,
  path: string,
): ReturnType<typeof captureSubagentFileStateReminderSnapshot> {
  parentContext.readFileState.set(path, {
    content: 'before\n',
    timestamp: 1,
    offset: undefined,
    limit: undefined,
  })
  recordFileRead(parentContext, path)
  const snapshot = captureSubagentFileStateReminderSnapshot(parentContext)
  const childReadFileState = createFileStateCacheWithSizeLimit(10)
  childReadFileState.set(path, {
    content: 'after\n',
    timestamp: 2,
    offset: undefined,
    limit: undefined,
  })
  noteFileWrite(
    {
      agentId: asAgentId('achild000000000501'),
      readFileState: childReadFileState,
    },
    path,
  )
  return snapshot
}

function latestNotificationText(): string {
  const notifications = getPendingNotificationsSnapshot()
  const latest = notifications.at(-1)
  if (!latest || typeof latest.value !== 'string') {
    throw new Error('Expected a string notification')
  }
  return latest.value
}

async function runLifecycleFailureCase({
  taskId,
  context,
  error,
  includePartial,
}: {
  taskId: string
  context: ToolUseContext
  error: Error
  includePartial: boolean
}): Promise<string> {
  const stateHarness = createStateHarness()
  registerAsyncAgent({
    agentId: taskId,
    description: 'child task',
    prompt: 'child prompt',
    selectedAgent: {
      agentType: 'test-agent',
      whenToUse: 'test',
      tools: [],
      source: 'projectSettings',
      getSystemPrompt: () => 'test agent',
    },
    setAppState: stateHarness.setState,
    toolUseId: 'toolu-hr9',
  })

  const path = join(getHarnessCwd(), `${taskId}.txt`)
  await writeFile(path, 'before\n', 'utf8')
  const snapshot = seedParentReadAndChildWrite(context, path)

  await runAsyncAgentLifecycle({
    taskId,
    abortController: new AbortController(),
    makeStream: () =>
      includePartial ? streamThenThrow(error) : throwImmediately(error),
    metadata: makeMetadata(),
    description: 'child task',
    toolUseContext: context,
    rootSetAppState: stateHarness.setState,
    agentIdForCleanup: taskId,
    enableSummarization: false,
    getWorktreeResult: async () => ({}),
    fileStateReminderSnapshot: snapshot,
  })

  return latestNotificationText()
}

describe('AgentTool lifecycle file state reminders', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
    resetPendingNotifications()
  })

  test('adds file-state reminder to killed async-agent notification with partial result', async () => {
    const context = makeToolContext()

    const notification = await runLifecycleFailureCase({
      taskId: 'ahr900000001',
      context,
      error: new AbortError('stopped'),
      includePartial: true,
    })

    expect(notification).toContain('<status>killed</status>')
    expect(notification).toContain('partial child result')
    expect(notification).toContain('subagent modified files')
    expect(notification).toContain('ahr900000001.txt')
  })

  test('adds file-state reminder to killed async-agent notification without partial result', async () => {
    const context = makeToolContext()

    const notification = await runLifecycleFailureCase({
      taskId: 'ahr900000002',
      context,
      error: new AbortError('stopped'),
      includePartial: false,
    })

    expect(notification).toContain('<status>killed</status>')
    expect(notification).toContain('<result>')
    expect(notification).toContain('subagent modified files')
    expect(notification).toContain('ahr900000002.txt')
  })

  test('adds file-state reminder to failed async-agent notification without changing failed status', async () => {
    const context = makeToolContext()

    const notification = await runLifecycleFailureCase({
      taskId: 'ahr900000003',
      context,
      error: new Error('child failed'),
      includePartial: false,
    })

    expect(notification).toContain('<status>failed</status>')
    expect(notification).toContain('Agent "child task" failed: child failed')
    expect(notification).toContain('<result>')
    expect(notification).toContain('subagent modified files')
    expect(notification).toContain('ahr900000003.txt')
  })
})
