import { describe, expect, it, vi } from 'vitest'

import {
  classifyError,
  type ClassifiedError,
} from '../../../../../services/api/errorClassifier.js'
import { shouldUseNonStreamingFallbackForStreamError } from '../../../../../services/api/llm.js'
import {
  OpenAIStreamState,
  type OpenAIChatChunk,
} from '../../../../../services/api/adapters/openaiStreamAdapter.js'
import { OpenAIProvider } from '../../../../../services/api/providers/openaiProvider.js'
import { resolveRecoveryAction } from '../../../../../services/api/recoveryAction.js'
import type { RecoveryTraceEvent } from '../../../../../services/api/recoveryTrace.js'
import { LLMAPIError } from '../../../../../services/api/streamTypes.js'
import type {
  MessageParam,
  NeutralToolSchema,
  StreamIntent,
} from '../../../../../services/api/streamTypes.js'
import type { ThinkingConfig } from '../../../../../utils/thinking.js'
import {
  CannotRetryError,
  type RetryContext,
  withRetry,
} from '../../../../../services/api/withRetry.js'
import { readFixture, stableJson } from './fixtureUtils.js'

vi.mock('../../../../../utils/imageResizer.js', () => ({
  maybeResizeAndDownsampleImageBuffer: vi.fn(async () => ({
    buffer: Buffer.from('contract-shrunk-image'),
    mediaType: 'jpeg',
  })),
}))

vi.mock('../../../../../utils/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../utils/config.js')>(
    '../../../../../utils/config.js',
  )
  return {
    ...actual,
    getGlobalConfig: vi.fn(() => ({
      modelTemplates: {
        'contract-relay-deepseek': {
          matchModelRegex: '\\bdeepseek[\\s\\-_]*v?[\\s\\-_]*(\\d+)',
          matchBaseUrlRegex: 'relay\\.example',
          protocol: 'openai-chat',
          enabledPatch: { thinking: { type: 'enabled' } },
          disabledPatch: { thinking: { type: 'disabled' } },
          effort: {
            valueMap: {
              low: null,
              medium: null,
              high: 'high',
              max: 'max',
            },
          },
          autoRoundTripReasoningContent: true,
          reasoningRoundTripFormat: 'reasoning_content',
        },
      },
    })),
  }
})

type ErrorEnvelopeFixture = {
  name: string
  status: number
  message: string
  headers?: Record<string, string>
  error?: unknown
  reason: ClassifiedError['reason']
  action: ReturnType<typeof resolveRecoveryAction> | 'non_streaming_fallback'
  useNonStreamingFallback: boolean
}

type StreamChunkFixture = {
  name: string
  chunks: unknown[]
  flush: boolean
  events?: unknown[]
  throws?: {
    status: number
    messageIncludes: string
  }
}

const baseMessages: MessageParam[] = [
  { role: 'user', content: 'Summarize the repo status.' },
]

const toolResultMessages: MessageParam[] = [
  ...baseMessages,
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call_read_1',
        name: 'Read',
        input: { file_path: 'C:/repo/README.md' },
      },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_read_1',
        content: [
          { type: 'text', text: 'file contents' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo=',
            },
          },
        ],
      },
    ],
  },
]

const tools: NeutralToolSchema[] = [
  {
    name: 'Read',
    description: 'Read a workspace file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute file path.',
          pattern: '^[A-Z]:\\\\.*',
          format: 'uri',
        },
      },
      required: ['file_path'],
    },
  },
]

function makeProvider() {
  return new OpenAIProvider({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    modelConfig: {
      model: 'gpt-4o',
      protocol: 'openai-chat',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
    },
  })
}

function makeRelayDeepSeekProvider() {
  return new OpenAIProvider({
    baseUrl: 'https://relay.example/v1',
    apiKey: 'test-key',
    modelConfig: {
      model: 'deepseek-v4-pro',
      protocol: 'openai-chat',
      vendor: 'openai-chat-deepseek-official',
      modelTemplate: 'contract-relay-deepseek',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'test-key',
      thinking: { enabled: true, effort: 'high' },
    },
  })
}

function makeIntent(messages: MessageParam[] = baseMessages): StreamIntent {
  return {
    model: 'gpt-4o',
    messages: messages.map((message, index) => ({
      type: message.role,
      message,
      uuid: `msg_${index}`,
    })),
    systemPrompt: [{ type: 'text', text: 'You are concise.' }],
    tools,
    toolChoice: { type: 'auto' },
    maxOutputTokens: 4096,
    temperature: 0.2,
    thinking: { type: 'disabled' },
  }
}

function makeRelayDeepSeekIntent(messages: MessageParam[]): StreamIntent {
  return {
    ...makeIntent(messages),
    model: 'deepseek-v4-pro',
    thinking: { type: 'enabled', budgetTokens: 4096 },
  }
}

