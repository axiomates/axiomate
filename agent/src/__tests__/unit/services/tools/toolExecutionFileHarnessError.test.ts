import { z } from 'zod/v4'
import { describe, expect, test, vi } from 'vitest'
import { runToolUse } from '../../../../services/tools/toolExecution.js'
import type { CanUseToolFn } from '../../../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../../../Tool.js'
import { getEmptyToolPermissionContext } from '../../../../Tool.js'
import type { AssistantMessage } from '../../../../types/message.js'
import { throwFileHarnessFailure } from '../../../../utils/fileHarnessFailures.js'

vi.mock('../../../../services/tools/toolHooks.js', () => ({
  resolveHookPermissionDecision: async (
    _hookPermissionResult: unknown,
    _tool: unknown,
    input: Record<string, unknown>,
  ) => ({
    decision: { behavior: 'allow' },
    input,
  }),
  runPostToolUseFailureHooks: async function* () {},
  runPostToolUseHooks: async function* () {},
  runPreToolUseHooks: async function* () {},
}))

function makeThrowingTool(): Tool {
  return {
    name: 'FakeFileHarnessTool',
    inputSchema: z.strictObject({ path: z.string() }),
    isReadOnly: () => true,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    description: async () => 'fake',
    prompt: async () => 'fake',
    userFacingName: () => 'Fake',
    call: async input => {
      throwFileHarnessFailure(
        'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        'stale_content',
        'execution',
        input.path,
      )
    },
    mapToolResultToToolResultBlockParam: () => ({
      type: 'tool_result',
      content: 'unreachable',
      tool_use_id: 'toolu_fake',
    }),
  } as unknown as Tool
}

function makeContext(tool: Tool): ToolUseContext {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [tool],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
      },
    },
    abortController: new AbortController(),
    getAppState: () =>
      ({
        toolPermissionContext: getEmptyToolPermissionContext(),
      }) as never,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    readFileState: undefined as never,
    messages: [],
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
  } as ToolUseContext
}

const allowToolUse: CanUseToolFn = async () => ({ behavior: 'allow' })

const assistantMessage = {
  type: 'assistant',
  uuid: 'assistant-message',
  timestamp: new Date(0).toISOString(),
  message: {
    id: 'msg_1',
    role: 'assistant',
    content: [],
    model: 'test-model',
  },
} as unknown as AssistantMessage

describe('runToolUse file harness failures', () => {
  test('catches thrown FileHarnessError and returns an error tool_result', async () => {
    const tool = makeThrowingTool()
    const updates = []

    for await (const update of runToolUse(
      {
        type: 'tool_use',
        id: 'toolu_fake',
        name: tool.name,
        input: { path: '/tmp/notebook.ipynb' },
      },
      assistantMessage,
      allowToolUse,
      makeContext(tool),
    )) {
      updates.push(update)
    }

    expect(updates).toHaveLength(1)
    const message = updates[0]!.message.message
    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'toolu_fake',
        is_error: true,
      }),
    ])
    const result = Array.isArray(message.content) ? message.content[0] : null
    expect(result).toMatchObject({
      type: 'tool_result',
      is_error: true,
      tool_use_id: 'toolu_fake',
    })
    expect(result && 'content' in result ? result.content : '').toContain(
      'File has been modified since read',
    )
    expect(result && 'content' in result ? result.content : '').not.toContain(
      'Error calling tool',
    )
  })
})
