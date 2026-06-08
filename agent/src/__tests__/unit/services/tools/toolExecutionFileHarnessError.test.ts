import { z } from 'zod/v4'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runToolUse } from '../../../../services/tools/toolExecution.js'
import type { CanUseToolFn } from '../../../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../../../Tool.js'
import { getEmptyToolPermissionContext } from '../../../../Tool.js'
import type { AssistantMessage } from '../../../../types/message.js'
import { throwFileHarnessFailure } from '../../../../utils/fileHarnessFailures.js'
import { withFileStatePathLock } from '../../../../utils/fileStateRegistry.js'

const hookMockState = vi.hoisted(() => ({
  preHookUpdatedInput: undefined as Record<string, unknown> | undefined,
  permissionUpdatedInput: undefined as Record<string, unknown> | undefined,
}))

vi.mock('../../../../services/tools/toolHooks.js', () => ({
  resolveHookPermissionDecision: async (
    _hookPermissionResult: unknown,
    _tool: unknown,
    input: Record<string, unknown>,
  ) => ({
    decision: hookMockState.permissionUpdatedInput
      ? {
          behavior: 'allow',
          updatedInput: hookMockState.permissionUpdatedInput,
        }
      : { behavior: 'allow' },
    input,
  }),
  runPostToolUseFailureHooks: async function* () {},
  runPostToolUseHooks: async function* () {},
  runPreToolUseHooks: async function* () {
    if (hookMockState.preHookUpdatedInput) {
      yield {
        type: 'hookUpdatedInput',
        updatedInput: hookMockState.preHookUpdatedInput,
      }
    }
  },
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

function makeReentrantPathLockTool(): Tool {
  return {
    name: 'FakeReentrantPathLockTool',
    inputSchema: z.strictObject({ path: z.string() }),
    isReadOnly: () => true,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    description: async () => 'fake',
    prompt: async () => 'fake',
    userFacingName: () => 'Fake',
    call: async input => {
      await withFileStatePathLock(input.path, async () => {
        await withFileStatePathLock(input.path, async () => {})
      })
      return { data: 'unreachable' }
    },
    mapToolResultToToolResultBlockParam: () => ({
      type: 'tool_result',
      content: 'unreachable',
      tool_use_id: 'toolu_fake',
    }),
  } as unknown as Tool
}

function makeValidatingTool(callSpy: ReturnType<typeof vi.fn>): Tool {
  return {
    name: 'FakeValidatingTool',
    inputSchema: z.strictObject({ mode: z.string() }),
    isReadOnly: () => true,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    description: async () => 'fake',
    prompt: async () => 'fake',
    userFacingName: () => 'Fake',
    validateInput: async input =>
      input.mode === 'bad'
        ? {
            result: false,
            behavior: 'ask',
            message: 'bad mode rejected',
            errorCode: 99,
          }
        : { result: true },
    call: async input => {
      callSpy(input)
      return { data: `called:${input.mode}` }
    },
    mapToolResultToToolResultBlockParam: (content, toolUseID) => ({
      type: 'tool_result',
      content: String(content),
      tool_use_id: toolUseID,
    }),
  } as unknown as Tool
}

function makeInternalInputTool(callSpy: ReturnType<typeof vi.fn>): Tool {
  return {
    name: 'Bash',
    inputSchema: z.strictObject({ command: z.string() }),
    permissionUpdatedInputSchema: z.strictObject({
      command: z.string(),
      _simulatedSedEdit: z.object({
        filePath: z.string(),
        newContent: z.string(),
      }),
    }),
    isReadOnly: () => true,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    description: async () => 'fake',
    prompt: async () => 'fake',
    userFacingName: () => 'Fake',
    call: async input => {
      callSpy(input)
      return { data: 'called' }
    },
    mapToolResultToToolResultBlockParam: (content, toolUseID) => ({
      type: 'tool_result',
      content: String(content),
      tool_use_id: toolUseID,
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

async function collectRunToolUse(
  tool: Tool,
  input: Record<string, unknown>,
) {
  const updates = []
  for await (const update of runToolUse(
    {
      type: 'tool_use',
      id: 'toolu_fake',
      name: tool.name,
      input,
    },
    assistantMessage,
    allowToolUse,
    makeContext(tool),
  )) {
    updates.push(update)
  }
  return updates
}

function firstToolResultContent(updates: Awaited<ReturnType<typeof collectRunToolUse>>): string {
  const message = updates[0]?.message.message
  const result = Array.isArray(message?.content) ? message.content[0] : null
  return result && 'content' in result ? String(result.content) : ''
}

beforeEach(() => {
  hookMockState.preHookUpdatedInput = undefined
  hookMockState.permissionUpdatedInput = undefined
})

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

  test('converts same-path lock reentry into an error tool_result', async () => {
    const tool = makeReentrantPathLockTool()
    const updates = []
    const path = join(tmpdir(), 'axiomate-reentrant-tool-test.txt')

    for await (const update of runToolUse(
      {
        type: 'tool_use',
        id: 'toolu_fake',
        name: tool.name,
        input: { path },
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
    const result = Array.isArray(message.content) ? message.content[0] : null
    expect(result).toMatchObject({
      type: 'tool_result',
      is_error: true,
      tool_use_id: 'toolu_fake',
    })
    expect(result && 'content' in result ? result.content : '').toContain(
      'File state path lock is not reentrant',
    )
  })

  test('revalidates PreToolUse updatedInput before calling the tool', async () => {
    const callSpy = vi.fn()
    const tool = makeValidatingTool(callSpy)
    hookMockState.preHookUpdatedInput = { mode: 'bad' }

    const updates = await collectRunToolUse(tool, { mode: 'good' })

    expect(callSpy).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
    expect(firstToolResultContent(updates)).toContain('bad mode rejected')
    const message = updates[0]!.message.message
    const result = Array.isArray(message.content) ? message.content[0] : null
    expect(result).toMatchObject({
      type: 'tool_result',
      is_error: true,
      tool_use_id: 'toolu_fake',
    })
  })

  test('revalidates permission updatedInput before calling the tool', async () => {
    const callSpy = vi.fn()
    const tool = makeValidatingTool(callSpy)
    hookMockState.permissionUpdatedInput = { mode: 'bad' }

    const updates = await collectRunToolUse(tool, { mode: 'good' })

    expect(callSpy).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
    expect(firstToolResultContent(updates)).toContain('bad mode rejected')
    const message = updates[0]!.message.message
    const result = Array.isArray(message.content) ? message.content[0] : null
    expect(result).toMatchObject({
      type: 'tool_result',
      is_error: true,
      tool_use_id: 'toolu_fake',
    })
  })

  test('allows internal permission updatedInput without allowing PreToolUse to inject it', async () => {
    const permissionCallSpy = vi.fn()
    const permissionTool = makeInternalInputTool(permissionCallSpy)
    hookMockState.permissionUpdatedInput = {
      command: 'sed -i s/a/b/ file.txt',
      _simulatedSedEdit: {
        filePath: 'file.txt',
        newContent: 'b\n',
      },
    }

    const permissionUpdates = await collectRunToolUse(permissionTool, {
      command: 'sed -i s/a/b/ file.txt',
    })

    expect(permissionUpdates).toHaveLength(1)
    expect(firstToolResultContent(permissionUpdates)).toBe('called')
    expect(permissionCallSpy).toHaveBeenCalledWith({
      command: 'sed -i s/a/b/ file.txt',
      _simulatedSedEdit: {
        filePath: 'file.txt',
        newContent: 'b\n',
      },
    })

    const preHookCallSpy = vi.fn()
    const preHookTool = makeInternalInputTool(preHookCallSpy)
    hookMockState.permissionUpdatedInput = undefined
    hookMockState.preHookUpdatedInput = {
      command: 'sed -i s/a/b/ file.txt',
      _simulatedSedEdit: {
        filePath: 'file.txt',
        newContent: 'b\n',
      },
    }

    const preHookUpdates = await collectRunToolUse(preHookTool, {
      command: 'sed -i s/a/b/ file.txt',
    })

    expect(preHookCallSpy).not.toHaveBeenCalled()
    expect(firstToolResultContent(preHookUpdates)).toContain(
      'unexpected parameter `_simulatedSedEdit`',
    )
  })
})