async function buildRequestBody(
  retryContext: Partial<
    Omit<RetryContext, 'omittedRequestFields'> & {
      omittedRequestFields: readonly string[]
    }
  > = {},
  messages: MessageParam[] = baseMessages,
) {
  const provider = makeProvider()
  const body = await (
    provider as unknown as {
      buildRequestBodyForRetry(
        model: string,
        intent: StreamIntent,
        retryContext: RetryContext,
        options: { stream: boolean },
      ): Promise<Record<string, unknown>>
    }
  ).buildRequestBodyForRetry(
      'gpt-4o',
      makeIntent(messages),
      {
        model: 'gpt-4o',
        thinkingConfig: { type: 'disabled' },
        ...retryContext,
        omittedRequestFields: retryContext.omittedRequestFields
          ? [...retryContext.omittedRequestFields]
          : undefined,
      },
      { stream: true },
  )
  return stableJson(body)
}

async function buildRelayDeepSeekRequestBody(messages: MessageParam[]) {
  const provider = makeRelayDeepSeekProvider()
  return (provider as unknown as {
    buildRequestBodyForRetry(
      model: string,
      intent: StreamIntent,
      retryContext: RetryContext,
      options: { stream: boolean },
    ): Promise<Record<string, unknown>>
  }).buildRequestBodyForRetry(
    'deepseek-v4-pro',
    makeRelayDeepSeekIntent(messages),
    {
      model: 'deepseek-v4-pro',
      thinkingConfig: { type: 'enabled', budgetTokens: 4096 },
    },
    { stream: true },
  )
}

async function consume<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  for (;;) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

function projectTrace(event: RecoveryTraceEvent) {
  return {
    observationId: event.observationId,
    decisionId: event.decisionId,
    reason: event.reason,
    intent: event.intent,
    action: event.action,
    outcome: event.outcome,
    repeatPolicy: event.repeatPolicy,
    ...(event.ruleId ? { ruleId: event.ruleId } : {}),
    ...(event.previousReason ? { previousReason: event.previousReason } : {}),
    ...(event.previousIntent ? { previousIntent: event.previousIntent } : {}),
    ...(event.previousAction ? { previousAction: event.previousAction } : {}),
    ...(event.requestId ? { requestId: event.requestId } : {}),
    ...(event.streamPhase ? { streamPhase: event.streamPhase } : {}),
    ...(event.timeoutKind ? { timeoutKind: event.timeoutKind } : {}),
    ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
    ...(event.ttfbMs !== undefined ? { ttfbMs: event.ttfbMs } : {}),
    ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
    ...(event.bytesReceived !== undefined
      ? { bytesReceived: event.bytesReceived }
      : {}),
    ...(event.innerCause ? { innerCause: event.innerCause } : {}),
    ...(event.safeHeaders ? { safeHeaders: event.safeHeaders } : {}),
    ...(event.mutation ? { mutation: event.mutation } : {}),
    ...(event.imageRecoveryProfile
      ? { imageRecoveryProfile: event.imageRecoveryProfile }
      : {}),
    final: event.final,
  }
}

describe('OpenAI Chat request body golden fixtures', () => {
  it.each([
    ['normal stream', {}, 'openai-chat/request.normal-stream.json', baseMessages],
    [
      'drop max_tokens',
      { dropMaxTokens: true },
      'openai-chat/request.drop-max-tokens.json',
      baseMessages,
    ],
    [
      'omit unsupported temperature',
      { omittedRequestFields: ['temperature'] },
      'openai-chat/request.omit-temperature.json',
      baseMessages,
    ],
    [
      'strip llama.cpp unsupported schema keywords',
      { stripJsonSchemaKeywords: true },
      'openai-chat/request.strip-schema-keywords.json',
      baseMessages,
    ],
    [
      'downgrade multimodal tool result content',
      { downgradeMultimodalToolContent: true },
      'openai-chat/request.downgrade-tool-content.json',
      toolResultMessages,
    ],
  ] as const)('%s', async (_name, retryContext, fixture, messages) => {
    expect(await buildRequestBody(retryContext, messages)).toEqual(
      readFixture(fixture),
    )
  })

  it('rewrites image payloads only for image recovery retry context', async () => {
    const imageMessages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from('large-image').toString('base64'),
            },
          },
        ],
      },
    ]

    const body = await buildRequestBody(
      {
        rewriteImagePayload: true,
        imageRecoveryProfile: 'fit_many_image_dimension_limit',
      },
      imageMessages,
    ) as { messages: Array<{
      content: Array<{ type: string; image_url?: { url: string } }>
    }> }
    const messages = body.messages
    const image = messages[1]!.content.find(part => part.type === 'image_url')

    expect(image?.image_url?.url).toBe(
      `data:image/jpeg;base64,${Buffer.from('contract-shrunk-image').toString('base64')}`,
    )
    expect(imageMessages[0]!.content[1]).toMatchObject({
      source: {
        media_type: 'image/png',
        data: Buffer.from('large-image').toString('base64'),
      },
    })
  })

  it('custom relay DeepSeek request replays reasoning_content', async () => {
    const body = await buildRelayDeepSeekRequestBody([
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Need to inspect state.',
            roundTrip: { provider: 'none' },
          },
          {
            type: 'tool_use',
            id: 'call_relay',
            name: 'Read',
            input: { file_path: 'C:/repo/README.md' },
          },
        ],
      },
    ]) as {
      thinking?: unknown
      reasoning_effort?: unknown
      messages: Array<{
        role: string
        content?: unknown
        reasoning_content?: unknown
        tool_calls?: unknown[]
      }>
    }

    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [
        expect.objectContaining({
          id: 'call_relay',
          function: expect.objectContaining({ name: 'Read' }),
        }),
      ],
    })
    expect(body.messages[1]?.reasoning_content).toBe('Need to inspect state.')
  })
})

