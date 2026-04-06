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
  ProviderEvent,
  ProviderStreamResult,
  RequestHooks,
  StreamRequest,
} from '../provider.js'
import type { SystemAPIErrorMessage } from '../../../types/message.js'
import {
  LLMAbortError,
  LLMAPIError,
} from '../streamTypes.js'
import type { LLMMessage, StreamIntent, Usage } from '../streamTypes.js'
import { CannotRetryError, withRetry, type RetryContext } from '../withRetry.js'
import { adjustParamsForNonStreaming, MAX_NON_STREAMING_TOKENS } from '../claude.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js'
import { logForDiagnosticsNoPII } from '../../../utils/diagLogs.js'
import { getSmallFastModel } from '../../../utils/model/model.js'
import { getModelBetas } from '../../../utils/betas.js'
import { getAPIMetadata, getExtraBodyParams } from '../claude.js'
import { logError } from '../../../utils/log.js'

// ---------------------------------------------------------------------------
// Session-level config (injected at construction time)
// ---------------------------------------------------------------------------

/**
 * Anthropic-specific session-level configuration.
 * Injected once at provider construction time — not per-request.
 */
export interface AnthropicProviderConfig {
  /** Creates the Anthropic SDK client. */
  getClient: (options: {
    maxRetries: number
    model?: string
    fetchOverride?: unknown
    source?: string
  }) => Promise<Anthropic>
  /** Optional cost calculator. */
  calculateUSDCost?: (model: string, usage: unknown) => number
  /** Fetch override for SDK client (session-level, e.g. proxy config). */
  fetchOverride?: unknown
  /** Query source for client creation. */
  querySource?: string
}

// ---------------------------------------------------------------------------
// Per-request retry options (passed through hooks)
// ---------------------------------------------------------------------------

/**
 * Anthropic-specific request hooks extending the neutral RequestHooks.
 * Adds fields needed by withRetry and the non-streaming fallback path.
 */
export interface AnthropicRequestHooks extends RequestHooks {
  /** withRetry options (model, fallbackModel, thinkingConfig, etc.) */
  retryOptions: Record<string, unknown>
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
  private config: AnthropicProviderConfig

  constructor(config: AnthropicProviderConfig) {
    this.config = config
  }

  async *createStream(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, ProviderStreamResult> {
    const hooks = request.hooks as AnthropicRequestHooks | undefined
    const buildParams = hooks?.buildParams
    if (!buildParams) throw new Error('AnthropicProvider requires buildParams hook')

    const { retryOptions } = hooks
    const { getClient, fetchOverride, querySource } = this.config

    let streamRequestId: string | undefined
    let streamResponse: unknown
    let maxOutputTokens = 0
    let lastAttemptStart = Date.now()

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
        lastAttemptStart = Date.now()
        hooks.onAttemptStart?.({
          attempt,
          start: lastAttemptStart,
          fastMode: context.fastMode ?? false,
        })

        const params = buildParams(context)
        maxOutputTokens = (params as Record<string, unknown>).max_tokens as number ?? 0

        // SDK call (typed wrapper localizes the single `as any` cast)
        const result = await createBetaStream(anthropic, params, request.signal)

        streamRequestId = result.request_id
        streamResponse = result.response

        hooks.onRequestSent?.({
          maxOutputTokens,
          requestId: streamRequestId,
          response: streamResponse,
        })

        return result.data
      },
      retryOptions as any,
    )

