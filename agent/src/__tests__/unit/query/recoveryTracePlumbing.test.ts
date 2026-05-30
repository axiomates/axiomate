import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/model/model.js', () => ({
  getMainRoute: vi.fn(() => ({
    id: 'default',
    primary: 'test-model',
    fallbackChain: ['test-fallback-model', 'test-final-model'],
    recoveryProfile: 'main-agent',
    allowActions: ['retry_same_model', 'adapt_request', 'switch_model'],
    switchModelOn: ['rate_limit', 'overloaded'],
  })),
  resolveModelChain: vi.fn(() => [
    'test-model',
    'test-fallback-model',
    'test-final-model',
  ]),
  getRuntimeMainLoopModel: vi.fn(({ mainLoopModel }) => mainLoopModel),
  renderModelName: vi.fn((model: string) => model),
  doesMostRecentAssistantMessageExceed200k: vi.fn(() => false),
}))

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: vi.fn(() => ({
    models: {
      'test-model': {},
      'test-fallback-model': {},
      'test-final-model': {},
      'override-model': {},
      'override-fallback-model': {},
    },
    model: {
      defaultRoute: 'default',
      routes: {
        default: {
          primary: 'test-model',
          fallbackChain: ['test-fallback-model', 'test-final-model'],
        },
        override: {
          primary: 'override-model',
          fallbackChain: ['override-fallback-model'],
        },
      },
    },
  })),
}))

import { query } from '../../../query.js'
import type { QueryDeps } from '../../../query/deps.js'
import { FallbackTriggeredError } from '../../../services/api/withRetry.js'
import type { RecoveryTraceEvent } from '../../../services/api/recoveryTrace.js'
import {
  appendApiRecoveryTrace,
  clearApiRecoveryTraces,
  listApiRecoveryTraces,
} from '../../../services/api/apiRecoveryDiagnostics.js'
import type { AssistantMessage, Message } from '../../../types/message.js'
import type { ToolUseContext } from '../../../Tool.js'

const now = new Date().toISOString()

function makeAssistantMessage(): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: now,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    },
  } as unknown as AssistantMessage
}

function makeContext(
  onRecoveryTrace: (event: RecoveryTraceEvent) => void,
  appState: Record<string, unknown> = {},
): ToolUseContext {
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    readFileState: new Map(),
    getAppState: () => ({
      toolPermissionContext: { mode: 'default' },
      mcp: { tools: [], clients: [] },
      effortValueByModel: {},
      ...appState,
    }),
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
  const out: unknown[] = []
  for await (const message of gen) {
    out.push(message)
  }
  return out
}

