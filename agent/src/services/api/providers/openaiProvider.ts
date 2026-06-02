/**
 * OpenAI-compatible LLMProvider implementation.
 *
 * Works with OpenAI API, SiliconFlow, 阿里云 DashScope, and any
 * OpenAI-compatible endpoint. Uses the `openai` npm package.
 *
 * Provider-specific params (thinking, extra) are read from ModelProviderConfig
 * and passthrough'd to the API body.
 */
import OpenAI from 'openai'
import { getGlobalConfig, type ModelProviderConfig } from '../../../utils/config.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  applyThinkingTemplate,
  deepMerge,
  resolveStack,
  type ResolvedTemplate,
  type VendorTemplate,
} from '../vendorTemplates.js'
import {
  LLMAPIError,
  LLMAbortError,
  LLMTimeoutError,
  type ContentBlock,
  type InferenceRequest,
  type InferenceResponse,
  type CountTokensRequest,
  type StreamEvent,
  type BlockDelta,
  type Usage,
  type LLMMessage,
} from '../streamTypes.js'
import type {
  LLMProvider,
  BoundProvider,
  StreamRequest,
  ErrorClassification,
  ProviderStreamResult,
  NonStreamingResult,
} from '../provider.js'
import type { SystemAPIErrorMessage } from '../../../types/message.js'
import {
  messagesToOpenAI,
  toolsToOpenAI,
  toolChoiceToOpenAI,
  mapFinishReason,
} from '../adapters/openaiRequestAdapter.js'
import { OpenAIStreamState, type OpenAIChatChunk } from '../adapters/openaiStreamAdapter.js'
import { mapOpenAIUsage } from '../adapters/openaiUsageMapper.js'
import { withRetry, type RetryContext, type RetryOptions } from '../withRetry.js'
import {
  downgradeMultimodalToolResultContent,
  omitRequestFields,
  rewriteImagePayloadsForRecovery,
  stripUnsupportedJsonSchemaKeywordsFromTools,
} from '../requestRecoveryMutations.js'
import { summarizeUnexpectedResponse } from '../errors.js'
import { emitAuxiliaryRecoveryTrace } from '../auxiliaryRecoveryTrace.js'
import {
  applyApiTimeoutTraceContext,
  resolveApiTimeoutPolicy,
  withApiTimeout,
} from '../apiTimeoutPolicy.js'
import {
  wrapError as sharedWrapError,
  classifyError as sharedClassifyError,
  verifyConnection as sharedVerifyConnection,
  isStreamUnsupportedError as sharedIsStreamUnsupportedError,
} from './openaiShared.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAIProviderConfig {
  baseUrl: string
  apiKey: string
  /** Model-level config for thinkingParams / extraParams passthrough */
  modelConfig?: ModelProviderConfig
}

function extractOpenAIRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const obj = value as {
    _request_id?: unknown
    request_id?: unknown
    id?: unknown
  }
  if (typeof obj._request_id === 'string') {
    return obj._request_id
  }
  if (typeof obj.request_id === 'string') {
    return obj.request_id
  }
  return undefined
}

function estimateStreamChunkBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return 0
  }
}

function openAIStreamDebugContext(
  ext: OpenAIRequestExt | undefined,
): string {
  const retryOptions = ext?.retryOptions
  const recoveryContext = retryOptions?.recoveryTraceContext
  return [
    `querySource=${retryOptions?.querySource ?? 'unknown'}`,
    `operation=${retryOptions?.operation ?? 'stream'}`,
    `traceId=${retryOptions?.traceId ?? 'none'}`,
    `route=${recoveryContext?.routeId ?? 'none'}`,
    `from=${recoveryContext?.fromModel ?? 'none'}`,
    `to=${recoveryContext?.toModel ?? 'none'}`,
  ].join(' ')
}

function summarizeOpenAIRequestBody(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages.length : 'unknown'
  const tools = Array.isArray(body.tools) ? body.tools.length : 0
  const keys = Object.keys(body)
    .filter(key => key !== 'messages')
    .sort()
    .join(',')
  return [
    `providerModel=${String(body.model ?? 'unknown')}`,
    `messages=${messages}`,
    `tools=${tools}`,
    `maxTokens=${String(body.max_tokens ?? 'none')}`,
    `toolChoice=${body.tool_choice === undefined ? 'none' : 'set'}`,
    `keys=${keys || 'none'}`,
  ].join(' ')
}

