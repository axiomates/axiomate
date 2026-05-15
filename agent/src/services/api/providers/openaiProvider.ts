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
import type { ModelProviderConfig } from '../../../utils/config.js'
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
  RequestHooks,
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
import { withRetry } from '../withRetry.js'
import { summarizeUnexpectedResponse } from '../errors.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAIProviderConfig {
  baseUrl: string
  apiKey: string
  /** Model-level config for thinkingParams / extraParams passthrough */
  modelConfig?: ModelProviderConfig
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  private client: OpenAI
  private config: OpenAIProviderConfig

  constructor(config: OpenAIProviderConfig) {
    this.config = config
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    })
  }

  bind(_ext: unknown): BoundProvider {
    return {
      createStream: (request: StreamRequest) => this.createStream(request),
      createNonStreamingFallback: (request: StreamRequest) =>
        this.createNonStreamingFallback(request),
    }
  }

  async *createStream(
    request: StreamRequest,
    ): AsyncGenerator<SystemAPIErrorMessage, ProviderStreamResult> {
    const { model, signal, intent, hooks } = request
    const provider = this

    const body = this.buildRequestBody(model, intent)
    body.stream = true
    body.stream_options = { include_usage: true }
    if (this.config.modelConfig?.extraParams) {
      Object.assign(body, this.config.modelConfig.extraParams)
    }

    return yield* withRetry(
      () => Promise.resolve(this.client),
      async (client, attempt, retryContext) => {
        const startTime = Date.now()
        hooks?.onAttemptStart?.({ attempt, start: startTime })

        // Adaptive fallback: if a prior attempt's max_tokens was rejected
        // as too large for the model's output cap, retry without the field.
        // OpenAI lets us omit max_tokens — provider picks a default budget.
        const requestBody = retryContext.dropMaxTokens
          ? (() => {
              const { max_tokens: _dropped, ...rest } = body
              return rest
            })()
          : body

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
        thinkingConfig: { type: 'disabled' as const },
        signal,
      },
    )
  }

  /**
   * Classify a caught error as "this endpoint can't handle stream: true".
   * Kept intentionally narrow: must be a 400 whose message mentions both
   * "stream" and "not support" (in either order, case-insensitive).
   * Declines param errors, content-policy blocks, etc.
   *
   * Exposed so llm.ts can gate its 400-at-creation fallback case.
   */
  isStreamUnsupportedError(err: unknown): boolean {
    const wrapped = this.wrapError(err)
    if (wrapped.status !== 400) return false
    const msg = String(wrapped.message || '').toLowerCase()
    if (msg.includes('streaming is not supported')) return true
    if (msg.includes('stream mode is not supported')) return true
    if (msg.includes('does not support streaming')) return true
    if (msg.includes('does not support stream')) return true
    return msg.includes('not support') && msg.includes('stream')
  }

  async *createNonStreamingFallback(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, NonStreamingResult> {
    const { model, signal, intent } = request
    const body = this.buildRequestBody(model, intent)
    // Strip streaming-only fields in case a caller merged them into extraParams.
    delete body.stream
    delete body.stream_options

    try {
      const response = (await this.client.chat.completions.create(
        body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
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
  }

  classifyError(error: unknown): ErrorClassification {
    if (error instanceof LLMAbortError || (error instanceof Error && error.name === 'AbortError')) {
      return { retryable: false, type: 'abort' }
    }

    const status = error instanceof LLMAPIError ? error.status
      : error instanceof OpenAI.APIError ? error.status
      : undefined

    if (!status) {
      return { retryable: true, type: 'connection' }
    }

    switch (status) {
      case 429:
        return { retryable: true, type: 'rate_limit', statusCode: 429 }
      case 503:
      case 529:
        return { retryable: true, type: 'overloaded', statusCode: status }
      case 401:
      case 403:
        return { retryable: false, type: 'auth', statusCode: status }
      case 408:
        return { retryable: true, type: 'timeout', statusCode: 408 }
      default:
        return { retryable: status >= 500, type: 'other', statusCode: status }
    }
  }

  calculateCost(_model: string, _usage: Usage): number | null {
    // OpenAI pricing varies by model and provider. Return null — caller
    // should not assume pricing for third-party OpenAI-compatible endpoints.
    return null
  }

  wrapError(error: unknown): LLMAPIError {
    if (error instanceof LLMAPIError) return error

    if (error instanceof OpenAI.APIError) {
      if (error instanceof OpenAI.APIUserAbortError) {
        return new LLMAbortError(error)
      }
      return new LLMAPIError(error.message, {
        status: error.status,
        cause: error,
        headers: error.headers as Record<string, string> | undefined,
      })
    }

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return new LLMAbortError(error)
      }
      return new LLMAPIError(error.message, { cause: error })
    }

    return new LLMAPIError(String(error))
  }

  async verifyConnection(_options: { apiKey?: string }): Promise<boolean> {
    try {
      // Minimal request to verify the API key works
      await this.client.models.list()
      return true
    } catch (error) {
      const classified = this.classifyError(error)
      if (classified.type === 'auth') return false
      throw this.wrapError(error)
    }
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
    const messages = messagesToOpenAI(rawMessages, systemText, {
      supportsImages: this.config.modelConfig?.supportsImages ?? true,
      roundTripReasoningContent:
        this.config.modelConfig?.roundTripReasoningContent ?? false,
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

  private applyThinkingParams(
    body: Record<string, unknown>,
    thinking?: { type: string; budgetTokens?: number } | null,
  ): void {
    if (!thinking || thinking.type === 'disabled') return
    if (!this.config.modelConfig?.thinkingParams) return

    // Passthrough: merge user-declared thinking params into the request body
    Object.assign(body, this.config.modelConfig.thinkingParams)
  }

  private mapResponseContent(choice: any): ContentBlock[] {
    const blocks: ContentBlock[] = []

    if (!choice?.message) return blocks

    // Reasoning content (thinking)
    if (choice.message.reasoning_content) {
      blocks.push({
        type: 'thinking',
        thinking: choice.message.reasoning_content,
        signature: '',
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
