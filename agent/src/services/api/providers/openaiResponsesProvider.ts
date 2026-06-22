/**
 * OpenAI Responses API LLMProvider implementation.
 *
 * Targets OpenAI's `/v1/responses` endpoint (and third-party Responses-API-
 * compatible proxies). Distinguished from OpenAIProvider by:
 *   - calls `client.responses.create()` instead of chat.completions.create()
 *   - input items array (typed: message / function_call / function_call_output
 *     / reasoning) instead of messages array
 *   - native support for reasoning round-trip via reasoning input items
 *   - `max_output_tokens` field name (not `max_tokens`)
 *
 * Reuses error handling and connection verification from openaiShared.ts.
 */
import OpenAI from 'openai'
import type {
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
  Response,
} from 'openai/resources/responses/responses'
import { getGlobalConfig, type ModelProviderConfig } from '../../../utils/config.js'
import {
  applyThinkingTemplate,
  deepMerge,
  inferVendor,
  resolveStack,
  resolveTemplate,
  type ResolvedTemplate,
  type VendorTemplate,
} from '../vendorTemplates.js'
import {
  LLMAPIError,
  LLMTimeoutError,
  type ContentBlock,
  type CountTokensRequest,
  type InferenceRequest,
  type InferenceResponse,
  type LLMMessage,
  type StreamEvent,
  type Usage,
} from '../streamTypes.js'
import type {
  BoundProvider,
  ErrorClassification,
  LLMProvider,
  NonStreamingResult,
  ProviderStreamResult,
  StreamRequest,
} from '../provider.js'
import type { SystemAPIErrorMessage } from '../../../types/message.js'
import {
  messagesToOpenAIResponsesInput,
  toolsToOpenAIResponses,
  toolChoiceToOpenAIResponses,
} from '../adapters/openaiResponsesRequestAdapter.js'
import { OpenAIResponsesStreamState } from '../adapters/openaiResponsesStreamAdapter.js'
import { mapOpenAIResponsesUsage } from '../adapters/openaiResponsesUsageMapper.js'
import { applyApiRequestPreflight } from '../apiRequestPreflight.js'
import { withRetry, type RetryContext, type RetryOptions } from '../withRetry.js'
import {
  emitBoundaryRecoveryDecisionTrace,
  formatBoundaryRecoveryCause,
} from '../boundaryRecovery.js'
import type { RecoveryTraceSink } from '../recoveryTrace.js'
import {
  downgradeMultimodalToolResultContent,
  omitRequestFields,
  rewriteImagePayloadsForRecovery,
  stripOpenAIResponsesReasoningReplay,
  stripSlashEnumValuesFromTools,
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
import {
  OpenAIResponsesPromptCacheCompat,
  type PromptCacheSelection,
} from './openaiResponsesPromptCacheCompat.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAIResponsesProviderConfig {
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

function isResponsesNullOutputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  return (
    lower.includes('responses api returned null output') ||
    lower.includes('response.output=null') ||
    lower.includes('response output is null') ||
    (lower.includes('nonetype') && lower.includes('not iterable')) ||
    (lower.includes('none') &&
      lower.includes('not iterable') &&
      lower.includes('response'))
  )
}

