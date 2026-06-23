import type { QuerySource } from '../../constants/querySource.js'
import type { SystemAPIErrorMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { createSystemAPIErrorMessage } from '../../utils/messages.js'
import { errorMessage } from '../../utils/errors.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { classifyError } from './errorClassifier.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import type { ImageRecoveryProfile } from './imageRecovery.js'
import {
  recoveryTracePolicyGateFromAvailability,
  resolveModelFallbackAvailability,
  type ModelFallbackAvailability,
} from './recoveryFallback.js'
import { decideRecovery } from './recoveryDecision.js'
import {
  createRecoveryTraceId,
  emitRecoveryTrace,
  type RecoveryTraceContext,
  type RecoveryTraceOperation,
  type RecoveryTraceSink,
} from './recoveryTrace.js'
import {
  RecoverySession,
  type RecoveryDecision,
  type RecoveryObservation,
  normalizeRecoveryProtocol,
  type RecoveryProtocol,
} from './recoverySession.js'
import { LLMAbortError, LLMAPIError } from './streamTypes.js'
export { safeRecoveryTraceHeaders } from './recoveryTraceHeaders.js'

const abortError = () => new LLMAbortError()

const DEFAULT_MAX_RETRIES = 10
export const BASE_DELAY_MS = 500
export const MAX_PROVIDER_RETRY_AFTER_MS = 120_000

// Foreground query sources where the user IS blocking on the result — these
// retry on overloaded errors. Everything else (summaries, titles, suggestions,
// classifiers) bails immediately: during a capacity cascade each retry is
// 3-10× gateway amplification, and the user never sees those fail anyway.
//
// This classifies the MAIN request path. The auxiliary path has its own,
// intentionally different set — FOREGROUND_AUXILIARY_SOURCES in
// auxiliaryRecovery.ts — which only applies to auxiliary calls routed by
// querySource with no auxiliaryTask. The two are NOT interchangeable (different
// source universes); if you add a source here, check whether the auxiliary
// sibling also needs it.
const FOREGROUND_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  'auto_mode',
])

export function isForegroundRecoverySource(
  querySource: QuerySource | undefined,
): boolean {
  return querySource === undefined || FOREGROUND_RETRY_SOURCES.has(querySource)
}

/**
 * Single source of truth for the foreground/background classification used by
 * both the recovery DECISION and the recovery TRACE. Prefer the authoritative
 * value threaded from the auxiliary budget resolver (task + recoveryProfile
 * aware) over the querySource-only heuristic — otherwise the decision and the
 * emitted trace can disagree (decision treats an auxiliary task as foreground
 * while the trace reports background), and any new caller that recomputes from
 * querySource alone silently reintroduces that split.
 */
