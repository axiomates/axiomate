/**
 * Diagnostic unit test for PR 1 latent defect.
 *
 * PR 1 (a4dee4d) filters the previous compact summary out of the LOCAL
 * `messagesToSummarize` variable in compact.ts, but the primary forked-agent
 * path reads from cacheSafeParams.forkContextMessages (see forkedAgent.ts:517),
 * NOT from that local variable. Without a symmetric filter on forkContextMessages,
 * the LLM sees the previous summary twice: once in the fork context as an
 * isCompactSummary user message, and once in the iterative prompt's explicit
 * PREVIOUS SUMMARY section.
 *
 * This test mocks runForkedAgent to capture the cacheSafeParams it receives,
 * then asserts the previous summary was filtered out of forkContextMessages.
 * Pairs with the compact.ts fix that mirrors filterPreviousSummaryForIterativeCompact
 * onto cacheSafeParams.forkContextMessages.
 */
import { randomUUID } from 'crypto'
import { describe, expect, it, vi } from 'vitest'

import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../../../utils/fileStateCache.js'

// ---------------------------------------------------------------------------
// Mock runForkedAgent to capture the cacheSafeParams that would have been
// sent to the real fork. Return a synthetic successful response so
// compactConversation continues through its post-processing without trying
// to fall back to the streaming path.
// ---------------------------------------------------------------------------
let capturedForkParams:
  | { forkContextMessages: Message[] | null | undefined }
  | null = null

vi.mock('../../../../utils/forkedAgent.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/forkedAgent.js')>()
  return {
    ...actual,
    runForkedAgent: vi.fn(async (params: { cacheSafeParams: unknown }) => {
      const csp = params.cacheSafeParams as {
        forkContextMessages?: Message[] | null
      }
      capturedForkParams = { forkContextMessages: csp.forkContextMessages }
      // Return a synthetic ForkedAgentResult with a text-bearing assistant
      // message so getAssistantMessageText yields a non-empty string and
      // compactConversation proceeds through its post-compact bookkeeping.
      const fakeAssistant: AssistantMessage = {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        message: {
          id: `msg_${randomUUID()}`,
          role: 'assistant',
          model: 'test-model',
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: 'text', text: 'synthetic updated summary body' }],
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

// Imports AFTER vi.mock so they pick up the mocked runForkedAgent.
import { compactConversation } from '../../../../services/compact/compact.js'

// ---------------------------------------------------------------------------
// Fixture helpers — mirror compactFullPipeline.test.ts shapes
// ---------------------------------------------------------------------------

function makeBoundary(): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: { trigger: 'manual', preTokens: 40_000 },
  } as unknown as Message
}

function makeCompactSummaryMessage(
  bodyText: string,
  uuidOverride?: string,
): UserMessage {
  const content =
    'This session is being continued from a previous conversation that ran out of context. ' +
    'The summary below covers the earlier portion of the conversation.\n\n' +
    `Summary:\n${bodyText}`
  return {
    type: 'user',
    uuid: uuidOverride ?? randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  } as unknown as UserMessage
}

function makeUserMsg(text: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  } as unknown as UserMessage
}

function makeAssistantMsg(text: string): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
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

function makeMinimalContext() {
  const abortController = new AbortController()
  const appState = {
    mainLoopModel: 'test-model',
    mainLoopModelForSession: 'test-model',
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
      agentDefinitions: { builtIn: [], user: [], project: [] },
      querySource: 'cli' as const,
    },
    abortController,
    readFileState: createFileStateCacheWithSizeLimit(100, 1_000_000),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    setSDKStatus: () => {},
    setStreamMode: () => {},
    setResponseLength: () => {},
    onCompactProgress: () => {},
  }
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe('iterative filter — fork path symmetry (PR 1 latent defect)', () => {
  it('forked-agent path must receive forkContextMessages WITHOUT the previous summary', async () => {
    const priorSummaryUuid = randomUUID()
    const messages: Message[] = [
      makeUserMsg('original question'),
      makeAssistantMsg('answer'),
      makeBoundary(),
      makeCompactSummaryMessage('prior summary body', priorSummaryUuid),
      makeUserMsg('new turn after compact'),
      makeAssistantMsg('new response'),
    ]

    // Sanity: the prior summary is present in the source messages.
    expect(messages.some(m => m.uuid === priorSummaryUuid)).toBe(true)

    // Force the primary path: pass a real forkContextMessages (full history
    // including the prior summary). If runForkedAgent received this unfiltered,
    // the LLM would see the summary twice.
    const cacheSafeParams = {
      forkContextMessages: messages,
      systemPrompt: { text: '' },
      userContext: {},
      systemContext: {},
      toolUseContext: {},
    }

    capturedForkParams = null
    await compactConversation(
      messages,
      makeMinimalContext() as never,
      cacheSafeParams as never,
      true,
      undefined,
      false,
    )

    expect(capturedForkParams).not.toBeNull()
    const forkCtx = capturedForkParams!.forkContextMessages ?? []

    // THE KEY ASSERTION:
    // After the fix, compact.ts filters the previous summary out of
    // cacheSafeParams.forkContextMessages before handing to runForkedAgent.
    // Before the fix, this assertion fails — summary is still there.
    const summaryStillPresent = forkCtx.some(m => m.uuid === priorSummaryUuid)
    expect(summaryStillPresent).toBe(false)
  }, 30_000)
})
