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
  ProviderStreamResult,
  StreamRequest,
} from '../provider.js'
import type { Usage } from '../streamTypes.js'
import { withRetry, type RetryContext } from '../withRetry.js'

// ---------------------------------------------------------------------------
// Types for providerOptions
// ---------------------------------------------------------------------------

/**
 * Anthropic-specific options passed through StreamRequest.providerOptions.
 * claude.ts constructs these from its local state.
 */
export interface AnthropicProviderOptions {
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
        maxOutputTokens = (params as any).max_tokens ?? 0

        // SDK call
        const result = await (anthropic as any).beta.messages
          .create(
            { ...params, stream: true },
            { signal: request.signal },
          )
          .withResponse()

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
}
