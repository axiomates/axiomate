/**
 * Anthropic LLM Provider.
 *
 * Encapsulates: client creation, param building (via injected buildParams),
 * SDK call, retry (withRetry), stream adaptation, error classification, cost.
 *
 * paramsFromContext is injected as buildParams — it's application logic
 * (reads settings, feature flags, session state) that belongs in claude.ts,
 * not in the protocol layer. The Provider orchestrates the call sequence.
 */
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type {
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { anthropicStreamAdapter } from '../adapters/anthropicStreamAdapter.js'
import type {
  ErrorClassification,
  LLMProvider,
  NonStreamingResult,
  ProviderStreamResult,
  StreamRequest,
} from '../provider.js'
import type { LLMMessage, StreamIntent, Usage } from '../streamTypes.js'
import { withRetry, type RetryContext } from '../withRetry.js'

// ---------------------------------------------------------------------------
// Types for providerOptions
// ---------------------------------------------------------------------------

/**
 * Anthropic-specific options passed through StreamRequest.providerOptions.
 * claude.ts constructs these from its local state.
 */
export interface AnthropicProviderOptions {
  /**
   * Protocol-neutral request intent. Present for all queries.
   * OpenAI provider would use this directly; Anthropic provider uses buildParams
   * which applies Anthropic-specific serialization on top of this intent.
   */
  intent?: StreamIntent
  /** Builds Anthropic SDK params from retry context. Injected from claude.ts. */
  buildParams: (retryContext: RetryContext) => Record<string, unknown>
  /** Creates the Anthropic SDK client. */
  getClient: (options: {
    maxRetries: number
    model?: string
    fetchOverride?: unknown
    source?: string
  }) => Promise<Anthropic>
  /** withRetry options (model, fallbackModel, thinkingConfig, etc.) */
  retryOptions: Record<string, unknown>
  /** Called when a new attempt starts (for logging/metrics). */
  onAttemptStart?: (info: {
    attempt: number
    start: number
    fastMode: boolean
  }) => void
  /** Called after SDK request is sent (for logging/metrics). */
  onRequestSent?: (info: {
    maxOutputTokens: number
    clientRequestId?: string
    requestId?: string
    response?: unknown
  }) => void
  /** Optional fetch override for the SDK client. */
  fetchOverride?: unknown
  /** Query source for client creation. */
  querySource?: string
  /** Called for each raw Anthropic event before neutral adaptation. */
  onRawEvent?: (raw: any) => void
  // --- Non-streaming fallback options (only used by createNonStreamingFallback) ---
  /** Called on each non-streaming attempt (for logging/metrics). */
  onNonStreamingAttempt?: (attempt: number, start: number, maxOutputTokens: number) => void
  /** Called to capture the non-streaming request params (for logging). */
  captureRequest?: (params: Record<string, unknown>) => void
  /** Request ID of the failed streaming attempt (for correlation). */
  originatingRequestId?: string | null
}

// ---------------------------------------------------------------------------
// SDK call wrapper (localizes the single `as any` cast for beta streaming)
// ---------------------------------------------------------------------------

/**
 * Create a streaming beta messages request via the Anthropic SDK.
 *
 * The `as any` cast is required because the beta namespace's `.create()`
 * return type doesn't expose `.withResponse()` in the SDK type definitions,
 * even though it's available at runtime.
 */
async function createBetaStream(
  client: Anthropic,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{
  data: AsyncIterable<BetaRawMessageStreamEvent>
  request_id?: string
  response?: unknown
}> {
  return (client.beta.messages as any)
    .create(
      { ...params, stream: true },
      { signal },
    )
    .withResponse()
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  private costFn?: (model: string, usage: unknown) => number

  constructor(options?: { calculateUSDCost?: (model: string, usage: unknown) => number }) {
    this.costFn = options?.calculateUSDCost
  }

  async *createStream(
    request: StreamRequest,
  ): AsyncGenerator<unknown, ProviderStreamResult> {
    const opts = request.providerOptions as unknown as AnthropicProviderOptions
    const {
      buildParams,
      getClient,
      retryOptions,
      onAttemptStart,
      onRequestSent,
      fetchOverride,
      querySource,
    } = opts

    let streamRequestId: string | undefined
    let streamResponse: unknown
    let maxOutputTokens = 0

    // --- withRetry: handles retries, yields error messages ---
    const generator = withRetry(
      () =>
        getClient({
          maxRetries: 0, // Manual retry via withRetry
          model: request.model,
          fetchOverride,
          source: querySource,
        }),
      async (anthropic: Anthropic, attempt: number, context: RetryContext) => {
        const start = Date.now()
        onAttemptStart?.({
          attempt,
          start,
          fastMode: context.fastMode ?? false,
        })

        const params = buildParams(context)
        maxOutputTokens = (params as Record<string, unknown>).max_tokens as number ?? 0

        // SDK call (typed wrapper localizes the single `as any` cast)
        const result = await createBetaStream(anthropic, params, request.signal)

        streamRequestId = result.request_id
        streamResponse = result.response

        onRequestSent?.({
          maxOutputTokens,
          requestId: streamRequestId,
          response: streamResponse,
        })

        return result.data
      },
      retryOptions as any,
    )

    // Consume withRetry generator: yield retry error messages, return raw stream
    let rawStream: AsyncIterable<BetaRawMessageStreamEvent>
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        rawStream = next.value as AsyncIterable<BetaRawMessageStreamEvent>
        break
      }
      // Yield retry error messages (SystemAPIErrorMessage) to the caller
      // The 'controller' check distinguishes stream objects from error messages
      if (!('controller' in (next.value as any))) {
        yield next.value
      }
    }

    // --- Adapt raw Anthropic stream → neutral StreamEvent ---
    const neutralStream = anthropicStreamAdapter(rawStream!, opts.onRawEvent)

    return {
      stream: neutralStream,
      requestId: streamRequestId,
      responseHeaders: (streamResponse as any)?.headers as Headers | undefined,
      maxOutputTokens,
    }
  }

  classifyError(error: unknown): ErrorClassification {
    if (error instanceof APIUserAbortError) {
      return { retryable: false, type: 'abort' }
    }
    if (error instanceof APIConnectionError) {
      const details = (error as any).cause
      const code = details?.code
      if (code === 'ECONNRESET' || code === 'EPIPE') {
        return { retryable: true, type: 'connection' }
      }
      if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
        return { retryable: true, type: 'timeout' }
      }
      return { retryable: true, type: 'connection' }
    }
    if (error instanceof APIError) {
      const status = error.status
      if (status === 529) {
        return { retryable: true, type: 'overloaded', statusCode: 529 }
      }
      if (status === 429) {
        const retryAfter = (error.headers as any)?.['retry-after']
        return {
          retryable: true,
          type: 'rate_limit',
          statusCode: 429,
          retryAfterMs: retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : undefined,
        }
      }
      if (status === 401 || status === 403) {
        return { retryable: false, type: 'auth', statusCode: status }
      }
      if (status === 500 || status === 502 || status === 503) {
        return { retryable: true, type: 'overloaded', statusCode: status }
      }
      return { retryable: false, type: 'other', statusCode: status }
    }
    return { retryable: false, type: 'other' }
  }

  calculateCost(model: string, usage: Usage): number | null {
    if (!this.costFn) return null
    const anthropicUsage = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens ?? 0,
      cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
    }
    return this.costFn(model, anthropicUsage)
  }

  async *createNonStreamingFallback(
    request: StreamRequest,
  ): AsyncGenerator<unknown, NonStreamingResult> {
    const opts = request.providerOptions as unknown as AnthropicProviderOptions
    const {
      buildParams,
      getClient,
      retryOptions,
      onNonStreamingAttempt,
      captureRequest,
      fetchOverride,
      querySource,
      originatingRequestId,
    } = opts

    const fallbackTimeoutMs =
      parseInt(process.env.API_TIMEOUT_MS || '', 10) ||
      (process.env.CLAUDE_CODE_REMOTE ? 120_000 : 300_000)

    const generator = withRetry(
      () =>
        getClient({
          maxRetries: 0,
          model: request.model,
          fetchOverride,
          source: querySource,
        }),
      async (anthropic: Anthropic, attempt: number, context: RetryContext) => {
        const start = Date.now()
        const params = buildParams(context)
        captureRequest?.(params)
        onNonStreamingAttempt?.(attempt, start, (params as Record<string, unknown>).max_tokens as number ?? 0)

        // Cap max_tokens for non-streaming (64K limit)
        const maxTokensCap = 64_000
        const cappedMaxTokens = Math.min(
          (params as Record<string, unknown>).max_tokens as number ?? 0,
          maxTokensCap,
        )
        const adjustedParams = {
          ...params,
          max_tokens: cappedMaxTokens,
          // Adjust thinking budget if needed
          ...(typeof (params as any).thinking?.budget_tokens === 'number' && {
            thinking: {
              ...(params as any).thinking,
              budget_tokens: Math.min(
                (params as any).thinking.budget_tokens,
                cappedMaxTokens - 1,
              ),
            },
          }),
        }

        try {
          return await (anthropic.beta.messages as any).create(
            adjustedParams,
            {
              signal: request.signal,
              timeout: fallbackTimeoutMs,
            },
          )
        } catch (err) {
          if (err instanceof APIUserAbortError) throw err
          throw err
        }
      },
      {
        ...(retryOptions as any),
        signal: request.signal,
      },
    )

    // Consume withRetry generator: yield retry messages, return SDK result
    let sdkResult: any
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        sdkResult = next.value
        break
      }
      if ((next.value as any)?.type === 'system') {
        yield next.value
      }
    }

    // Convert BetaMessage → neutral LLMMessage
    const msg = sdkResult as {
      id: string
      model: string
      content: any[]
      stop_reason: string | null
      stop_sequence?: string | null
      usage: {
        input_tokens: number
        output_tokens: number
        cache_creation_input_tokens?: number | null
        cache_read_input_tokens?: number | null
      }
    }
    const neutralMessage: LLMMessage = {
      id: msg.id,
      type: 'message',
      role: 'assistant',
      content: msg.content,
      model: msg.model,
      stop_reason: msg.stop_reason as LLMMessage['stop_reason'],
      stop_sequence: msg.stop_sequence ?? null,
      usage: {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? null,
      },
    }

    return {
      message: neutralMessage,
      requestId: (sdkResult as any)?.request_id,
    }
  }
}