describe('query recovery trace plumbing', () => {
  it('passes ToolUseContext.onRecoveryTrace into the API streaming options', async () => {
    const onRecoveryTrace = vi.fn()
    const callModel = vi.fn(async function* (input: {
      options: { onRecoveryTrace?: (event: RecoveryTraceEvent) => void }
    }) {
      expect(input.options.onRecoveryTrace).toBe(onRecoveryTrace)
      yield makeAssistantMessage()
    })
    const deps: QueryDeps = {
      callModel: callModel as unknown as QueryDeps['callModel'],
      microcompact: vi.fn(async messages => ({ messages })) as QueryDeps['microcompact'],
      autocompact: vi.fn(async () => ({ wasCompacted: false })) as QueryDeps['autocompact'],
      uuid: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
    }
    const messages: Message[] = []

    await drain(
      query({
        messages,
        systemPrompt: '' as never,
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(),
        toolUseContext: makeContext(onRecoveryTrace),
        querySource: 'sdk',
        deps,
      }),
    )

    expect(callModel).toHaveBeenCalledTimes(1)
  })

  it('can route API traces from query into the Doctor diagnostics store', async () => {
    clearApiRecoveryTraces()
    const callModel = vi.fn(async function* (input: {
      options: { onRecoveryTrace?: (event: RecoveryTraceEvent) => void }
    }) {
      input.options.onRecoveryTrace?.({
        timestamp: '2026-05-29T00:00:00.000Z',
        traceId: 'doctor-store-trace',
        protocol: 'openai-chat',
        model: 'test-model',
        attempt: 1,
        maxAttempts: 1,
        reason: 'server_error',
        intent: 'retry_transient_failure',
        action: 'retry_backoff',
        outcome: 'retrying',
        statusCode: 502,
        retryable: true,
        shouldCompress: false,
        shouldFallback: false,
        final: false,
        operation: 'stream',
      })
      yield makeAssistantMessage()
    })
    const deps: QueryDeps = {
      callModel: callModel as unknown as QueryDeps['callModel'],
      microcompact: vi.fn(async messages => ({ messages })) as QueryDeps['microcompact'],
      autocompact: vi.fn(async () => ({ wasCompacted: false })) as QueryDeps['autocompact'],
      uuid: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
    }

    await drain(
      query({
        messages: [],
        systemPrompt: '' as never,
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(),
        toolUseContext: makeContext(appendApiRecoveryTrace),
        querySource: 'sdk',
        deps,
      }),
    )

    expect(listApiRecoveryTraces()[0]).toMatchObject({
      traceId: 'doctor-store-trace',
      reason: 'server_error',
      statusCode: 502,
      operation: 'stream',
    })
    clearApiRecoveryTraces()
  })

  it('uses the configured main route chain for multi-hop model fallback', async () => {
    const onRecoveryTrace = vi.fn()
    const attemptedModels: string[] = []
    const callModel = vi.fn(async function* (input: {
      options: {
        model: string
        fallbackModel?: string
        recoveryRouteId?: string
        recoveryFromModel?: string
        recoveryChainIndex?: number
      }
    }) {
      attemptedModels.push(input.options.model)
      if (input.options.model === 'test-model') {
        expect(input.options.fallbackModel).toBe('test-fallback-model')
        expect(input.options.recoveryRouteId).toBe('default')
        expect(input.options.recoveryFromModel).toBe('test-model')
        expect(input.options.recoveryChainIndex).toBe(0)
        throw new FallbackTriggeredError('test-model', 'test-fallback-model')
      }
      if (input.options.model === 'test-fallback-model') {
        expect(input.options.fallbackModel).toBe('test-final-model')
        expect(input.options.recoveryChainIndex).toBe(1)
        throw new FallbackTriggeredError(
          'test-fallback-model',
          'test-final-model',
        )
      }
      expect(input.options.fallbackModel).toBeUndefined()
      expect(input.options.recoveryChainIndex).toBe(2)
      yield makeAssistantMessage()
    })
    const deps: QueryDeps = {
      callModel: callModel as unknown as QueryDeps['callModel'],
      microcompact: vi.fn(async messages => ({ messages })) as QueryDeps['microcompact'],
      autocompact: vi.fn(async () => ({ wasCompacted: false })) as QueryDeps['autocompact'],
      uuid: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
    }

    const output = await drain(
      query({
        messages: [],
        systemPrompt: '' as never,
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(),
        toolUseContext: makeContext(onRecoveryTrace),
        querySource: 'sdk',
        deps,
      }),
    )

    expect(attemptedModels).toEqual([
      'test-model',
      'test-fallback-model',
      'test-final-model',
    ])
    expect(
      output.filter(
        (message): message is AssistantMessage =>
          (message as { type?: unknown }).type === 'assistant',
      ),
    ).toHaveLength(1)
  })

  it('uses the configured route chain for model-switch candidates', async () => {
    const onRecoveryTrace = vi.fn()
    const attemptedModels: string[] = []
    const callModel = vi.fn(async function* (input: {
      options: { model: string; fallbackModel?: string }
    }) {
      attemptedModels.push(input.options.model)
      if (input.options.model === 'test-model') {
        expect(input.options.fallbackModel).toBe('test-fallback-model')
        throw new FallbackTriggeredError('test-model', 'test-fallback-model')
      }
      expect(input.options.model).toBe('test-fallback-model')
      expect(input.options.fallbackModel).toBe('test-final-model')
      yield makeAssistantMessage()
    })
    const deps: QueryDeps = {
      callModel: callModel as unknown as QueryDeps['callModel'],
      microcompact: vi.fn(async messages => ({ messages })) as QueryDeps['microcompact'],
      autocompact: vi.fn(async () => ({ wasCompacted: false })) as QueryDeps['autocompact'],
      uuid: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
    }

    await drain(
      query({
        messages: [],
        systemPrompt: '' as never,
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(),
        toolUseContext: makeContext(onRecoveryTrace),
        querySource: 'sdk',
        deps,
      }),
    )

    expect(attemptedModels).toEqual(['test-model', 'test-fallback-model'])
  })

  it('describes model fallback as API recovery, not high demand only', async () => {
    const callModel = vi.fn(async function* (input: {
      options: { model: string; fallbackModel?: string }
    }) {
      if (input.options.model === 'test-model') {
        throw new FallbackTriggeredError('test-model', 'test-fallback-model')
      }
      yield makeAssistantMessage()
    })
    const deps: QueryDeps = {
      callModel: callModel as unknown as QueryDeps['callModel'],
      microcompact: vi.fn(async messages => ({ messages })) as QueryDeps['microcompact'],
      autocompact: vi.fn(async () => ({ wasCompacted: false })) as QueryDeps['autocompact'],
      uuid: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
    }

    const output = await drain(
      query({
        messages: [],
        systemPrompt: '' as never,
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(),
        toolUseContext: makeContext(vi.fn()),
        querySource: 'sdk',
        deps,
      }),
    )

    const fallbackNotice = output.find(message =>
      JSON.stringify(message).includes('Switched to test-fallback-model'),
    )
    expect(JSON.stringify(fallbackNotice)).toContain('after API recovery')
    expect(JSON.stringify(fallbackNotice)).not.toContain('high demand')
  })

  it('uses session route overrides as the main route chain', async () => {
    const onRecoveryTrace = vi.fn()
    const attemptedModels: string[] = []
    const callModel = vi.fn(async function* (input: {
      options: {
        model: string
        fallbackModel?: string
        recoveryRouteId?: string
        recoveryChainIndex?: number
      }
    }) {
      attemptedModels.push(input.options.model)
      if (input.options.model === 'override-model') {
        expect(input.options.fallbackModel).toBe('override-fallback-model')
        expect(input.options.recoveryRouteId).toBe('override')
        expect(input.options.recoveryChainIndex).toBe(0)
        throw new FallbackTriggeredError(
          'override-model',
          'override-fallback-model',
        )
      }
      expect(input.options.model).toBe('override-fallback-model')
      expect(input.options.fallbackModel).toBeUndefined()
      expect(input.options.recoveryChainIndex).toBe(1)
      yield makeAssistantMessage()
    })
    const deps: QueryDeps = {
      callModel: callModel as unknown as QueryDeps['callModel'],
      microcompact: vi.fn(async messages => ({ messages })) as QueryDeps['microcompact'],
      autocompact: vi.fn(async () => ({ wasCompacted: false })) as QueryDeps['autocompact'],
      uuid: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
    }

    await drain(
      query({
        messages: [],
        systemPrompt: '' as never,
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(),
        toolUseContext: makeContext(onRecoveryTrace, {
          mainLoopModelOverrideForSession: {
            type: 'route',
            routeId: 'override',
          },
        }),
        querySource: 'sdk',
        deps,
      }),
    )

    expect(attemptedModels).toEqual([
      'override-model',
      'override-fallback-model',
    ])
  })

  it('uses explicit full-query route overrides for auxiliary agent loops', async () => {
    const onRecoveryTrace = vi.fn()
    const attemptedModels: string[] = []
    const callOptions: Array<{
      model: string
      fallbackModel?: string
      recoveryRouteId?: string
      recoveryChainIndex?: number
      recoveryAuxiliaryTask?: string
      recoveryPolicyGate?: {
        allowActions?: string[]
        switchModelOn?: string[]
        actionAllowed?: boolean
      }
    }> = []
    const callModel = vi.fn(async function* (input: {
      options: {
        model: string
        fallbackModel?: string
        recoveryRouteId?: string
        recoveryChainIndex?: number
        recoveryAuxiliaryTask?: string
        recoveryPolicyGate?: {
          allowActions?: string[]
          switchModelOn?: string[]
          actionAllowed?: boolean
        }
      }
    }) {
      attemptedModels.push(input.options.model)
      callOptions.push(input.options)

      if (input.options.model === 'hook-model') {
        throw new FallbackTriggeredError('hook-model', 'hook-fallback')
      }

      yield makeAssistantMessage()
    })
    const deps: QueryDeps = {
      callModel: callModel as unknown as QueryDeps['callModel'],
      microcompact: vi.fn(async messages => ({ messages })) as QueryDeps['microcompact'],
      autocompact: vi.fn(async () => ({ wasCompacted: false })) as QueryDeps['autocompact'],
      uuid: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
    }

    await drain(
      query({
        messages: [],
        systemPrompt: '' as never,
        userContext: {},
        systemContext: {},
        canUseTool: vi.fn(),
        toolUseContext: makeContext(onRecoveryTrace),
        querySource: 'hook_agent',
        modelRouteOverride: {
          id: 'hookAgent',
          primary: 'hook-model',
          fallbackChain: ['hook-fallback'],
          recoveryProfile: 'auxiliary-quality',
          allowActions: ['retry_same_model', 'adapt_request', 'switch_model'],
          switchModelOn: ['rate_limit', 'server_error'],
          auxiliaryTask: 'hookAgent',
        },
        deps,
      }),
    )

    expect(attemptedModels).toEqual(['hook-model', 'hook-fallback'])
    expect(callOptions[0]).toMatchObject({
      model: 'hook-model',
      fallbackModel: 'hook-fallback',
      recoveryRouteId: 'hookAgent',
      recoveryChainIndex: 0,
      recoveryAuxiliaryTask: 'hookAgent',
      recoveryPolicyGate: {
        allowActions: ['retry_same_model', 'adapt_request', 'switch_model'],
        switchModelOn: ['rate_limit', 'server_error'],
      },
    })
    expect(callOptions[1]).toMatchObject({
      model: 'hook-fallback',
      recoveryRouteId: 'hookAgent',
      recoveryChainIndex: 1,
      recoveryAuxiliaryTask: 'hookAgent',
    })
    expect(callOptions[1]!.fallbackModel).toBeUndefined()
  })
})
