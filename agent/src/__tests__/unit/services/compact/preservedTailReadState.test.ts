import { randomUUID } from 'crypto'
import { describe, expect, it, vi } from 'vitest'

import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../../../utils/fileStateCache.js'

vi.mock('../../../../utils/forkedAgent.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/forkedAgent.js')>()
  return {
    ...actual,
    runForkedAgent: vi.fn(async () => {
      const fakeAssistant: AssistantMessage = {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          id: `msg_${randomUUID()}`,
          role: 'assistant',
          model: 'test-model',
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: 'text', text: 'synthetic compact summary' }],
        },
      } as unknown as AssistantMessage
      return {
        messages: [fakeAssistant],
        totalUsage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }
    }),
  }
})

import { partialCompactConversation } from '../../../../services/compact/compact.js'

function makeUserMsg(text: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  } as unknown as UserMessage
}

function makeAssistantTextMsg(text: string): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:00.500Z',
    message: {
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: 'text', text }],
    },
  } as unknown as Message
}

function makeReadToolUse(id: string, filePath: string): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Read',
          input: { file_path: filePath },
        },
      ],
    },
  } as unknown as Message
}

function makeToolResult(id: string, content: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:01.500Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
        },
      ],
    },
  } as unknown as UserMessage
}

function makeMinimalContext() {
  const abortController = new AbortController()
  const appState = {
    mainLoopModel: 'test-model',
    mainLoopModelOverrideForSession: {
      type: 'single-model-route' as const,
      modelId: 'test-model',
    },
    verbose: false,
    thinkingEnabled: false,
    promptSuggestionEnabled: false,
    settings: {},
    tasks: {},
    toolPermissionContext: { mode: 'default' as const },
    messages: [],
    pendingToolUseMessages: [],
    isLoading: false,
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { builtIn: [], user: [], project: [], activeAgents: [] },
      querySource: 'cli' as const,
    },
    abortController,
    readFileState: createFileStateCacheWithSizeLimit(100, 1_000_000),
    loadedNestedMemoryPaths: new Set<string>(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    setSDKStatus: () => {},
    setStreamMode: () => {},
    setResponseLength: () => {},
    onCompactProgress: () => {},
  }
}

describe('partial compact preserved-tail read state', () => {
  it('reconstructs readFileState for Read results kept verbatim after compact', async () => {
    const filePath = 'src/preserved-tail-read.txt'
    const context = makeMinimalContext()
    context.readFileState.set(filePath, {
      content: 'alpha\nbeta',
      timestamp: new Date('2026-01-01T00:00:01.500Z').getTime(),
      offset: undefined,
      limit: undefined,
    })

    const readId = 'read-preserved'
    const messages: Message[] = [
      makeUserMsg('please inspect this file'),
      makeReadToolUse(readId, filePath),
      makeToolResult(readId, '1\talpha\n2\tbeta'),
      makeUserMsg('now summarize later turns'),
      makeAssistantTextMsg('later turn to compact'),
    ]

    await partialCompactConversation(
      messages,
      3,
      context as never,
      {
        forkContextMessages: messages,
        systemPrompt: { text: '' },
        userContext: {},
        systemContext: {},
        toolUseContext: {},
      } as never,
      undefined,
      'from',
    )

    const restored = context.readFileState.get(filePath)
    expect(restored?.content).toBe('alpha\nbeta')
    expect(restored?.offset).toBeUndefined()
    expect(restored?.limit).toBeUndefined()
  }, 30_000)
})
