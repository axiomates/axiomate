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
} from '../streamTypes.js'
import type {
  LLMProvider,
  BoundProvider,
  StreamRequest,
  ErrorClassification,
  ProviderStreamResult,
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
import { rememberUnparsedToolInputForRepair } from '../toolInputRepairMetadata.js'

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
    // OpenAI doesn't need the Anthropic-style bind pattern (no betas, no
    // per-request buildParams). For now, return a thin wrapper that delegates
    // to createStream. This can be extended if OpenAI-specific per-request
    // config is needed later.
    return {
      createStream: (request: StreamRequest) => this.createStream(request),
    }
  }

  async *createStream(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, ProviderStreamResult> {
    const { model, signal, intent, hooks } = request
    const startTime = Date.now()
    const provider = this // capture for iterator closure

    hooks?.onAttemptStart?.({ attempt: 1, start: startTime })

    const body = this.buildRequestBody(model, intent)
    // Stream defaults — set AFTER buildRequestBody (which applies extraParams),
    // then re-apply extraParams so users can override stream_options if needed
    body.stream = true
    body.stream_options = { include_usage: true }
    if (this.config.modelConfig?.extraParams) {
      Object.assign(body, this.config.modelConfig.extraParams)
    }

    try {
      const stream = await this.client.chat.completions.create(
        { ...body, stream: true as const } as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal },
      )

      const ttfb = Date.now() - startTime
      hooks?.onProviderEvent?.({ type: 'ttfb', ms: ttfb })
      hooks?.onRequestSent?.({ maxOutputTokens: intent.maxOutputTokens })

      const state = new OpenAIStreamState()

      // The OpenAI SDK stream implements Symbol.asyncIterator
      const sdkStream = stream as unknown as AsyncIterable<OpenAIChatChunk>

      // Wrap the OpenAI SDK stream into our neutral StreamEvent async iterable
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
                    // Flush unclosed blocks (e.g. thinking block without finish_reason)
                    const cleanup = state.flush()
                    if (cleanup.length > 0) {
                      buffer.push(...cleanup)
                      break // drain cleanup buffer before returning done
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

      const choice = response.choices[0]
      const content = this.mapResponseContent(choice)
      const usage = response.usage

      return {
        id: response.id,
        content,
        model: response.model,
        stopReason: mapFinishReason(choice?.finish_reason),
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
        },
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
        let unparsedInput: string | undefined
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = {}
          unparsedInput =
            typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : undefined
        }
        const block: ContentBlock = {
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        }
        if (unparsedInput) {
          rememberUnparsedToolInputForRepair(block, unparsedInput)
        }
        blocks.push(block)
      }
    }

    return blocks
  }
}
