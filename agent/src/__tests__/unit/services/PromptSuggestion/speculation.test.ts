import { randomUUID, type UUID } from 'node:crypto'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppState } from '../../../../state/AppStateStore.js'
import { asAgentId } from '../../../../types/ids.js'
import type { Message } from '../../../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../../../utils/fileStateCache.js'
import {
  clearFileStateRegistryForTests,
  noteFileWrite,
  wasFileModifiedAfterReadByAnotherContext,
} from '../../../../utils/fileStateRegistry.js'
import {
  handleSpeculationAccept,
  type ActiveSpeculationState,
} from '../../../../services/PromptSuggestion/speculation.js'

const mocks = vi.hoisted(() => ({
  getCwdState: vi.fn(() => process.cwd()),
  getIsNonInteractiveSession: vi.fn(() => false),
  getInitialSettings: vi.fn(() => ({ promptSuggestionEnabled: true })),
}))

vi.mock('../../../../bootstrap/state.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../bootstrap/state.js')>()),
  getCwdState: mocks.getCwdState,
  getIsNonInteractiveSession: mocks.getIsNonInteractiveSession,
}))

vi.mock('../../../../utils/settings/settings.js', () => ({
  getInitialSettings: mocks.getInitialSettings,
}))

vi.mock('../../../../utils/forkedAgent.js', () => ({
  createCacheSafeParams: vi.fn(),
  runForkedAgent: vi.fn(),
}))

vi.mock('../../../../utils/permissions/filesystem.js', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../../../utils/permissions/filesystem.js')
  >()),
  getAxiomateTempDir: vi.fn(() => join(process.cwd(), '.tmp-speculation')),
}))

vi.mock('../../../../utils/messages.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../utils/messages.js')>()),
  createUserMessage: vi.fn(({ content }: { content: unknown }) => ({
    type: 'user',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content },
  })),
}))

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Message {
  return {
    type: 'assistant',
    uuid: randomUUID() as UUID,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'test',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as Message
}

function readResult(
  id: string,
  timestamp: string,
  content: string,
): Message {
  return {
    type: 'user',
    uuid: randomUUID() as UUID,
    timestamp,
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
  } as Message
}

function makeActiveSpeculationState(
  messages: Message[],
): ActiveSpeculationState {
  return {
    status: 'active',
    id: 'spec-test',
    abort: vi.fn(),
    startTime: 1_000,
    messagesRef: { current: messages },
    writtenPathsRef: { current: new Set<string>() },
    boundary: {
      type: 'complete',
      completedAt: 1_000,
      outputTokens: 0,
    },
    suggestionLength: 0,
    toolUseCount: 1,
    isPipelined: false,
    contextRef: {
      current: {
        messages: [],
        toolUseContext: {
          getAppState: () => makeAppState(),
        },
      } as never,
    },
  } as ActiveSpeculationState
}

function makeAppState(): AppState {
  return {
    promptSuggestion: {
      text: 'suggestion',
      promptId: 'user_intent',
      shownAt: 1,
      acceptedAt: 0,
      generationRequestId: 'generation-1',
    },
    speculation: { status: 'idle' },
    speculationSessionTimeSavedMs: 0,
  } as AppState
}

function applySetAppState(
  state: { current: AppState },
): (f: (prev: AppState) => AppState) => void {
  return f => {
    state.current = f(state.current)
  }
}

describe('handleSpeculationAccept file state restoration', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
    mocks.getCwdState.mockReturnValue(process.cwd())
    mocks.getIsNonInteractiveSession.mockReturnValue(false)
    mocks.getInitialSettings.mockReturnValue({ promptSuggestionEnabled: true })
  })

  test('records accepted speculation Read results as observed runtime reads', async () => {
    const cwd = process.cwd()
    const file = join(cwd, 'speculation-read.txt')
    const messages = [
      assistantToolUse('read-1', 'Read', { file_path: file }),
      readResult(
        'read-1',
        '2026-01-01T00:00:01.000Z',
        '     1\talpha\n     2\tbeta',
      ),
    ]
    const appState = { current: makeAppState() }
    const readFileState = {
      current: createFileStateCacheWithSizeLimit(10),
    }
    const renderedMessages: Message[] = []
    const earlierChild = {
      agentId: asAgentId('achild000000000201'),
      readFileState: createFileStateCacheWithSizeLimit(10),
    }
    noteFileWrite(earlierChild, file)

    const result = await handleSpeculationAccept(
      makeActiveSpeculationState(messages),
      0,
      applySetAppState(appState),
      'accepted input',
      {
        setMessages: update => {
          renderedMessages.splice(
            0,
            renderedMessages.length,
            ...update(renderedMessages),
          )
        },
        readFileState,
        cwd,
      },
    )

    expect(result).toEqual({ queryRequired: false })
    const restored = readFileState.current.get(file)
    expect(restored?.content).toBe('alpha\nbeta')
    // Speculated (reconstructed) reads are not stamped, so the registry
    // abstains on the concurrent sibling write rather than masking it with a
    // freshly-minted stamp. Staleness is then decided by the content/mtime gate
    // when a write is actually attempted.
    expect(restored?.registrySequence).toBeUndefined()

    expect(
      wasFileModifiedAfterReadByAnotherContext(
        { readFileState: readFileState.current },
        file,
      ),
    ).toBe(false)
  })
})
