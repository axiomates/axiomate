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
import { withRetry, type RetryContext, type RetryOptions } from '../withRetry.js'
import { summarizeUnexpectedResponse } from '../errors.js'
import {
  wrapError as sharedWrapError,
  classifyError as sharedClassifyError,
  verifyConnection as sharedVerifyConnection,
  isStreamUnsupportedError as sharedIsStreamUnsupportedError,
} from './openaiShared.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAIResponsesProviderConfig {
  baseUrl: string
  apiKey: string
  /** Model-level config for thinkingParams / extraParams passthrough */
  modelConfig?: ModelProviderConfig
}

type OpenAIResponsesRequestExt = {
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

export class OpenAIResponsesProvider implements LLMProvider {
  readonly name = 'openai-responses'
  private client: OpenAI
  private config: OpenAIResponsesProviderConfig

  constructor(config: OpenAIResponsesProviderConfig) {
    this.config = config
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
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

        const requestBody = this.buildRequestBodyForRetry(
          model,
          intent,
          retryContext,
          { stream: true },
        )

        try {
          const stream = await client.responses.create(
            { ...requestBody, stream: true } as ResponseCreateParamsStreaming,
            { signal },
          )

          const ttfb = Date.now() - startTime
          hooks?.onProviderEvent?.({ type: 'ttfb', ms: ttfb })
          hooks?.onRequestSent?.({ maxOutputTokens: intent.maxOutputTokens })

          const state = new OpenAIResponsesStreamState()
          const sdkStream = stream as unknown as AsyncIterable<ResponseStreamEvent>

          const neutralStream: AsyncIterable<StreamEvent> = {
            [Symbol.asyncIterator]: () => {
              const iter = sdkStream[Symbol.asyncIterator]()
              const buffer: StreamEvent[] = []
              let bufferIdx = 0

              return {
                async next(): Promise<IteratorResult<StreamEvent>> {
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
                      buffer.push(...state.mapEvent(chunk.value))
                    }
                    return { done: false, value: buffer[bufferIdx++]! }
                  } catch (error) {
                    throw provider.wrapError(error)
                  }
                },
              }
            },
          }

          return {
            stream: neutralStream,
            requestId: undefined,
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
        const requestBody = this.buildRequestBodyForRetry(
          model,
          intent,
          retryContext,
          { stream: false },
        )

        ext?.captureRequest?.(requestBody)
        ext?.onNonStreamingAttempt?.(
          attempt,
          startTime,
          typeof requestBody.max_output_tokens === 'number'
            ? requestBody.max_output_tokens
            : 0,
        )

        try {
          const response = (await client.responses.create(
            requestBody as unknown as ResponseCreateParamsNonStreaming,
            { signal },
          )) as Response

          const content = this.mapResponseToContent(response)
          const usage = mapOpenAIResponsesUsage(response.usage)
          const stopReason =
            response.status === 'incomplete'
              ? mapIncompleteReason(response.incomplete_details?.reason)
              : 'end_turn'

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

  async verifyConnection(_options: { apiKey?: string }): Promise<boolean> {
    return sharedVerifyConnection(this.client)
  }

  async inference(request: InferenceRequest): Promise<InferenceResponse> {
    const body: Record<string, unknown> = {
      model: this.config.modelConfig!.model,
      input: messagesToOpenAIResponsesInput(request.messages, {
        supportsImages: this.config.modelConfig?.supportsImages ?? true,
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

    try {
      const response = (await this.client.responses.create(
        body as unknown as ResponseCreateParamsNonStreaming,
        { signal: request.signal },
      )) as Response

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
      throw this.wrapError(error)
    }
  }

  async countTokens(_request: CountTokensRequest): Promise<number | null> {
    return null
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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
      supportsImages: this.config.modelConfig?.supportsImages ?? true,
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

    return body
  }

  private buildRequestBodyForRetry(
    model: string,
    intent: Parameters<OpenAIResponsesProvider['buildRequestBody']>[1],
    retryContext: RetryContext,
    options: { stream: boolean },
  ): Record<string, unknown> {
    const retryIntent = {
      ...intent,
      maxOutputTokens:
        retryContext.maxTokensOverride ?? intent.maxOutputTokens,
      thinking: retryContext.thinkingConfig,
    }
    const body = this.buildRequestBody(model, retryIntent)
    if (options.stream) {
      body.stream = true
    } else {
      delete body.stream
    }
    body.include = ['reasoning.encrypted_content']

    if (retryContext.dropMaxTokens) {
      const { max_output_tokens: _dropped, ...rest } = body
      return rest
    }
    return body
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
    const blocks: ContentBlock[] = []
    for (const item of response.output ?? []) {
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
}

function mapIncompleteReason(
  reason: string | null | undefined,
): import('../streamTypes.js').StopReason {
  if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'max_tokens'
  if (reason === 'content_filter') return 'content_filter'
  return 'end_turn'
}
