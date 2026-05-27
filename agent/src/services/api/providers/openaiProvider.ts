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
  type ContentBlock,
  type InferenceRequest,
  type InferenceResponse,
  type CountTokensRequest,
  type StreamEvent,
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

export interface OpenAIProviderConfig {
  baseUrl: string
  apiKey: string
  /** Model-level config for thinkingParams / extraParams passthrough */
  modelConfig?: ModelProviderConfig
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

        const requestBody = this.buildRequestBodyForRetry(
          model,
          intent,
          retryContext,
          { stream: true },
        )

        try {
          const stream = await client.chat.completions.create(
            { ...requestBody, stream: true as const } as OpenAI.ChatCompletionCreateParamsStreaming,
            { signal },
          )

          const ttfb = Date.now() - startTime
          hooks?.onProviderEvent?.({ type: 'ttfb', ms: ttfb })
          hooks?.onRequestSent?.({ maxOutputTokens: intent.maxOutputTokens })

          const state = new OpenAIStreamState(provider.config.modelConfig?.usageMapping)
          const sdkStream = stream as unknown as AsyncIterable<OpenAIChatChunk>

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
                      buffer.push(...state.mapChunk(chunk.value))
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
          // Normalize OpenAI SDK errors to neutral types before withRetry classifies them
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
          typeof requestBody.max_tokens === 'number'
            ? requestBody.max_tokens
            : 0,
        )

        try {
          const response = (await client.chat.completions.create(
            requestBody as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
            { signal },
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

  async verifyConnection(_options: { apiKey?: string }): Promise<boolean> {
    return sharedVerifyConnection(this.client)
  }

  async inference(request: InferenceRequest): Promise<InferenceResponse> {
    const body: Record<string, unknown> = {
      model: this.config.modelConfig!.model,
      messages: messagesToOpenAI(request.messages, request.system, {
        supportsImages: this.config.modelConfig?.supportsImages ?? true,
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

    try {
      const response = await this.client.chat.completions.create(
        body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { signal: request.signal },
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

  private buildRequestBodyForRetry(
    model: string,
    intent: Parameters<OpenAIProvider['buildRequestBody']>[1],
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
    if (choice.message.reasoning_content) {
      blocks.push({
        type: 'thinking',
        thinking: choice.message.reasoning_content,
        roundTrip: { provider: 'none' },
      })
    }

    // Text content
    if (choice.message.content) {
      blocks.push({
        type: 'text',
        text: choice.message.content,
      })
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