describe('OpenAI Chat error envelope golden fixtures', () => {
  const provider = makeProvider()

  it.each(readFixture<ErrorEnvelopeFixture[]>('openai-chat/error-envelopes.json'))(
    '$name',
    fixture => {
      const error = new LLMAPIError(fixture.message, {
        status: fixture.status,
        headers: fixture.headers,
        error: fixture.error,
      })
      const classified = classifyError(error, {
        provider: 'openai-chat',
        model: 'gpt-4o',
      })

      expect(classified.reason).toBe(fixture.reason)
      expect(
        shouldUseNonStreamingFallbackForStreamError(provider, error, 'gpt-4o', {
          allowStreamEndpoint404Fallback: true,
        }),
      ).toBe(fixture.useNonStreamingFallback)

      if (fixture.action !== 'non_streaming_fallback') {
        expect(
          resolveRecoveryAction(classified, {
            canFallback: fixture.action === 'fallback_model',
          }),
        ).toBe(fixture.action)
      }
    },
  )
})

describe('OpenAI Chat stream chunk golden fixtures', () => {
  it.each(
    readFixture<StreamChunkFixture[]>('openai-chat/stream-chunks.json'),
  )('$name', fixture => {
    const state = new OpenAIStreamState()
    const events: unknown[] = []

    const runFixture = () => {
      for (const chunk of fixture.chunks) {
        events.push(...state.mapChunk(chunk as OpenAIChatChunk))
      }
      if (fixture.flush) {
        events.push(...state.flush())
      }
    }

    if (fixture.throws) {
      expect(runFixture).toThrow(LLMAPIError)
      try {
        runFixture()
      } catch (error) {
        expect(error).toBeInstanceOf(LLMAPIError)
        expect((error as LLMAPIError).status).toBe(fixture.throws.status)
        expect((error as LLMAPIError).message).toContain(
          fixture.throws.messageIncludes,
        )
      }
      return
    }

    runFixture()
    expect(stableJson(events)).toEqual(fixture.events)
  })

  it('does not choose non-streaming fallback after a tool_use was yielded', () => {
    const provider = makeProvider()
    const state = new OpenAIStreamState()
    const events = [
      ...state.mapChunk({
        id: 'chatcmpl_tool_partial',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read_1',
                  type: 'function',
                  function: { name: 'Read', arguments: '{"file_path":"' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAIChatChunk),
      ...state.mapChunk({
        id: 'chatcmpl_tool_partial',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'C:/repo/README.md"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAIChatChunk),
      ...state.flush(),
    ]

    expect(events.some(event => event.type === 'block_stop')).toBe(true)
    expect(
      shouldUseNonStreamingFallbackForStreamError(
        provider,
        new Error('Stream ended without receiving any events'),
        'gpt-4o',
        { committedAssistantMessages: 1 },
      ),
    ).toBe(false)
  })
})

describe('OpenAI Chat retry trace golden fixtures', () => {
  it('emits stable trace sequence for request mutations', async () => {
    const traces: RecoveryTraceEvent[] = []
    const cases = [
      {
        errors: [
          new LLMAPIError('max_tokens is too large', { status: 400 }),
          new LLMAPIError('max_tokens is too large', { status: 400 }),
        ],
      },
      {
        errors: [
          new LLMAPIError('Unsupported parameter: temperature', {
            status: 400,
            error: {
              error: {
                code: 'unsupported_parameter',
                param: 'temperature',
              },
            },
          }),
          new LLMAPIError('Unsupported parameter: temperature', {
            status: 400,
            error: {
              error: {
                code: 'unsupported_parameter',
                param: 'temperature',
              },
            },
          }),
        ],
      },
      {
        errors: [
          new LLMAPIError('error parsing grammar: json-schema-to-grammar', {
            status: 400,
          }),
          new LLMAPIError('error parsing grammar: json-schema-to-grammar', {
            status: 400,
          }),
        ],
      },
    ]

    for (const contractCase of cases) {
      let call = 0
      const gen = withRetry(
        async () => ({}),
        async () => {
          throw contractCase.errors[Math.min(call++, contractCase.errors.length - 1)]
        },
        {
          protocol: 'openai-chat',
          model: 'gpt-4o',
          thinkingConfig: { type: 'disabled' },
          maxRetries: 10,
          onRecoveryTrace: event => traces.push(event),
        },
      )
      await expect(consume(gen)).rejects.toBeInstanceOf(CannotRetryError)
    }

    expect(traces.map(projectTrace)).toEqual(
      readFixture('openai-chat/retry-traces.json'),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Picker→wire effort plumbing
//
// Regression guard for the bug where ModelPicker's per-request effort never
// reached openai-chat / openai-responses providers — they only read the
// wizard-written `models[].thinking.effort` from disk, so cycling the picker
// silently lost to the static decl. The fix threads the runtime effort
// through StreamIntent.thinking.effort; providers merge it over the static
// decl before applying the vendor template, so picker selections actually
// land on the wire.
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAI Chat picker→wire effort plumbing (StreamIntent.thinking.effort)', () => {
  async function bodyFromIntent(
    intent: StreamIntent,
    thinkingConfig: ThinkingConfig = {
      type: 'enabled',
      budgetTokens: 4096,
    },
  ) {
    const provider = makeRelayDeepSeekProvider()
    return (provider as unknown as {
      buildRequestBodyForRetry(
        model: string,
        intent: StreamIntent,
        retryContext: RetryContext,
        options: { stream: boolean },
      ): Promise<Record<string, unknown>>
    }).buildRequestBodyForRetry(
      'deepseek-v4-pro',
      intent,
      { model: 'deepseek-v4-pro', thinkingConfig },
      { stream: true },
    )
  }

  it('picker effort=max overrides static decl effort=high → wire reasoning_effort=max', async () => {
    // The provider's modelConfig has static `effort: 'high'` (see
    // makeRelayDeepSeekProvider); the picker now sends effort=max via the
    // intent. Without the fix, the wire would still show 'high'.
    const intent: StreamIntent = {
      ...makeRelayDeepSeekIntent(baseMessages),
      thinking: { type: 'enabled', budgetTokens: 4096, effort: 'max' },
    }
    const body = await bodyFromIntent(intent)
    expect(body.reasoning_effort).toBe('max')
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  it('picker effort=high produces reasoning_effort=high (matches static decl, harmless)', async () => {
    const intent: StreamIntent = {
      ...makeRelayDeepSeekIntent(baseMessages),
      thinking: { type: 'enabled', budgetTokens: 4096, effort: 'high' },
    }
    const body = await bodyFromIntent(intent)
    expect(body.reasoning_effort).toBe('high')
  })

  it('picker effort=none fires disabledPatch — wire shows {thinking:{type:"disabled"}}, no reasoning_effort', async () => {
    // The contract-relay-deepseek vendor template defines disabledPatch:
    //   { thinking: { type: 'disabled' } }
    // applyThinkingTemplate's effort==='none' branch routes through this
    // patch and skips effort.patch. Result: thinking is explicitly disabled
    // on the wire, and reasoning_effort is absent.
    const intent: StreamIntent = {
      ...makeRelayDeepSeekIntent(baseMessages),
      thinking: { type: 'enabled', budgetTokens: 4096, effort: 'none' },
    }
    const body = await bodyFromIntent(intent)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect('reasoning_effort' in body).toBe(false)
  })

  it('no picker effort + static decl effort=high → falls back to static (no regression)', async () => {
    // The intent omits effort (as it would when the user never touches the
    // picker). Provider must still honor the static decl from .axiomate.json.
    const intent: StreamIntent = {
      ...makeRelayDeepSeekIntent(baseMessages),
      thinking: { type: 'enabled', budgetTokens: 4096 },
    }
    const body = await bodyFromIntent(intent)
    expect(body.reasoning_effort).toBe('high')
  })

  it('runtime intent.type=disabled (env / global thinking-off) → omits all thinking fields, even with effort set', async () => {
    // type==='disabled' represents the env / settings.alwaysThinkingEnabled
    // global off-switch. Preserve historical behavior: omit thinking
    // patches entirely, regardless of any effort that may have been
    // resolved before the disabled gate fired.
    const intent: StreamIntent = {
      ...makeRelayDeepSeekIntent(baseMessages),
      thinking: { type: 'disabled', effort: 'max' },
    }
    const body = await bodyFromIntent(intent, { type: 'disabled' })
    expect('thinking' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
  })
})