function resolveForegroundRecoverySource(options: RetryOptions): boolean {
  return (
    options.recoveryForegroundSource ??
    isForegroundRecoverySource(options.querySource)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

function shouldDeferModelFallback(
  classified: ReturnType<typeof classifyError>,
  options: RetryOptions,
): boolean {
  return (
    options.deferStreamCreation404Recovery &&
    classified.reason === 'model_not_found'
  )
}

function shouldDelegateStreamEndpoint404Recovery(
  classified: ReturnType<typeof classifyError>,
  options: RetryOptions,
): boolean {
  return (
    options.deferStreamCreation404Recovery &&
    classified.statusCode === 404 &&
    classified.reason === 'stream_endpoint_not_found'
  )
}

function createStreamEndpointNotFoundDecisionError(error: unknown): LLMAPIError {
  const wrapped =
    error instanceof LLMAPIError
      ? error
      : new LLMAPIError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        )
  return new LLMAPIError(`Stream endpoint not found: ${wrapped.message}`, {
    status: wrapped.status ?? 404,
    cause: wrapped,
    headers: wrapped.headers,
    request_id: wrapped.request_id,
    error: wrapped.error,
  })
}

export interface RetryContext {
  maxTokensOverride?: number
  /**
   * Provider-level adaptive flag: drop the max_tokens field from the request
   * body before retrying. Set when the classifier detects the caller's
   * max_tokens alone exceeds the model's output cap (OpenAI-family only;
   * Anthropic requires max_tokens). Providers that honor this field re-issue
   * without max_tokens and let the provider pick a default output budget.
   */
  dropMaxTokens?: boolean
  omittedRequestFields?: string[]
  stripReasoningReplay?: boolean
  downgradeMultimodalToolContent?: boolean
  stripJsonSchemaKeywords?: boolean
  stripSlashEnums?: boolean
  disableLongContextBeta?: boolean
  lowerContextTier?: boolean
  rewriteImagePayload?: boolean
  imageRecoveryProfile?: ImageRecoveryProfile
  signal?: AbortSignal
  model: string
  thinkingConfig: ThinkingConfig
  /**
   * Runtime effort override resolved at request time (env →
   * appState.effortValueByModel → static decl default). Anthropic provider
   * merges this over `modelConfig.thinking.effort` before calling
   * applyThinkingTemplate, so picker selections actually reach the wire for
   * user-configured Anthropic models. Openai-chat / openai-responses providers
   * receive the same value through `StreamIntent.thinking.effort` instead.
   */
  runtimeEffort?: import('../../utils/effort.js').EffortLevel
}

export interface RetryOptions {
  maxRetries?: number
  model: string
  protocol?: RecoveryProtocol | string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  /** Same semantics as RetryContext.runtimeEffort. */
  runtimeEffort?: import('../../utils/effort.js').EffortLevel
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * Authoritative foreground/background classification from the auxiliary
   * budget resolver (task + recoveryProfile aware). Overrides the
   * querySource-only isForegroundRecoverySource() guess so auxiliary tasks
   * (e.g. sessionTitle, auxiliary-fast) are treated as foreground and their
   * connection failures reach model fallback instead of background fail-fast.
   */
  recoveryForegroundSource?: boolean
  operation?: RecoveryTraceOperation
  traceId?: string
  onRecoveryTrace?: RecoveryTraceSink
  recoveryTraceContext?: RecoveryTraceContext
  /**
   * Streaming creation may fail before llm.ts can see transport context.
   * In that narrow path, delegate explicit model-not-found and explicit
   * stream-endpoint-not-found 404s to the outer streaming boundary.
   */
  deferStreamCreation404Recovery?: boolean
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
}

export function setRecoveryTraceContext(
  target: RecoveryTraceContext | undefined,
  patch: Partial<RecoveryTraceContext>,
): void {
  if (!target) {
    return
  }
  Object.assign(target, patch)
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<C, T>(
  getClient: () => Promise<C>,
  operation: (
    client: C,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(options.runtimeEffort !== undefined
      ? { runtimeEffort: options.runtimeEffort }
      : {}),
  }
  const session = new RecoverySession({
    protocol: options.protocol ?? 'axiomate-generic',
    initialConsecutiveOverloadedErrors:
      options.initialConsecutive529Errors,
  })
  const traceId = options.traceId ?? createRecoveryTraceId()
  let client: C | null = null
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new LLMAbortError()
    }

    try {
      // Get a fresh client instance on first attempt or after authentication
      // errors, stale OAuth tokens, or stale keep-alive sockets.
      // - ECONNRESET/EPIPE: stale keep-alive socket; disable pooling and reconnect
      const isStaleConnection = isStaleConnectionError(lastError)
      if (isStaleConnection) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        // Sticky process-level mitigation: once the pooled socket looks stale,
        // force later fetches away from keep-alive so retries open fresh TCP.
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof LLMAPIError && lastError.status === 401) ||
        isStaleConnection
      ) {
        client = await getClient()
      }

      const result = await operation(client, attempt, retryContext)
      emitRecoveredTraceIfNeeded(
        options,
        traceId,
        session.observations.at(-1),
        session.decisions.at(-1),
      )
      return result
    } catch (error) {
      lastError = error
      if (
        error instanceof LLMAbortError &&
        !(error instanceof LLMAPIError && error.status !== undefined)
      ) {
        throw error
      }
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof LLMAPIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // Observe -> decide -> execute. Classification is single-pass and the
      // recovery session retains the full failure history for traceability.
      const rawClassified = classifyError(error, {
        provider: normalizeRecoveryProtocol(options.protocol),
        model: retryContext.model,
      })
      const decisionError =
        error instanceof LLMAPIError &&
        shouldDelegateStreamEndpoint404Recovery(rawClassified, options)
          ? createStreamEndpointNotFoundDecisionError(error)
          : error
      const classified = classifyError(decisionError, {
        provider: normalizeRecoveryProtocol(options.protocol),
        model: retryContext.model,
      })

      const fallbackAvailability = resolveModelFallbackAvailability({
        currentModel: options.model,
        candidateModel: options.fallbackModel,
        classified,
        policy: options.recoveryTraceContext?.policyGate,
        deferred: shouldDeferModelFallback(classified, options),
      })
      const observation = session.observeFailure({
        attempt,
        maxAttempts: maxRetries + 1,
        model: retryContext.model,
        classified,
      })
      const decision = decideRecovery(observation, {
        fallbackAvailability,
        canFallback: fallbackAvailability.available,
        foregroundSource: resolveForegroundRecoverySource(options),
        recoveryBudgetExhausted: attempt > maxRetries,
        deferStreamEndpoint404Fallback:
          options.deferStreamCreation404Recovery,
        willRefreshClient: isStaleConnectionError(error),
        retryContext,
        history: session.history,
        error: decisionError,
        delayMsForRetryable: () => getRecoveryDelay(attempt, classified),
      })

      const previousDecision = session.history.previousDecision
      const recordedDecision = session.recordDecision(decision)
      emitDecisionTrace(
        options,
        traceId,
        observation,
        recordedDecision,
        previousDecision,
        decisionError,
        fallbackAvailability,
      )

      if (recordedDecision.contextPatch) {
        Object.assign(retryContext, recordedDecision.contextPatch)
      }

      switch (recordedDecision.disposition) {
        case 'abort':
          throw error
        case 'fallback_model':
          throw new FallbackTriggeredError(options.model, options.fallbackModel!)
        case 'throw_original':
          throw error
        case 'delegate':
        case 'fail': {
          const originalError =
            recordedDecision.failureCause === 'repeated_overloaded'
              ? new Error(REPEATED_529_ERROR_MESSAGE)
              : error
          throw new CannotRetryError(originalError, retryContext)
        }
        case 'retry':
          if (
            error instanceof LLMAPIError &&
            recordedDecision.delayMs !== undefined
          ) {
            yield createSystemAPIErrorMessage(
              error,
              recordedDecision.delayMs,
              attempt,
              maxRetries,
              classified.reason,
            )
          }
          if (recordedDecision.delayMs !== undefined) {
            await sleep(recordedDecision.delayMs, options.signal, { abortError })
          }
          continue
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function emitRecoveredTraceIfNeeded(
  options: RetryOptions,
  traceId: string,
  previousObservation: RecoveryObservation | undefined,
  previousDecision: RecoveryDecision | undefined,
): void {
  if (!previousObservation || !previousDecision) {
    return
  }
  emitRecoveryTrace(options.onRecoveryTrace, {
    traceId,
    protocol: previousObservation.protocol,
    model: previousObservation.model,
    attempt: previousObservation.attempt + 1,
    maxAttempts: previousObservation.maxAttempts,
    reason: previousObservation.reason,
    intent: previousDecision.intent,
    action: previousDecision.action,
    outcome: 'recovered',
    ruleId: previousDecision.ruleId,
    repeatPolicy: previousDecision.repeatPolicy,
    statusCode: previousObservation.statusCode,
    retryable: previousObservation.retryable,
    shouldCompress: previousObservation.shouldCompress,
    shouldFallback: previousObservation.shouldFallback,
    mutation: previousDecision.mutation,
    imageRecoveryProfile: previousDecision.contextPatch?.imageRecoveryProfile,
    requestId: options.recoveryTraceContext?.requestId,
    ttfbMs: options.recoveryTraceContext?.ttfbMs,
    elapsedMs: options.recoveryTraceContext?.elapsedMs,
    bytesReceived: options.recoveryTraceContext?.bytesReceived,
    streamPhase: options.recoveryTraceContext?.streamPhase,
    timeoutKind: options.recoveryTraceContext?.timeoutKind,
    timeoutMs: options.recoveryTraceContext?.timeoutMs,
    safeHeaders: options.recoveryTraceContext?.safeHeaders,
    operation: options.operation,
    querySource: options.querySource,
    routeId: options.recoveryTraceContext?.routeId,
    fromModel: options.recoveryTraceContext?.fromModel,
    toModel: options.recoveryTraceContext?.toModel,
    chainIndex: options.recoveryTraceContext?.chainIndex,
    policyGate: recoveryTracePolicyGateFromAvailability(
      previousObservation
        ? resolveModelFallbackAvailability({
            currentModel: options.model,
            candidateModel: options.fallbackModel,
            classified: previousObservation.classified,
            policy: options.recoveryTraceContext?.policyGate,
            deferred: shouldDeferModelFallback(
              previousObservation.classified,
              options,
            ),
          })
        : undefined,
    ),
    auxiliaryTask: options.recoveryTraceContext?.auxiliaryTask,
    foregroundSource: resolveForegroundRecoverySource(options),
    observationId: previousObservation.id,
    decisionId: previousDecision.id,
    previousReason: previousObservation.reason,
    previousIntent: previousDecision.intent,
    previousAction: previousDecision.action,
    isFirstFailure: false,
    isFirstFailureForReason: false,
    consecutiveSameReason: previousObservation.consecutiveSameReason,
    final: true,
  })
}

function emitDecisionTrace(
  options: RetryOptions,
  traceId: string,
  observation: RecoveryObservation,
  decision: RecoveryDecision,
  previousDecision: RecoveryDecision | undefined,
  error: unknown,
  fallbackAvailability: ModelFallbackAvailability,
): void {
  emitRecoveryTrace(options.onRecoveryTrace, {
    traceId,
    protocol: observation.protocol,
    model: observation.model,
    attempt: observation.attempt,
    maxAttempts: observation.maxAttempts,
    reason: observation.reason,
    intent: decision.intent,
    action: decision.action,
    outcome: decision.outcome,
    ruleId: decision.ruleId,
    repeatPolicy: decision.repeatPolicy,
    statusCode: observation.statusCode,
    retryable: observation.retryable,
    shouldCompress: observation.shouldCompress,
    shouldFallback: observation.shouldFallback,
    delayMs: decision.delayMs,
    mutation: decision.mutation,
    imageRecoveryProfile: decision.contextPatch?.imageRecoveryProfile,
    requestId:
      options.recoveryTraceContext?.requestId ??
      getTraceRequestId(error) ??
      (observation.classified as { requestId?: string }).requestId,
    ttfbMs: options.recoveryTraceContext?.ttfbMs,
    elapsedMs: options.recoveryTraceContext?.elapsedMs,
    bytesReceived: options.recoveryTraceContext?.bytesReceived,
    streamPhase: options.recoveryTraceContext?.streamPhase,
    timeoutKind: options.recoveryTraceContext?.timeoutKind,
    timeoutMs: options.recoveryTraceContext?.timeoutMs,
    innerCause:
      options.recoveryTraceContext?.innerCause ??
      getTraceInnerCause(error),
    safeHeaders: options.recoveryTraceContext?.safeHeaders,
    operation: options.operation,
    querySource: options.querySource,
    routeId: options.recoveryTraceContext?.routeId,
    fromModel: options.recoveryTraceContext?.fromModel,
    toModel: options.recoveryTraceContext?.toModel,
    chainIndex: options.recoveryTraceContext?.chainIndex,
    policyGate: recoveryTracePolicyGateFromAvailability(fallbackAvailability),
    auxiliaryTask: options.recoveryTraceContext?.auxiliaryTask,
    foregroundSource: resolveForegroundRecoverySource(options),
    observationId: observation.id,
    decisionId: decision.id,
    previousReason: observation.previousReason,
    previousIntent: previousDecision?.intent,
    previousAction: previousDecision?.action,
    isFirstFailure: observation.isFirstFailure,
    isFirstFailureForReason: observation.isFirstFailureForReason,
    consecutiveSameReason: observation.consecutiveSameReason,
    final: decision.disposition !== 'retry',
  })
}

function getTraceInnerCause(error: unknown): string | undefined {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error) {
      return formatTraceError(cause)
    }
    if (error.message.startsWith('Stream endpoint not found: ')) {
      return formatTraceError(error)
    }
    return formatTraceError(error)
  }
  if (typeof error === 'string') {
    return error.slice(0, 240)
  }
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return formatTraceError(cause)
  }
  return undefined
}

function getTraceRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const requestId =
    (error as { request_id?: unknown }).request_id ??
    (error as { requestId?: unknown }).requestId
  return typeof requestId === 'string' ? requestId : undefined
}

function formatTraceError(error: Error): string {
  return `${error.name}: ${error.message}`.slice(0, 240)
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function getRecoveryDelay(
  attempt: number,
  classified: Pick<ReturnType<typeof classifyError>, 'retryAfterMs'>,
): number {
  return Math.min(
    classified.retryAfterMs ?? getRetryDelay(attempt),
    MAX_PROVIDER_RETRY_AFTER_MS,
  )
}

export { parseMaxTokensContextOverflowError } from './recoveryDecision.js'

export function is529Error(error: unknown): boolean {
  if (!(error instanceof LLMAPIError)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // See below: the SDK sometimes fails to properly pass the 529 status code during streaming
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

export function getDefaultMaxRetries(): number {
  if (process.env.AXIOMATE_CODE_MAX_RETRIES) {
    return parseInt(process.env.AXIOMATE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}