    // Consume withRetry generator: yield retry error messages, return raw stream.
    // withRetry<T> is AsyncGenerator<SystemAPIErrorMessage, T>:
    // On !done, value is SystemAPIErrorMessage; on done, value is T.
    // TypeScript cannot narrow IteratorResult as discriminated union (TS#33352),
    // so the assertions below are justified by withRetry's type contract.
    let rawStream: AsyncIterable<BetaRawMessageStreamEvent>
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        rawStream = next.value as AsyncIterable<BetaRawMessageStreamEvent>
        break
      }
      yield next.value as SystemAPIErrorMessage
    }

    // --- Adapt raw Anthropic stream → neutral StreamEvent ---
    // Convert raw SDK events → ProviderEvents and call hooks.onProviderEvent
    const onProviderEvent = hooks.onProviderEvent
    const onRawEvent = onProviderEvent
      ? (raw: BetaRawMessageStreamEvent) => {
          // TTFB from message_start
          if (raw.type === 'message_start') {
            onProviderEvent({ type: 'ttfb', ms: Date.now() - lastAttemptStart })
          }

          // Research capture
          type RawEventExt = BetaRawMessageStreamEvent & { research?: unknown }
          const ext = raw as RawEventExt
          if (raw.type === 'message_start') {
            const msg = (raw as any).message as Record<string, unknown>
            if ('research' in msg) {
              onProviderEvent({ type: 'research', data: msg.research })
            }
          }
          if (raw.type === 'content_block_delta' && ext.research !== undefined) {
            onProviderEvent({ type: 'research', data: ext.research })
          }
          if (raw.type === 'message_delta' && ext.research !== undefined) {
            onProviderEvent({ type: 'research', data: ext.research })
          }

          // Advisor state
          if (raw.type === 'content_block_start') {
            type ContentBlockExt = { type: string; name?: string }
            const block = (raw as any).content_block as ContentBlockExt
            if (block.type === 'server_tool_use' && block.name === 'advisor') {
              onProviderEvent({ type: 'advisor_start', model: request.model })
            }
            if (block.type === 'advisor_tool_result') {
              onProviderEvent({ type: 'advisor_end' })
            }
          }
        }
      : undefined
    const neutralStream = anthropicStreamAdapter(rawStream!, onRawEvent)

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
    if (!this.config.calculateUSDCost) return null
    const anthropicUsage = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens ?? 0,
      cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
    }
    return this.config.calculateUSDCost(model, anthropicUsage)
  }

  wrapError(error: unknown): LLMAPIError {
    if (error instanceof LLMAPIError) return error
    if (error instanceof APIUserAbortError) {
      return new LLMAbortError(error)
    }
    if (error instanceof APIError) {
      return new LLMAPIError(error.message, {
        status: error.status,
        cause: error,
        headers: error.headers as any,
        request_id: (error as any).request_id,
        error: (error as any).error,
      })
    }
    if (error instanceof Error) {
      return new LLMAPIError(error.message, { cause: error })
    }
    return new LLMAPIError(String(error))
  }

  async *createNonStreamingFallback(
    request: StreamRequest,
  ): AsyncGenerator<SystemAPIErrorMessage, NonStreamingResult> {
    const hooks = request.hooks as AnthropicRequestHooks | undefined
    const buildParams = hooks?.buildParams
    if (!buildParams) throw new Error('AnthropicProvider requires buildParams hook')

    const { retryOptions, onNonStreamingAttempt, captureRequest } = hooks
    const { getClient, fetchOverride, querySource } = this.config

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

        const adjustedParams = adjustParamsForNonStreaming(
          params as { max_tokens: number; thinking?: { type: string; budget_tokens?: number } },
          MAX_NON_STREAMING_TOKENS,
        )

        try {
          return await (anthropic.beta.messages as any).create(
            {
              ...adjustedParams,
              model: normalizeModelStringForAPI((adjustedParams as any).model ?? request.model),
            },
            {
              signal: request.signal,
              timeout: fallbackTimeoutMs,
            },
          )
        } catch (err) {
          if (err instanceof APIUserAbortError) throw err
          // Instrumentation: record non-streaming fallback errors
          logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
          logEvent('tengu_nonstreaming_fallback_error', {
            model: request.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            error: err instanceof Error
              ? (err.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
            attempt,
            timeout_ms: fallbackTimeoutMs,
            request_id: (hooks.originatingRequestId ??
              'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw err
        }
      },
      {
        ...(retryOptions as any),
        signal: request.signal,
      },
    )

    // withRetry yields SystemAPIErrorMessage on !done, returns BetaMessage on done.
    // TS cannot narrow IteratorResult (TS#33352), assertions justified by contract.
    let sdkResult: unknown
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        sdkResult = next.value
        break
      }
      yield next.value as SystemAPIErrorMessage
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

  /**
   * Verify API key by sending a minimal request with full Anthropic configuration
   * (betas, metadata, extra body params). Matches v0.1.0 verifyApiKey behavior.
   */
  async verifyConnection(options: { apiKey?: string }): Promise<boolean> {
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    const { getClient } = this.config

    // Use a local async generator to match withRetry's consumption pattern
    const generator = withRetry(
      () =>
        getClient({
          maxRetries: 0, // Manual retry via withRetry
          model,
          ...(options.apiKey ? { apiKey: options.apiKey } as any : {}),
          source: 'verify_api_key',
        }),
      async (anthropic) => {
        await anthropic.beta.messages.create({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'test' }],
          temperature: 1,
          ...(betas.length > 0 && { betas }),
          metadata: getAPIMetadata(),
          ...getExtraBodyParams(),
        })
        return true
      },
      { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } },
    )

    // Consume generator (withRetry yields SystemAPIErrorMessage on retry)
    let result: boolean
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        result = next.value
        break
      }
      // Ignore retry messages during verification
    }
    return result
  }
}