function summarizeOpenAIChatChunk(chunk: OpenAIChatChunk): string {
  const choices = Array.isArray(chunk?.choices) ? chunk.choices : []
  const choiceSummary = choices
    .slice(0, 3)
    .map(choice => {
      const delta = choice.delta ?? {}
      const deltaKeys = Object.keys(delta).sort().join(',') || 'none'
      const content =
        Object.hasOwn(delta, 'content')
          ? delta.content === null
            ? 'content=null'
            : `contentLen=${typeof delta.content === 'string' ? delta.content.length : 'non-string'}`
          : 'content=absent'
      const reasoning =
        Object.hasOwn(delta, 'reasoning_content')
          ? delta.reasoning_content === null
            ? 'reasoning=null'
            : `reasoningLen=${typeof delta.reasoning_content === 'string' ? delta.reasoning_content.length : 'non-string'}`
          : 'reasoning=absent'
      const toolCalls = Array.isArray(delta.tool_calls)
        ? delta.tool_calls.length
        : 0
      return [
        `choice=${choice.index}`,
        `finish=${choice.finish_reason ?? 'null'}`,
        `deltaKeys=${deltaKeys}`,
        content,
        reasoning,
        `toolCalls=${toolCalls}`,
      ].join(':')
    })
    .join(';')
  const usage = chunk.usage
    ? [
        `prompt=${String(chunk.usage.prompt_tokens ?? 'none')}`,
        `completion=${String(chunk.usage.completion_tokens ?? 'none')}`,
        `total=${String(chunk.usage.total_tokens ?? 'none')}`,
      ].join(',')
    : 'none'
  return [
    `chunkId=${chunk?.id ?? 'none'}`,
    `chunkModel=${chunk?.model ?? 'none'}`,
    `choices=${choices.length}`,
    `usage=${usage}`,
    `choicesSummary=${choiceSummary || 'none'}`,
  ].join(' ')
}

function summarizeNeutralEvents(events: readonly StreamEvent[]): string {
  if (events.length === 0) {
    return 'none'
  }
  return events.map(summarizeNeutralEvent).join(';')
}

function summarizeNeutralEvent(event: StreamEvent): string {
  switch (event.type) {
    case 'response_start':
      return `response_start:model=${event.response.model}:stop=${event.response.stopReason ?? 'null'}`
    case 'block_start':
      return `block_start:index=${event.index}:type=${event.block.type}`
    case 'block_delta':
      return `block_delta:index=${event.index}:${summarizeBlockDelta(event.delta)}`
    case 'block_stop':
      return `block_stop:index=${event.index}`
    case 'response_delta':
      return [
        `response_delta:stop=${event.stopReason ?? 'null'}`,
        `input=${event.usage.inputTokens}`,
        `output=${event.usage.outputTokens}`,
      ].join(':')
    case 'response_stop':
      return 'response_stop'
  }
}

function summarizeBlockDelta(delta: BlockDelta): string {
  switch (delta.type) {
    case 'text':
      return `textLen=${delta.text.length}`
    case 'thinking':
      return `thinkingLen=${delta.thinking.length}`
    case 'tool_input':
      return `toolJsonLen=${delta.json.length}`
    case 'thinking_round_trip':
      return `thinkingRoundTrip=${delta.roundTrip.provider}`
    case 'citations':
      return 'citation'
    case 'connector_text':
      return `connectorTextLen=${delta.text.length}`
  }
}