type OpenAIResponsesRequestExt = {
  retryOptions?: RetryOptions
  onRecoveryTrace?: RecoveryTraceSink
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

export class OpenAIResponsesProvider implements LLMProvider {
  readonly name = 'openai-responses'
  private client: OpenAI
  private config: OpenAIResponsesProviderConfig
  private promptCacheCompat: OpenAIResponsesPromptCacheCompat

  constructor(config: OpenAIResponsesProviderConfig) {
    this.config = config
    this.promptCacheCompat = new OpenAIResponsesPromptCacheCompat(config)
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
    const openaiExt = ext as OpenAIResponsesRequestExt | undefined
    return {
      createStream: (request: StreamRequest) =>
        this.createStream(request, openaiExt),
      createNonStreamingFallback: (request: StreamRequest) =>
        this.createNonStreamingFallback(request, openaiExt),
    }
  }

  async *createStream(
    request: StreamRequest,
    ext?: OpenAIResponsesRequestExt,
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
        const requestCompat = this.applyPromptCacheCompat(requestBody)

        try {
          const stream = await client.responses.create(
            { ...requestBody, stream: true } as ResponseCreateParamsStreaming,
            this.buildRequestOptions(signal, requestCompat.headers),
          )

          const ttfb = Date.now() - startTime
          const requestId = extractOpenAIRequestId(stream)
          hooks?.onProviderEvent?.({ type: 'ttfb', ms: ttfb })
          hooks?.onRequestSent?.({
            maxOutputTokens: intent.maxOutputTokens,
            requestId,
          })

          const state = new OpenAIResponsesStreamState({
            onCompletedResponse: response =>
              this.promptCacheCompat.recordResponse({
                selection: requestCompat.selection,
                response,
              }),
          })
          const sdkStream = stream as unknown as AsyncIterable<ResponseStreamEvent>

          const neutralStream: AsyncIterable<StreamEvent> = {
            [Symbol.asyncIterator]: () => {
              const iter = sdkStream[Symbol.asyncIterator]()
              const buffer: StreamEvent[] = []
              let bufferIdx = 0
              let terminalNullOutputSalvaged = false

              return {
                async next(): Promise<IteratorResult<StreamEvent>> {
                  if (terminalNullOutputSalvaged) {
                    return { done: true, value: undefined }
                  }
                  try {
                    while (bufferIdx >= buffer.length) {
                      buffer.length = 0
                      bufferIdx = 0
                      const chunk = await iter.next()
                      if (chunk.done) {
                        const cleanup = state.flush()
                        if (cleanup.length > 0) {
                          buffer.push(...cleanup)
                          break
                        }
                        return { done: true, value: undefined }
                      }
                      hooks?.onProviderEvent?.({
                        type: 'bytes',
                        bytes: estimateStreamChunkBytes(chunk.value),
                      })
                      buffer.push(...state.mapEvent(chunk.value))
                    }
                    return { done: false, value: buffer[bufferIdx++]! }
                  } catch (error) {
                    if (
                      state.hasCompletedResponse &&
                      isResponsesNullOutputError(error)
                    ) {
                      terminalNullOutputSalvaged = true
                      provider.emitNullOutputSalvageTrace({
                        error,
                        model:
                          model ??
                          provider.config.modelConfig?.model ??
                          'unknown',
                        attempt,
                        requestId,
                        sink:
                          ext?.onRecoveryTrace ??
                          ext?.retryOptions?.onRecoveryTrace,
                      })
                      return { done: true, value: undefined }
                    }
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

  isStreamUnsupportedError(err: unknown): boolean {
    return sharedIsStreamUnsupportedError(err)
  }

  async *createNonStreamingFallback(
    request: StreamRequest,
    ext?: OpenAIResponsesRequestExt,
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
        const requestCompat = this.applyPromptCacheCompat(requestBody)

        ext?.captureRequest?.(
          requestCompat.headers
            ? { ...requestBody, __headers: requestCompat.headers }
            : requestBody,
        )
        ext?.onNonStreamingAttempt?.(
          attempt,
          startTime,
          typeof requestBody.max_output_tokens === 'number'
            ? requestBody.max_output_tokens
            : 0,
        )

        const timeoutPolicy = resolveApiTimeoutPolicy({
          protocol: 'openai-responses',
          operation: 'non_streaming_fallback',
        })
        try {
          const response = (await withApiTimeout(
            timeoutPolicy,
            signal,
            timeoutSignal => client.responses.create(
              requestBody as unknown as ResponseCreateParamsNonStreaming,
              this.buildRequestOptions(timeoutSignal, requestCompat.headers),
            ),
          )) as Response
          this.promptCacheCompat.recordResponse({
            selection: requestCompat.selection,
            response,
          })

          const content = this.mapResponseToContent(response)
          const usage = mapOpenAIResponsesUsage(response.usage)
          const stopReason =
            response.status === 'incomplete'
              ? mapIncompleteReason(response.incomplete_details?.reason)
              : 'end_turn'

          if (content.length === 0) {
            throw new LLMAPIError(
              `Responses API returned empty content: ${summarizeUnexpectedResponse(response)}`,
              { status: 502 },
            )
          }

          const neutralMessage: LLMMessage = {
            id: response.id,
            type: 'message',
            role: 'assistant',
            content,
            model: response.model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: usage.cacheReadTokens ?? null,
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
    let body: Record<string, unknown> = {
      model: this.config.modelConfig!.model,
      input: messagesToOpenAIResponsesInput(request.messages, {
        supportsImages: this.config.modelConfig?.supportsImages ?? false,
      }),
      max_output_tokens: request.maxTokens ?? 4096,
    }

    if (request.system) {
      const instructionText = typeof request.system === 'string'
        ? request.system
        : request.system
            .filter(b => b.type === 'text')
            .map(b => (b as { text: string }).text)
            .join('\n')
      if (instructionText) {
        body.instructions = instructionText
      }
    }

    if (request.tools?.length) {
      body.tools = toolsToOpenAIResponses(request.tools)
    }
    if (request.toolChoice) {
      body.tool_choice = toolChoiceToOpenAIResponses(request.toolChoice)
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }
    if (request.stopSequences?.length) {
      body.stop = request.stopSequences
    }

    this.applyThinkingParams(body, request.thinking)

    if (this.config.modelConfig?.extraParams) {
      Object.assign(body, this.config.modelConfig.extraParams)
    }
    body = applyApiRequestPreflight('openai-responses', body)
    if (request.providerHints?.omittedRequestFields) {
      body = omitRequestFields(
        body,
        request.providerHints.omittedRequestFields as string[],
      )
    }
    if (
      request.providerHints?.stripSlashEnums &&
      Array.isArray(body.tools)
    ) {
      body = {
        ...body,
        tools: stripSlashEnumValuesFromTools(body.tools),
      }
    }
    const requestCompat = this.applyPromptCacheCompat(body)

    try {
      const timeoutPolicy = resolveApiTimeoutPolicy({
        protocol: 'openai-responses',
        operation: request.querySource === 'side_question'
          ? 'side_query'
          : 'inference',
        querySource: request.querySource,
      })
      const response = (await withApiTimeout(
        timeoutPolicy,
        request.signal,
        signal => this.client.responses.create(
          body as unknown as ResponseCreateParamsNonStreaming,
          this.buildRequestOptions(signal, requestCompat.headers),
        ),
      )) as Response
      this.promptCacheCompat.recordResponse({
        selection: requestCompat.selection,
        response,
      })

      const content = this.mapResponseToContent(response)
      const usage = mapOpenAIResponsesUsage(response.usage)
      const stopReason =
        response.status === 'incomplete'
          ? mapIncompleteReason(response.incomplete_details?.reason)
          : 'end_turn'

      if (content.length === 0) {
        throw new LLMAPIError(
          `Responses API returned empty content: ${summarizeUnexpectedResponse(response)}`,
          { status: 502 },
        )
      }

      return {
        id: response.id,
        content,
        model: response.model,
        stopReason,
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
    return null
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private applyPromptCacheCompat(
    body: Record<string, unknown>,
  ): {
    selection: PromptCacheSelection | null
    headers?: Record<string, string>
  } {
    const selection = this.promptCacheCompat.selectPromptCacheKey()
    if (selection?.selectedKey) {
      body.prompt_cache_key = selection.selectedKey
    }
    const headers = this.promptCacheCompat.buildHeaders(selection)
    return { selection, headers }
  }

  private buildRequestOptions(
    signal: AbortSignal | null | undefined,
    headers?: Record<string, string>,
  ): {
    signal?: AbortSignal | null
    maxRetries: 0
    headers?: Record<string, string>
  } {
    return {
      signal,
      maxRetries: 0,
      ...(headers ? { headers } : {}),
    }
  }

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
    const systemText = Array.isArray(intent.systemPrompt)
      ? intent.systemPrompt
          .filter((b: any) => typeof b === 'string' || b?.type === 'text')
          .map((b: any) => (typeof b === 'string' ? b : b?.text ?? ''))
          .join('\n')
      : undefined

    const rawMessages = (intent.messages as Array<{ message: import('../streamTypes.js').MessageParam }>).map(m => m.message)
    const input = messagesToOpenAIResponsesInput(rawMessages, {
      supportsImages: this.config.modelConfig?.supportsImages ?? false,
    })

    const body: Record<string, unknown> = {
      model: this.config.modelConfig!.model,
      input,
      max_output_tokens: intent.maxOutputTokens,
    }

    if (systemText) {
      body.instructions = systemText
    }

    if (intent.tools.length > 0) {
      body.tools = toolsToOpenAIResponses(intent.tools)
    }
    if (intent.toolChoice) {
      body.tool_choice = toolChoiceToOpenAIResponses(intent.toolChoice)
    }
    if (intent.temperature !== undefined) {
      body.temperature = intent.temperature
    }

    this.applyThinkingParams(body, intent.thinking)

    if (this.config.modelConfig?.extraParams) {
      Object.assign(body, this.config.modelConfig.extraParams)
    }

    return applyApiRequestPreflight('openai-responses', body)
  }

  private async buildRequestBodyForRetry(
    model: string,
    intent: Parameters<OpenAIResponsesProvider['buildRequestBody']>[1],
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
    if (retryContext.stripSlashEnums && Array.isArray(body.tools)) {
      body.tools = stripSlashEnumValuesFromTools(body.tools)
    }
    if (options.stream) {
      body.stream = true
    } else {
      delete body.stream
    }
    body.include = ['reasoning.encrypted_content']

    if (retryContext.stripReasoningReplay) {
      body.input = stripOpenAIResponsesReasoningReplay(body.input)
      delete body.include
    }

    if (retryContext.dropMaxTokens) {
      const { max_output_tokens: _dropped, ...rest } = body
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

  private getResolvedTemplate(): ResolvedTemplate {
    const cfg = this.config.modelConfig
    if (!cfg) {
      return resolveStack({
        protocol: 'openai-responses',
        vendor: 'openai-responses',
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

  /**
   * Convert a non-streaming Response object's output array to neutral
   * ContentBlock[]. Mirrors what the streaming adapter accumulates.
   */
  private mapResponseToContent(response: Response): ContentBlock[] {
    if (response.output === null) {
      throw new LLMAPIError(
        `Responses API returned null output (response.output=null): ${summarizeUnexpectedResponse(response)}`,
        { status: 502 },
      )
    }
    if (!Array.isArray(response.output)) {
      throw new LLMAPIError(
        `Responses API returned malformed output: ${summarizeUnexpectedResponse(response)}`,
        { status: 502 },
      )
    }

    const blocks: ContentBlock[] = []
    for (const item of response.output) {
      switch (item.type) {
        case 'reasoning': {
          const summaryParts = (item.summary ?? []).map(s => s.text)
          blocks.push({
            type: 'thinking',
            thinking: summaryParts.join('\n\n'),
            roundTrip: {
              provider: 'openai-responses',
              id: item.id,
              ...(item.encrypted_content
                ? { encryptedContent: item.encrypted_content }
                : {}),
              summaryParts,
            },
          })
          break
        }
        case 'message': {
          const text = (item.content ?? [])
            .filter(c => c.type === 'output_text')
            .map(c => (c as { text: string }).text)
            .join('')
          if (text) blocks.push({ type: 'text', text })
          break
        }
        case 'function_call': {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = item.arguments ? JSON.parse(item.arguments) : {}
          } catch {
            parsed = {}
          }
          blocks.push({
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: parsed,
            ...(item.arguments ? { unparsedInput: item.arguments } : {}),
          })
          break
        }
        default:
          // Built-in tool outputs are not surfaced.
          break
      }
    }
    return blocks
  }

  private emitNullOutputSalvageTrace(input: {
    error: unknown
    model: string
    attempt: number
    requestId?: string
    sink?: RecoveryTraceSink
  }): void {
    const wrapped = this.wrapError(input.error)
    emitBoundaryRecoveryDecisionTrace({
      traceId: `api-responses-null-output-salvage-${input.attempt}`,
      protocol: 'openai-responses',
      sink: input.sink,
      model: input.model,
      attempt: input.attempt,
      maxAttempts: input.attempt,
      error: input.error,
      wrappedError: wrapped,
      requestId: input.requestId ?? wrapped.request_id,
      context: {
        streamPhase: 'stream_complete',
        innerCause: formatBoundaryRecoveryCause(input.error),
      },
      operation: 'stream',
      foregroundSource: true,
      canSalvageCompletedStream: true,
      final: true,
    })
  }
}

function mapIncompleteReason(
  reason: string | null | undefined,
): import('../streamTypes.js').StopReason {
  if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'max_tokens'
  if (reason === 'content_filter') return 'content_filter'
  return 'end_turn'
}
