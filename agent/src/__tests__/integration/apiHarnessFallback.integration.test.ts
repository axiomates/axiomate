/**
 * Real API integration gate for route/task model fallback.
 *
 * This test deliberately configures an unavailable primary endpoint and a
 * real fallback model from config/local.json. That gives us a stable,
 * low-cost way to exercise the real provider, classifier, recovery decision,
 * route chain switching, and auxiliary task runner without waiting for real
 * overload/rate-limit conditions.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { ToolUseContext } from '../../Tool.js'
import { query } from '../../query.js'
import { productionDeps } from '../../query/deps.js'
import { queryAuxiliaryTask } from '../../services/api/llm.js'
import { clearProviderCache } from '../../services/api/providerRegistry.js'
import type { RecoveryTraceEvent } from '../../services/api/recoveryTrace.js'
import type { GlobalConfig } from '../../utils/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { DEFAULT_MAIN_ALLOW_ACTIONS } from '../../utils/model/modelRouting.js'
import {
  getIntegrationModelConfig,
  toModelProviderConfig,
} from './config/loadIntegrationEnv.js'
import { TEST_MODELS } from './config/testModels.js'

// The model the test falls back TO. Must be real, reachable and low-cost — the
// gate makes the primary unreachable and asserts recovery switches here, so
// this is intentionally a cheap mid-size model, never the expensive main model.
const FALLBACK_MODEL = TEST_MODELS.fallbackTarget
const UNAVAILABLE_PRIMARY_KEY = '__integration_unavailable_primary__'
const UNAVAILABLE_PRIMARY_BASE_URL = 'http://127.0.0.1:9/v1'
const ROUTE_ID = 'real-api-fallback-gate'
const SWITCH_MODEL_ON = [
  'model_not_found',
  'rate_limit',
  'overloaded',
  'timeout',
  'connection',
  'server_error',
  'malformed_response',
  'responses_null_output',
  'content_policy_blocked',
] as const

const state = vi.hoisted(() => ({
  fixturesRoot: '',
}))

let previousModelConfig: Pick<GlobalConfig, 'models' | 'model' | 'auxiliary'>
let previousMaxRetries: string | undefined

function makeContext(
  onRecoveryTrace: (event: RecoveryTraceEvent) => void,
  abortController: AbortController = new AbortController(),
): ToolUseContext {
  const appState = {
    mainLoopModel: UNAVAILABLE_PRIMARY_KEY,
    mainLoopModelOverrideForSession: undefined,
    verbose: false,
    thinkingEnabled: false,
    promptSuggestionEnabled: false,
    settings: {},
    tasks: {},
    toolPermissionContext: { mode: 'default' as const },
    messages: [],
    pendingToolUseMessages: [],
    isLoading: false,
    effortValueByModel: {},
    mcp: { tools: [], clients: [] },
    sessionHooks: new Map(),
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: UNAVAILABLE_PRIMARY_KEY,
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController,
    readFileState: createFileStateCacheWithSizeLimit(20, 1_000_000),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    onRecoveryTrace,
  } as unknown as ToolUseContext
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const output: unknown[] = []
  for await (const event of gen) {
    output.push(event)
  }
  return output
}

beforeEach(async () => {
  state.fixturesRoot = await mkdtemp(join(tmpdir(), 'axiomate-real-api-gate-'))
  process.env.AXIOMATE_CODE_TEST_FIXTURES_ROOT = state.fixturesRoot
  const current = getGlobalConfig()
  previousMaxRetries = process.env.AXIOMATE_CODE_MAX_RETRIES
  process.env.AXIOMATE_CODE_MAX_RETRIES = '0'
  previousModelConfig = {
    models: current.models,
    model: current.model,
    auxiliary: current.auxiliary,
  }

  const realConfig = getIntegrationModelConfig(FALLBACK_MODEL)
  const unavailablePrimaryConfig = {
    ...realConfig,
    baseUrl: UNAVAILABLE_PRIMARY_BASE_URL,
  }

  saveGlobalConfig(config => ({
    ...config,
    models: {
      [UNAVAILABLE_PRIMARY_KEY]: toModelProviderConfig(
        UNAVAILABLE_PRIMARY_KEY,
        unavailablePrimaryConfig,
      ),
      [FALLBACK_MODEL]: toModelProviderConfig(FALLBACK_MODEL, realConfig),
    },
    model: {
      defaultRoute: ROUTE_ID,
      routes: {
        [ROUTE_ID]: {
          primary: UNAVAILABLE_PRIMARY_KEY,
          fallbackChain: [FALLBACK_MODEL],
          recoveryProfile: 'main-agent',
          allowActions: DEFAULT_MAIN_ALLOW_ACTIONS,
          switchModelOn: [...SWITCH_MODEL_ON],
        },
      },
    },
    auxiliary: {
      sessionTitle: {
        primary: UNAVAILABLE_PRIMARY_KEY,
        fallbackChain: [FALLBACK_MODEL],
        recoveryProfile: 'auxiliary-fast',
        allowActions: DEFAULT_MAIN_ALLOW_ACTIONS,
        switchModelOn: [...SWITCH_MODEL_ON],
        failure: 'propagate_error',
        timeoutMs: 45_000,
      },
    },
  }))
  clearProviderCache()
})

afterEach(async () => {
  delete process.env.AXIOMATE_CODE_TEST_FIXTURES_ROOT
  if (previousMaxRetries === undefined) {
    delete process.env.AXIOMATE_CODE_MAX_RETRIES
  } else {
    process.env.AXIOMATE_CODE_MAX_RETRIES = previousMaxRetries
  }
  saveGlobalConfig(config => ({
    ...config,
    models: previousModelConfig.models,
    model: previousModelConfig.model,
    auxiliary: previousModelConfig.auxiliary,
  }))
  clearProviderCache()
  if (state.fixturesRoot) {
    await rm(state.fixturesRoot, { recursive: true, force: true })
  }
})

describe('real API route/task fallback gate', () => {
  test('main query route switches from unavailable primary to real fallback model', async () => {
    getIntegrationModelConfig(FALLBACK_MODEL)
    const traces: RecoveryTraceEvent[] = []
    const controller = new AbortController()

    // Same rationale as the auxiliary gate: the fallback decision fires almost
    // instantly (unavailable primary connection fails fast), so abort the moment
    // the fallback trace appears instead of waiting for the real fallback model
    // to stream a full sentence — that generation round-trip is the only
    // uncapped-latency flakiness source.
    let aborted = false
    const captureTrace = (event: RecoveryTraceEvent) => {
      traces.push(event)
      if (
        !aborted &&
        event.action === 'fallback_model' &&
        event.outcome === 'fallback_triggered' &&
        event.fromModel === UNAVAILABLE_PRIMARY_KEY &&
        event.toModel === FALLBACK_MODEL
      ) {
        aborted = true
        controller.abort()
      }
    }

    try {
      await drain(
        query({
          messages: [
            createUserMessage({
              content:
                'Reply with one short sentence containing the word fallback.',
            }),
          ],
          systemPrompt: asSystemPrompt([
            'You are running an integration gate. Answer briefly.',
          ]),
          userContext: {},
          systemContext: {},
          canUseTool: vi.fn(),
          toolUseContext: makeContext(captureTrace, controller),
          querySource: 'sdk',
          maxTurns: 1,
          deps: {
            ...productionDeps(),
            microcompact: vi.fn(async messages => ({ messages })),
            autocompact: vi.fn(async () => ({ wasCompacted: false })),
            uuid: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
          },
        }),
      )
    } catch (error) {
      // Aborting the generation round-trip after fallback is proven is the
      // expected success path; only a pre-fallback failure is a real error.
      if (!aborted) {
        throw error
      }
    }

    const fallbackTrace = traces.find(
      event =>
        event.action === 'fallback_model' &&
        event.fromModel === UNAVAILABLE_PRIMARY_KEY &&
        event.toModel === FALLBACK_MODEL,
    )
    if (!fallbackTrace) {
      throw new Error(
        `Expected main-route fallback trace.\nTraces:\n${JSON.stringify(traces, null, 2)}`,
      )
    }
    expect(fallbackTrace).toMatchObject({
      routeId: ROUTE_ID,
      reason: 'connection',
      outcome: 'fallback_triggered',
      chainIndex: 0,
    })
  }, 90_000)

  test('auxiliary task runner switches from unavailable primary to real fallback model', async () => {
    getIntegrationModelConfig(FALLBACK_MODEL)
    const traces: RecoveryTraceEvent[] = []
    const controller = new AbortController()

    // This gate proves fallback is TRIGGERED against a real provider, not that
    // the fallback model finishes generating. The fallback decision fires in
    // ~20ms (the unavailable primary's connection fails instantly); waiting for
    // the real fallback model to generate a title is the sole flakiness source
    // (uncapped provider latency, observed hitting the 90s timeout). So abort as
    // soon as the fallback trace appears — the trace is the proof.
    let aborted = false
    const captureTrace = (event: RecoveryTraceEvent) => {
      traces.push(event)
      if (
        !aborted &&
        event.action === 'fallback_model' &&
        event.outcome === 'fallback_triggered' &&
        event.fromModel === UNAVAILABLE_PRIMARY_KEY &&
        event.toModel === FALLBACK_MODEL
      ) {
        aborted = true
        controller.abort()
      }
    }

    try {
      await queryAuxiliaryTask({
        systemPrompt: asSystemPrompt([
          'Return a concise title, no punctuation needed.',
        ]),
        userPrompt:
          'Create a two word title for an API fallback integration test.',
        signal: controller.signal,
        options: {
          auxiliaryTask: 'sessionTitle',
          querySource: 'session_title',
          isNonInteractiveSession: true,
          agents: [],
          hasAppendSystemPrompt: false,
          mcpTools: [],
          onRecoveryTrace: captureTrace,
        },
      })
    } catch (error) {
      // We abort the generation round-trip on purpose once fallback is proven;
      // an abort after the fallback trace is the expected, successful path.
      if (!aborted) {
        throw error
      }
    }

    const fallbackTrace = traces.find(
      event =>
        event.action === 'fallback_model' &&
        event.fromModel === UNAVAILABLE_PRIMARY_KEY &&
        event.toModel === FALLBACK_MODEL,
    )
    if (!fallbackTrace) {
      throw new Error(
        `Expected auxiliary fallback trace.\nTraces:\n${JSON.stringify(traces, null, 2)}`,
      )
    }
    expect(fallbackTrace).toMatchObject({
      routeId: 'sessionTitle',
      auxiliaryTask: 'sessionTitle',
      reason: 'connection',
      outcome: 'fallback_triggered',
      chainIndex: 0,
    })
  }, 90_000)
})