type OpenAIRequestExt = {
  retryOptions?: RetryOptions
  onNonStreamingAttempt?: (
    attempt: number,
    start: number,
    maxOutputTokens: number,
  ) => void
  captureRequest?: (params: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai-chat'
  private client: OpenAI
  private config: OpenAIProviderConfig

  constructor(config: OpenAIProviderConfig) {
    this.config = config
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      maxRetries: 0,
      ...(config.modelConfig?.userAgent
        ? { defaultHeaders: { 'User-Agent': config.modelConfig.userAgent } }
        : {}),
    })
  }

  bind(ext: unknown): BoundProvider {
    const openaiExt = ext as OpenAIRequestExt | undefined
    return {
      createStream: (request: StreamRequest) =>
        this.createStream(request, openaiExt),
      createNonStreamingFallback: (request: StreamRequest) =>
        this.createNonStreamingFallback(request, openaiExt),
    }
  }

  async *createStream(
    request: StreamRequest,
    ext?: OpenAIRequestExt,
  ): AsyncGenerator<SystemAPIErrorMessage, ProviderStreamResult> {
    const { model, signal, intent, hooks } = request
    const provider = this

    return yield* withRetry(
      () => Promise.resolve(this.client),
      async (client, attempt, retryContext) => {
        const startTime = Date.now()
        hooks?.onAttemptStart?.({ attempt, start: startTime })

        const requestBody = await this.buildRequestBodyForRetry(
          model,
          intent,
          retryContext,
          { stream: true },
        )
        const streamDebugContext = openAIStreamDebugContext(ext)
        logForDebugging(
          `[api:openai-chat:stream-request] attempt=${attempt} model=${model} ${streamDebugContext} ${summarizeOpenAIRequestBody(requestBody)}`,
          { level: 'debug' },
        )

        try {
          const stream = await client.chat.completions.create(
            { ...requestBody, stream: true as const } as OpenAI.ChatCompletionCreateParamsStreaming,
            { signal, maxRetries: 0 },
          )

          const ttfb = Date.now() - startTime
          const requestId = extractOpenAIRequestId(stream)
          logForDebugging(
            `[api:openai-chat:stream-open] attempt=${attempt} model=${model} requestId=${requestId ?? 'none'} ttfbMs=${ttfb} ${streamDebugContext}`,
            { level: 'debug' },
          )
          hooks?.onProviderEvent?.({ type: 'ttfb', ms: ttfb })
          hooks?.onRequestSent?.({
            maxOutputTokens: intent.maxOutputTokens,
            requestId,
          })

          const state = new OpenAIStreamState(provider.config.modelConfig?.usageMapping)
          const sdkStream = stream as unknown as AsyncIterable<OpenAIChatChunk>

          const neutralStream: AsyncIterable<StreamEvent> = {
            [Symbol.asyncIterator]: () => {
              const iter = sdkStream[Symbol.asyncIterator]()
              const buffer: StreamEvent[] = []
              let bufferIdx = 0
              let chunkIndex = 0

              return {
                async next(): Promise<IteratorResult<StreamEvent>> {
                  try {
                    while (bufferIdx >= buffer.length) {
                      buffer.length = 0
                      bufferIdx = 0
                      const chunk = await iter.next()
                      if (chunk.done) {
                        const cleanup = state.flush()
                        logForDebugging(
                          `[api:openai-chat:stream-done] attempt=${attempt} model=${model} requestId=${requestId ?? 'none'} chunks=${chunkIndex} cleanupEvents=${summarizeNeutralEvents(cleanup)} ${streamDebugContext}`,
                          { level: 'debug' },
                        )
                        if (cleanup.length > 0) {
                          buffer.push(...cleanup)
                          break
                        }
                        return { done: true, value: undefined }
                      }
                      chunkIndex++
                      hooks?.onProviderEvent?.({
                        type: 'bytes',
                        bytes: estimateStreamChunkBytes(chunk.value),
                      })
                      const mapped = state.mapChunk(chunk.value)
                      logForDebugging(
                        `[api:openai-chat:stream-chunk] attempt=${attempt} model=${model} requestId=${requestId ?? 'none'} chunk=${chunkIndex} bytes=${estimateStreamChunkBytes(chunk.value)} ${streamDebugContext} raw=${summarizeOpenAIChatChunk(chunk.value)} neutral=${summarizeNeutralEvents(mapped)}`,
                        { level: 'debug' },
                      )
                      buffer.push(...mapped)
                    }
                    return { done: false, value: buffer[bufferIdx++]! }
                  } catch (error) {
                    logForDebugging(
                      `[api:openai-chat:stream-error] attempt=${attempt} model=${model} requestId=${requestId ?? 'none'} ${streamDebugContext} error=${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`,
                      { level: 'error' },
                    )
                    throw provider.wrapError(error)
                  }
                },
              }
            },
          }

          return {
            stream: neutralStream,
            requestId,
            maxOutputTokens: intent.maxOutputTokens,
          }
        } catch (error) {
          logForDebugging(
            `[api:openai-chat:stream-create-error] attempt=${attempt} model=${model} ${streamDebugContext} error=${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`,
            { level: 'error' },
          )
          // Normalize OpenAI SDK errors to neutral types before withRetry classifies them
          throw provider.wrapError(error)
        }
      },
      {
        model: model ?? this.config.modelConfig?.model ?? 'unknown',
        thinkingConfig: intent.thinking ?? { type: 'disabled' as const },
        signal,
        ...ext?.retryOptions,
        deferStreamCreation404Recovery: true,
      },
    )
  }

  /**
   * Detect "endpoint does not support streaming" errors. Delegates to shared
   * helper so OpenAIResponsesProvider can use the same heuristic. Exposed so
   * llm.ts can gate its 400-at-creation fallback case.
   */
  isStreamUnsupportedError(err: unknown): boolean {
    return sharedIsStreamUnsupportedError(err)
  }

  async *createNonStreamingFallback(
    request: StreamRequest,
    ext?: OpenAIRequestExt,
  ): AsyncGenerator<SystemAPIErrorMessage, NonStreamingResult> {
    const { model, signal, intent } = request

    return yield* withRetry(
      () => Promise.resolve(this.client),
      async (client, attempt, retryContext) => {
        const startTime = Date.now()
        const requestBody = await this.buildRequestBodyForRetry(
          model,
          intent,
          retryContext,
          { stream: false },
        )

        ext?.captureRequest?.(requestBody)
        ext?.onNonStreamingAttempt?.(
          attempt,
          startTime,
          typeof requestBody.max_tokens === 'number'
            ? requestBody.max_tokens
            : 0,
        )

        const timeoutPolicy = resolveApiTimeoutPolicy({
          protocol: 'openai-chat',
          operation: 'non_streaming_fallback',
        })
        try {
          const response = (await withApiTimeout(
            timeoutPolicy,
            signal,
            timeoutSignal => client.chat.completions.create(
              requestBody as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
              { signal: timeoutSignal, maxRetries: 0 },
            ),
          )) as OpenAI.ChatCompletion

          const choice = response?.choices?.[0]
          if (!choice) {
            throw new LLMAPIError(
              `Provider returned malformed response (no choices): ${summarizeUnexpectedResponse(response)}`,
              { status: 502 },
            )
          }
          const content = this.mapResponseContent(choice)
          const usage = mapOpenAIUsage(
            response,
            this.config.modelConfig?.usageMapping,
          )

          const neutralMessage: LLMMessage = {
            id: response.id,
            type: 'message',
            role: 'assistant',
            content,
            model: response.model,
            stop_reason: mapFinishReason(choice?.finish_reason),
            stop_sequence: null,
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          }

          return { message: neutralMessage, requestId: response.id }
        } catch (error) {
          if (error instanceof LLMTimeoutError) {
            applyApiTimeoutTraceContext(
              ext?.retryOptions?.recoveryTraceContext,
              timeoutPolicy,
            )
          }
          throw this.wrapError(error)
        }
      },
      {
        model: model ?? this.config.modelConfig?.model ?? 'unknown',
        thinkingConfig: intent.thinking ?? { type: 'disabled' as const },
        signal,
        ...ext?.retryOptions,
      },
    )
  }

  classifyError(error: unknown): ErrorClassification {
    return sharedClassifyError(error)
  }

  calculateCost(_model: string, _usage: Usage): number | null {
    // OpenAI pricing varies by model and provider. Return null — caller
    // should not assume pricing for third-party OpenAI-compatible endpoints.
    return null
  }

  wrapError(error: unknown): LLMAPIError {
    return sharedWrapError(error)
  }

  async verifyConnection(options: { model: string; apiKey?: string; onRecoveryTrace?: import('../recoveryTrace.js').RecoveryTraceSink }): Promise<boolean> {
    try {
      return await sharedVerifyConnection(this.client, {
        provider: this,
        model: options.model,
        sink: options.onRecoveryTrace,
        querySource: 'verify_api_key',
      })
    } catch (error) {
      emitAuxiliaryRecoveryTrace({
        provider: this,
        model: options.model,
        operation: 'verify_connection',
        error,
        sink: options.onRecoveryTrace,
        querySource: 'verify_api_key',
      })
      throw error
    }
  }

  async inference(request: InferenceRequest): Promise<InferenceResponse> {
    const vendorTemplate = this.getResolvedTemplate()
    let body: Record<string, unknown> = {
      model: this.config.modelConfig!.model,
      messages: messagesToOpenAI(request.messages, request.system, {
        supportsImages: this.config.modelConfig?.supportsImages ?? true,
        roundTripReasoningContent:
          vendorTemplate.autoRoundTripReasoningContent ?? false,
        reasoningRoundTripFormat:
          vendorTemplate.reasoningRoundTripFormat ?? 'reasoning_content',
      }),
      max_tokens: request.maxTokens ?? 4096,
    }

    if (request.tools?.length) {
      body.tools = toolsToOpenAI(request.tools)
    }
    if (request.toolChoice) {
      body.tool_choice = toolChoiceToOpenAI(request.toolChoice)
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }
    if (request.stopSequences?.length) {
      body.stop = request.stopSequences
    }

    // Thinking params passthrough
    this.applyThinkingParams(body, request.thinking)

    // Extra params passthrough
    if (this.config.modelConfig?.extraParams) {
      Object.assign(body, this.config.modelConfig.extraParams)
    }
    if (request.providerHints?.omittedRequestFields) {
      body = omitRequestFields(
        body,
        request.providerHints.omittedRequestFields as string[],
      )
    }

    try {
      const timeoutPolicy = resolveApiTimeoutPolicy({
        protocol: 'openai-chat',
        operation: request.querySource === 'side_question'
          ? 'side_query'
          : 'inference',
        querySource: request.querySource,
      })
      const response = await withApiTimeout(
        timeoutPolicy,
        request.signal,
        signal => this.client.chat.completions.create(
          body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
          { signal, maxRetries: 0 },
        ),
      )

      const choice = response?.choices?.[0]
      if (!choice) {
        throw new LLMAPIError(
          `Provider returned malformed response (no choices): ${summarizeUnexpectedResponse(response)}`,
          { status: 502 },
        )
      }
      const content = this.mapResponseContent(choice)
      const usage = mapOpenAIUsage(
        response,
        this.config.modelConfig?.usageMapping,
      )

      return {
        id: response.id,
        content,
        model: response.model,
        stopReason: mapFinishReason(choice?.finish_reason),
        usage,
      }
    } catch (error) {
      if (!request.suppressAuxiliaryRecoveryTrace) {
        emitAuxiliaryRecoveryTrace({
          provider: this,
          model: request.model,
          operation: request.querySource === 'side_question'
            ? 'side_query'
            : 'inference',
          error,
          sink: request.onRecoveryTrace,
          querySource: request.querySource,
        })
      }
      throw this.wrapError(error)
    }
  }

  async countTokens(_request: CountTokensRequest): Promise<number | null> {
    // OpenAI doesn't have a server-side token counting API.
    // Return null — caller falls back to local estimation.
    return null
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildRequestBody(
    model: string,
    intent: {
      messages: unknown[]
      systemPrompt?: unknown[]
      tools: import('../streamTypes.js').NeutralToolSchema[]
      toolChoice?: import('../streamTypes.js').ToolChoice
      maxOutputTokens: number
      temperature?: number
      thinking?: { type: string; budgetTokens?: number }
    },
  ): Record<string, unknown> {
    // Extract system prompt text from the intent's systemPrompt blocks
    const systemText = Array.isArray(intent.systemPrompt)
      ? intent.systemPrompt
          .filter((b: any) => typeof b === 'string' || b?.type === 'text')
          .map((b: any) => (typeof b === 'string' ? b : b?.text ?? ''))
          .join('\n')
      : undefined

    // intent.messages are internal UserMessage | AssistantMessage wrapper objects
    // with { type, message: { role, content }, uuid, ... } structure.
    // Extract the inner .message to get { role, content } that messagesToOpenAI expects.
    const rawMessages = (intent.messages as Array<{ message: import('../streamTypes.js').MessageParam }>).map(m => m.message)
    const vendorTemplate = this.getResolvedTemplate()
    const messages = messagesToOpenAI(rawMessages, systemText, {
      supportsImages: this.config.modelConfig?.supportsImages ?? true,
      roundTripReasoningContent:
        vendorTemplate.autoRoundTripReasoningContent ?? false,
      reasoningRoundTripFormat:
        vendorTemplate.reasoningRoundTripFormat ?? 'reasoning_content',
    })

    const body: Record<string, unknown> = {
      model: this.config.modelConfig!.model,
      messages,
      max_tokens: intent.maxOutputTokens,
    }

    if (intent.tools.length > 0) {
      body.tools = toolsToOpenAI(intent.tools)
    }
    if (intent.toolChoice) {
      body.tool_choice = toolChoiceToOpenAI(intent.toolChoice)
    }
    if (intent.temperature !== undefined) {
      body.temperature = intent.temperature
    }

    // Thinking params passthrough
    this.applyThinkingParams(body, intent.thinking)

    // Extra params passthrough
    if (this.config.modelConfig?.extraParams) {
      Object.assign(body, this.config.modelConfig.extraParams)
    }

    return body
  }

  private async buildRequestBodyForRetry(
    model: string,
    intent: Parameters<OpenAIProvider['buildRequestBody']>[1],
    retryContext: RetryContext,
    options: { stream: boolean },
  ): Promise<Record<string, unknown>> {
    let retryMessages = retryContext.downgradeMultimodalToolContent
      ? downgradeMultimodalToolResultContent(intent.messages)
      : intent.messages
    if (retryContext.rewriteImagePayload) {
      retryMessages = await rewriteImagePayloadsForRecovery(retryMessages, {
        profile: retryContext.imageRecoveryProfile,
      })
    }
    const retryIntent = {
      ...intent,
      messages: retryMessages,
      tools: retryContext.stripJsonSchemaKeywords
        ? stripUnsupportedJsonSchemaKeywordsFromTools(intent.tools)
        : intent.tools,
      maxOutputTokens:
        retryContext.maxTokensOverride ?? intent.maxOutputTokens,
      thinking: retryContext.thinkingConfig,
    }
    const body = this.buildRequestBody(model, retryIntent)
    if (options.stream) {
      body.stream = true
      body.stream_options = { include_usage: true }
    } else {
      // Strip streaming-only fields in case a caller merged them into extraParams.
      delete body.stream
      delete body.stream_options
    }

    if (retryContext.dropMaxTokens) {
      const { max_tokens: _dropped, ...rest } = body
      return rest
    }
    return omitRequestFields(body, retryContext.omittedRequestFields)
  }

  private applyThinkingParams(
    body: Record<string, unknown>,
    thinking?: { type: string; budgetTokens?: number } | null,
  ): void {
    if (!thinking || thinking.type === 'disabled') return
    const decl = this.config.modelConfig?.thinking
    if (!decl) return
    const template = this.getResolvedTemplate()
    const patch = applyThinkingTemplate(decl, template)
    deepMerge(body, patch)
  }

  /**
   * Resolve the vendor template for this model. Custom templates from the
   * config's top-level `templates` field win over built-ins on name match.
   */
  private getResolvedTemplate(): ResolvedTemplate {
    const cfg = this.config.modelConfig
    if (!cfg) {
      return resolveStack({
        protocol: 'openai-chat',
        model: '',
      })
    }
    return resolveStack({
      protocol: cfg.protocol,
      vendor: cfg.vendor,
      modelTemplate: cfg.modelTemplate,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      customVendors: getGlobalConfig().templates,
      customModels: getGlobalConfig().modelTemplates,
    })
  }

  private mapResponseContent(choice: any): ContentBlock[] {
    const blocks: ContentBlock[] = []

    if (!choice?.message) return blocks

    // Reasoning content (thinking)
    const hasReasoningContent =
      typeof choice.message.reasoning_content === 'string' &&
      choice.message.reasoning_content.length > 0
    if (hasReasoningContent) {
      blocks.push({
        type: 'thinking',
        thinking: choice.message.reasoning_content,
        roundTrip: { provider: 'none' },
      })
    }

    // Text content
    if (typeof choice.message.content === 'string' && choice.message.content) {
      blocks.push({
        type: 'text',
        text: choice.message.content,
      })
    } else if (Array.isArray(choice.message.content)) {
      for (const part of choice.message.content) {
        if (
          !hasReasoningContent &&
          part?.type === 'thinking' &&
          typeof part.thinking === 'string'
        ) {
          blocks.push({
            type: 'thinking',
            thinking: part.thinking,
            roundTrip: { provider: 'none' },
          })
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          blocks.push({
            type: 'text',
            text: part.text,
          })
        }
      }
    }

    // Tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {}
        const rawArgs =
          typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : undefined
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = {}
        }
        const block: ContentBlock = {
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
          ...(rawArgs && rawArgs.length > 0 ? { unparsedInput: rawArgs } : {}),
        }
        blocks.push(block)
      }
    }

    return blocks
  }
}
