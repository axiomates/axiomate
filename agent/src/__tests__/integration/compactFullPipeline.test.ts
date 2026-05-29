/**
 * Integration test: full compactConversation pipeline with real Qwen3 8B.
 *
 * Complements compactIterativePrompt.test.ts (which tests the PROMPT
 * directly via OpenAI SDK). This test goes through axiomate's real
 * compactConversation → streamCompactSummary → provider → LLM → parse
 * chain, verifying that PR 1's runtime wiring (extractPreviousCompactSummary,
 * filterPreviousSummaryForIterativeCompact, compactConversation call site)
 * actually engages the iterative prompt when a prior summary exists in
 * history.
 *
 * If someone refactors compactConversation and bypasses the iterative
 * extraction, this test will fail because the resulting summary will
 * NOT show iterative behavior (no "Completed This Session" migration).
 */
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { getIntegrationModelConfig } from './config/loadIntegrationEnv.js'
import { TEST_MODELS } from './config/testModels.js'

// ---------------------------------------------------------------------------
// Mock getGlobalConfig to inject test model config without touching
// ~/.axiomate.json. Must be hoisted above the imports that use it.
// ---------------------------------------------------------------------------
vi.mock('../../utils/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../utils/config.js')>()
  const { buildIntegrationModelRoutingConfig, getIntegrationModelConfig } = await import(
    './config/loadIntegrationEnv.js'
  )
  const { TEST_MODELS } = await import('./config/testModels.js')
  const modelName = TEST_MODELS.summarization
  const modelCfg = getIntegrationModelConfig(modelName)

  const testGlobalConfig = {
    ...actual.getGlobalConfig(),
    ...buildIntegrationModelRoutingConfig(modelName, modelCfg),
  }

  return {
    ...actual,
    getGlobalConfig: () => testGlobalConfig,
  }
})

// Imports AFTER vi.mock so they pick up the mocked getGlobalConfig.
// (vitest hoists vi.mock calls above imports, so declaration order here
// is fine — the actual execution order puts mocks first.)
import { compactConversation } from '../../services/compact/compact.js'
import type { Message, UserMessage } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'

// ---------------------------------------------------------------------------
// Fixture helpers — direct Message construction to avoid heavy imports
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
    compactMetadata: {
      trigger: 'manual',
      preTokens: 40_000,
    },
  } as unknown as Message
}

function makeCompactSummaryMessage(bodyText: string): UserMessage {
  // Shape the message content to match what getCompactUserSummaryMessage
  // produces — preamble + "Summary:\n..." + optional trailers.
  const content =
    'This session is being continued from a previous conversation that ran out of context. ' +
    'The summary below covers the earlier portion of the conversation.\n\n' +
    `Summary:\n${bodyText}`
  return {
    type: 'user',
    uuid: randomUUID(),
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
      model: TEST_MODELS.summarization,
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: 'text', text }],
    },
  } as unknown as Message
}

// ---------------------------------------------------------------------------
// Minimal ToolUseContext — compactConversation reads only a subset.
// Field coverage verified empirically: compact.ts only accesses the fields
// filled here. All others are stubbed or cast-bypassed.
// ---------------------------------------------------------------------------

function makeMinimalContext() {
  const abortController = new AbortController()
  const appState = {
    mainLoopModel: TEST_MODELS.summarization,
    mainLoopModelOverrideForSession: {
      type: 'single-model-route' as const,
      modelId: TEST_MODELS.summarization,
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
      mainLoopModel: TEST_MODELS.summarization,
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

function makeCacheSafeParams() {
  return {
    forkContextMessages: null,
  }
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe('compactConversation full pipeline — iterative path via real Qwen3 8B', () => {
  let originalUnhandledRejection: NodeJS.UnhandledRejectionListener[]

  beforeAll(() => {
    // Swallow unhandled rejections from the streaming retry path so the
    // test harness doesn't fail on transient network noise. compact.ts
    // has internal retry; any escape here is still surfaced via the
    // Promise we await.
    originalUnhandledRejection = process.listeners('unhandledRejection')
  })
  afterAll(() => {
    process.removeAllListeners('unhandledRejection')
    for (const l of originalUnhandledRejection) {
      process.on('unhandledRejection', l)
    }
  })

  it('second-round compact with prior summary produces iterative "Completed This Session" section', async () => {
    const priorSummary = `1. Primary Request and Intent:
   User is fixing 3 bugs in the authentication module.

2. Key Technical Concepts:
   - JWT token refresh
   - Race condition mitigation
   - Memory leak detection

3. Files and Code Sections:
   - src/auth.ts
   - src/tokenRefresh.ts

4. Errors and fixes:
   - bug1: null pointer in login — fixed with null check

5. Problem Solving:
   3 bugs identified; bug1 resolved.

6. All user messages:
   - "fix the 3 bugs in auth"
   - "start with bug1"

7. Pending Tasks:
   - bug2: race condition
   - bug3: memory leak

8. Current Work:
   Just finished bug1.

9. Optional Next Step:
   Investigate bug2 race condition.`

    const messages: Message[] = [
      makeUserMsg('fix the 3 bugs in auth'),
      makeAssistantMsg('OK, starting with bug1.'),
      makeBoundary(),
      makeCompactSummaryMessage(priorSummary),
      makeUserMsg('I fixed bug2 with a mutex around the login handler'),
      makeAssistantMsg('Great, confirmed mutex fixes the race condition.'),
      makeUserMsg('Also add bug4 to the list — CSRF token validation issue'),
      makeAssistantMsg(
        'Added bug4. Want to investigate bug3 or bug4 first?',
      ),
      makeUserMsg("Let's do bug3 first"),
    ]

    const context = makeMinimalContext()
    const cacheSafeParams = makeCacheSafeParams()

    const result = await compactConversation(
      messages,
      context as never, // full ToolUseContext stub
      cacheSafeParams as never,
      true, // suppressFollowUpQuestions
      undefined, // no custom instructions
      false, // isAutoCompact
    )

    expect(result).toBeDefined()
    expect(result.summaryMessages).toHaveLength(1)

    const summaryContent = result.summaryMessages[0]?.message.content
    const summaryText =
      typeof summaryContent === 'string'
        ? summaryContent
        : JSON.stringify(summaryContent)

    console.log(
      '\n=== FULL-PIPELINE ITERATIVE SUMMARY ===\n' + summaryText + '\n======\n',
    )

    // Iterative assertions — same as compactIterativePrompt.test.ts but
    // now going through compactConversation, so this also verifies the
    // runtime wiring (extract → filter → prompt → LLM → parse → store).
    expect(summaryText).toContain('bug3') // preserved from prior
    expect(summaryText).toContain('bug4') // new
    expect(summaryText).toMatch(/Completed This Session/i) // iterative marker
  }, 120_000)
})
