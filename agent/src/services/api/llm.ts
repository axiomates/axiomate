import type {
  MessageParam,
} from './streamTypes.js'
import { LLMAbortError, LLMAPIError, LLMTimeoutError } from './streamTypes.js'
import { neutralToolToSDK, toolChoiceToAnthropic } from './adapters/anthropicRequestAdapter.js'
import type {
  ContentBlockParam,
  NeutralToolSchema,
  TextBlockParam,
} from './streamTypes.js'
// Stream type neutralized — uses structural interface instead of SDK Stream<T>
import { randomUUID } from 'crypto'
import { neutralUsageToDeltaUsage, updateUsage } from './usageUtils.js'
import { withStallDetection } from './middleware/stallDetection.js'
import {
  computeStallThreshold,
  estimateInputTokens,
} from './middleware/stallThreshold.js'
import { getProviderForModel } from './providerRegistry.js'
import { checkResponseForCacheBreak, recordPromptState } from './promptCacheBreakDetection.js'
import { parseRateLimitHeaders, updateRateLimitInfo } from './rateLimitTracker.js'
import {
  createPartialStreamRecoveryMessage,
  PartialStreamRecoveryError,
  processStream,
} from './streamAccumulator.js'
import { getCLISyspromptPrefix } from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  type ConnectorTextBlock,
  isConnectorTextBlock,
} from '../../types/connectorText.js'
import type {
  AssistantAPIRecovery,
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type CacheScope,
  logAPIPrefix,
  splitSysPromptPrefix,
  toolToAPISchema,
} from '../../utils/api.js'
import {
  getMergedBetas,
} from '../../utils/betas.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getModelMaxOutputTokens } from '../../utils/context.js'
import { convertEffortValueToLevel, resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { captureAPIRequest, logError } from '../../utils/log.js'
import {
  createUserMessage,
  createSystemAPIErrorMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'
import {
  getAuxiliaryTaskPolicy,
  getDefaultMainLoopModel,
} from '../../utils/model/model.js'
import type { AuxiliaryTaskId } from '../../utils/model/modelRouting.js'
import {
  auxiliaryAttemptQueryOptions,
  auxiliaryFailureAssistantMessage,
  runAuxiliaryTask,
} from './auxiliaryTaskRunner.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'

import {
  getAfkModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setLastMainRequestId,
  setThinkingClearLatched,
} from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { Notification } from '../../context/notifications.js'
import { addToTotalSessionCost } from '../../cost-tracker.js'
import type { AgentId } from '../../types/ids.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { getMaxThinkingTokensForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { type EffortValue, modelSupportsEffort } from '../../utils/effort.js'
// returnValue — not needed, verifyApiKey delegates to provider
import { headlessProfilerCheckpoint } from '../../utils/headlessProfiler.js'
import { isMcpInstructionsDeltaEnabled } from '../../utils/mcpInstructionsDelta.js'
import { calculateUSDCost } from '../../utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from '../../utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from '../../utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabled,
} from '../../utils/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import { count } from '../../utils/array.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  parseUserSpecifiedModel,
  resolveModelStringForAPI,
} from '../../utils/model/model.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../utils/telemetry/sessionTracing.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
} from '../analytics/index.js'
import { isToolFromMcpServer } from '../mcp/utils.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
import { classifyError } from './errorClassifier.js'
import {
  emitBoundaryRecoveryDecisionTrace,
  formatBoundaryRecoveryCause,
} from './boundaryRecovery.js'
import {
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
} from './errors.js'
import {
  createRecoveryTraceId,
  emitRecoveryTrace,
  type RecoveryTraceEvent,
  type RecoveryTraceSink,
} from './recoveryTrace.js'
import {
  RecoverySession,
  type RecoveryDecision,
  type RecoveryProtocol,
} from './recoverySession.js'
import { resolveModelFallbackAvailability } from './recoveryFallback.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000
import {
  CannotRetryError,
  FallbackTriggeredError,
  getDefaultMaxRetries,
  getRecoveryDelay,
  isForegroundRecoverySource,
  is529Error,
  safeRecoveryTraceHeaders,
  setRecoveryTraceContext,
  type RetryContext,
} from './withRetry.js'
import type { RecoveryTraceContext } from './recoveryTrace.js'
import { sleep } from '../../utils/sleep.js'
import { resolveApiTimeoutPolicy } from './apiTimeoutPolicy.js'
import {
  downgradeMultimodalToolResultContent,
  rewriteImagePayloadsForRecovery,
  stripUnsupportedJsonSchemaKeywordsFromTools,
} from './requestRecoveryMutations.js'

// Define a type that represents valid JSON values
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

function isLocalStreamShapeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  if (error instanceof EmptyStreamResponseError) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('missing response_start') ||
    message.includes('content block not found') ||
    (message.includes('responses stream:') &&
      message.includes('without prior'))
  )
}

class EmptyStreamResponseError extends Error {
  constructor(message = 'Stream ended without receiving any events') {
    super(message)
    this.name = 'EmptyStreamResponseError'
  }
}

function isLikelyModelNotFound404(error: LLMAPIError, model: string): boolean {
  if (error.status !== 404) {
    return false
  }

  const message = error.message.toLowerCase()
  const modelName = model.toLowerCase()
  return (
    message.includes('model_not_found') ||
    message.includes('model not found') ||
    message.includes('no such model') ||
    message.includes('invalid model') ||
    message.includes('unknown model') ||
    message.includes('unsupported model') ||
    message.includes('is not a valid model') ||
    (modelName.length > 0 &&
      message.includes(modelName) &&
      (message.includes('model') ||
        message.includes('does not exist') ||
        message.includes('not found')))
  )
}

function streamDebugScope(input: {
  querySource?: QuerySource
  routeId?: string
  model: string
  provider: string
  streamCreationTraceId: string
  streamConsumptionTraceId: string
}): string {
  return [
    `querySource=${input.querySource ?? 'unknown'}`,
    `route=${input.routeId ?? 'none'}`,
    `model=${input.model}`,
    `provider=${input.provider}`,
    `creationTrace=${input.streamCreationTraceId}`,
    `consumptionTrace=${input.streamConsumptionTraceId}`,
  ].join(' ')
}

function formatDebugError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}:${error.message}`.replace(/\s+/g, ' ').slice(0, 240)
  }
  return String(error).replace(/\s+/g, ' ').slice(0, 240)
}

function emitStreamConsumptionRecoveryTrace(input: {
  sink?: RecoveryTraceSink
  traceId: string
  session: RecoverySession
  protocol: string
  model: string
  querySource?: QuerySource
  attempt: number
  maxAttempts: number
  error: LLMAPIError
  delayMs: number
  context: RecoveryTraceContext
  recoveryBudgetExhausted: boolean
  foregroundSource: boolean
}): { trace: RecoveryTraceEvent; decision: RecoveryDecision } {
  let emitted: RecoveryTraceEvent | undefined
  const decision = emitBoundaryRecoveryDecisionTrace({
    traceId: input.traceId,
    session: input.session,
    sink: event => {
      emitted = event
      input.sink?.(event)
    },
    protocol: input.protocol,
    model: input.model,
    querySource: input.querySource,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    error: input.error,
    wrappedError: input.error,
    context: input.context,
    operation: 'stream',
    foregroundSource: input.foregroundSource,
    recoveryBudgetExhausted: input.recoveryBudgetExhausted,
    canFallback: false,
    delayMsForRetryable: () => input.delayMs,
  })
  if (!emitted) {
    throw new Error('Stream consumption recovery trace was not emitted')
  }
  return { trace: emitted, decision }
}

function streamConsumptionRetryIsExecutable(decision: RecoveryDecision): boolean {
  return decision.disposition === 'retry'
}

function emitStreamConsumptionRecoveredTrace(input: {
  sink?: RecoveryTraceSink
  retryTrace: RecoveryTraceEvent
  attempt: number
  context: RecoveryTraceContext
}): void {
  emitRecoveryTrace(input.sink, {
    traceId: input.retryTrace.traceId,
    protocol: input.retryTrace.protocol,
    model: input.retryTrace.model,
    querySource: input.retryTrace.querySource,
    attempt: input.attempt,
    maxAttempts: input.retryTrace.maxAttempts,
    reason: input.retryTrace.reason,
    intent: input.retryTrace.intent,
    action: input.retryTrace.action,
    outcome: 'recovered',
    ruleId: input.retryTrace.ruleId,
    repeatPolicy: input.retryTrace.repeatPolicy,
    statusCode: input.retryTrace.statusCode,
    retryable: input.retryTrace.retryable,
    shouldCompress: input.retryTrace.shouldCompress,
    shouldFallback: input.retryTrace.shouldFallback,
    requestId: input.context.requestId,
    ttfbMs: input.context.ttfbMs,
    elapsedMs: input.context.elapsedMs,
    bytesReceived: input.context.bytesReceived,
    streamPhase: input.context.streamPhase,
    timeoutKind: input.context.timeoutKind,
    timeoutMs: input.context.timeoutMs,
    innerCause: input.retryTrace.innerCause,
    safeHeaders: input.context.safeHeaders,
    operation: input.retryTrace.operation,
    routeId: input.context.routeId,
    fromModel: input.context.fromModel,
    toModel: input.context.toModel,
    chainIndex: input.context.chainIndex,
    policyGate: input.context.policyGate,
    auxiliaryTask: input.context.auxiliaryTask,
    foregroundSource: input.retryTrace.foregroundSource,
    previousReason: input.retryTrace.reason,
    previousIntent: input.retryTrace.intent,
    previousAction: input.retryTrace.action,
    isFirstFailure: false,
    isFirstFailureForReason: false,
    consecutiveSameReason: input.retryTrace.consecutiveSameReason,
    final: true,
  })
}

function emitStreamConsumptionAbortedTrace(input: {
  sink?: RecoveryTraceSink
  retryTrace: RecoveryTraceEvent
  attempt: number
  context: RecoveryTraceContext
  error: unknown
}): void {
  emitRecoveryTrace(input.sink, {
    traceId: input.retryTrace.traceId,
    protocol: input.retryTrace.protocol,
    model: input.retryTrace.model,
    querySource: input.retryTrace.querySource,
    attempt: input.attempt,
    maxAttempts: input.retryTrace.maxAttempts,
    reason: 'abort',
    intent: 'abort_requested',
    action: 'abort',
    outcome: 'aborted',
    repeatPolicy: 'outer_policy',
    statusCode: undefined,
    retryable: false,
    shouldCompress: false,
    shouldFallback: false,
    requestId: input.context.requestId ?? input.retryTrace.requestId,
    ttfbMs: input.context.ttfbMs,
    elapsedMs: input.context.elapsedMs,
    bytesReceived: input.context.bytesReceived,
    streamPhase: input.context.streamPhase,
    timeoutKind: input.context.timeoutKind,
    timeoutMs: input.context.timeoutMs,
    innerCause:
      formatBoundaryRecoveryCause(input.error) ?? input.retryTrace.innerCause,
    safeHeaders: input.context.safeHeaders ?? input.retryTrace.safeHeaders,
    operation: input.retryTrace.operation,
    routeId: input.context.routeId,
    fromModel: input.context.fromModel,
    toModel: input.context.toModel,
    chainIndex: input.context.chainIndex,
    policyGate: input.context.policyGate,
    auxiliaryTask: input.context.auxiliaryTask,
    foregroundSource: input.retryTrace.foregroundSource,
    previousReason: input.retryTrace.reason,
    previousIntent: input.retryTrace.intent,
    previousAction: input.retryTrace.action,
    isFirstFailure: false,
    isFirstFailureForReason: false,
    consecutiveSameReason: input.retryTrace.consecutiveSameReason,
    final: true,
  })
}

function emitStreamConsumptionPartialSalvageTrace(input: {
  sink?: RecoveryTraceSink
  traceId: string
  protocol: string
  model: string
  querySource?: QuerySource
  attempt: number
  maxAttempts: number
  error: LLMAPIError
  context: RecoveryTraceContext
  previousTrace?: RecoveryTraceEvent
}): void {
  const classified = classifyError(input.error, {
    provider: input.protocol,
    model: input.model,
  })
  const previous = input.previousTrace
  emitRecoveryTrace(input.sink, {
    traceId: input.traceId,
    protocol: previous?.protocol ?? (input.protocol as RecoveryProtocol),
    model: previous?.model ?? input.model,
    querySource: previous?.querySource ?? input.querySource,
    attempt: input.attempt,
    maxAttempts: previous?.maxAttempts ?? input.maxAttempts,
    reason: previous?.reason ?? classified.reason,
    intent: 'salvage_completed_stream_output',
    action: 'continue_partial_stream',
    outcome: 'salvaged',
    repeatPolicy: 'outer_policy',
    statusCode: previous?.statusCode ?? classified.statusCode,
    retryable: previous?.retryable ?? classified.retryable,
    shouldCompress: previous?.shouldCompress ?? classified.shouldCompress,
    shouldFallback: previous?.shouldFallback ?? classified.shouldFallback,
    requestId: input.context.requestId ?? previous?.requestId,
    ttfbMs: input.context.ttfbMs,
    elapsedMs: input.context.elapsedMs,
    bytesReceived: input.context.bytesReceived,
    streamPhase: input.context.streamPhase,
    timeoutKind: input.context.timeoutKind,
    timeoutMs: input.context.timeoutMs,
    innerCause: input.context.innerCause ?? previous?.innerCause,
    safeHeaders: input.context.safeHeaders ?? previous?.safeHeaders,
    operation: previous?.operation ?? 'stream',
    routeId: input.context.routeId,
    fromModel: input.context.fromModel,
    toModel: input.context.toModel,
    chainIndex: input.context.chainIndex,
    policyGate: input.context.policyGate,
    auxiliaryTask: input.context.auxiliaryTask,
    foregroundSource: previous?.foregroundSource,
    previousReason: previous?.reason,
    previousIntent: previous?.intent,
    previousAction: previous?.action,
    isFirstFailure: false,
    isFirstFailureForReason: false,
    consecutiveSameReason: previous?.consecutiveSameReason,
    final: true,
  })
}

function emitNonStreamingFallbackRecoveryTrace(input: {
  sink?: RecoveryTraceSink
  traceId: string
  protocol: string
  model: string
  querySource?: QuerySource
  error: unknown
  decisionError?: unknown
  context: RecoveryTraceContext
  foregroundSource: boolean
}): void {
  const traceError = input.decisionError ?? input.error
  const wrappedError =
    traceError instanceof LLMAPIError
      ? traceError
      : new LLMAPIError(
          traceError instanceof Error
            ? traceError.message
            : String(traceError),
          { cause: traceError },
        )
  emitBoundaryRecoveryDecisionTrace({
    traceId: input.traceId,
    sink: input.sink,
    protocol: input.protocol,
    model: input.model,
    querySource: input.querySource,
    attempt: 1,
    maxAttempts: 1,
    error: input.error,
    wrappedError,
    context: { ...input.context, streamPhase: 'fallback' },
    operation: 'non_streaming_fallback',
    foregroundSource: input.foregroundSource,
    recoveryBudgetExhausted: false,
    canFallback: false,
    canUseNonStreamingFallback: true,
    final: false,
  })
}

function apiRecoveryFromRetryContext(
  retryContext: RetryContext | undefined,
): AssistantAPIRecovery | undefined {
  if (!retryContext) {
    return undefined
  }

  if (retryContext.lowerContextTier) {
    return {
      action: 'lower_context_tier',
      intent: 'lower_long_context_tier',
      lowerContextTier: true,
    }
  }

  if (retryContext.rewriteImagePayload) {
    return {
      action: 'rewrite_image_payload',
      intent: 'rewrite_image_payload_for_retry',
      rewriteImagePayload: true,
      imageRecoveryProfile: retryContext.imageRecoveryProfile,
    }
  }

  return undefined
}

export interface StreamFallbackSafetyContext {
  committedAssistantMessages?: number
  debugLabel?: string
  allowStreamEndpoint404Fallback?: boolean
}

export function shouldUseNonStreamingFallbackForStreamError(
  provider: import('./provider.js').LLMProvider,
  error: unknown,
  model: string,
  context: StreamFallbackSafetyContext = {},
): boolean {
  const wrappedError = provider.wrapError(error)
  const providerStreamUnsupported =
    provider.isStreamUnsupportedError?.(error) ?? false
  const likelyModelNotFound404 =
    wrappedError.status === 404 && isLikelyModelNotFound404(wrappedError, model)
  const localStreamShapeWrapped = isLocalStreamShapeError(wrappedError)
  const localStreamShapeCause = isLocalStreamShapeError(
    wrappedError.cause ?? error,
  )
  const classified = classifyError(wrappedError, {
    provider: provider.name,
    model,
  })
  let decision = false
  let rule = 'not_evaluated'

  // Once processStream has yielded an assistant message, downstream tool
  // dispatch may already be active. Replaying the same request in non-streaming
  // mode can duplicate tool_use execution, so recovery must propagate instead.
  if ((context.committedAssistantMessages ?? 0) > 0) {
    rule = 'blocked_committed_assistant_messages'
  } else if (providerStreamUnsupported) {
    decision = true
    rule = 'provider_stream_unsupported'
  } else if (
    context.allowStreamEndpoint404Fallback === true &&
    wrappedError.status === 404
  ) {
    decision = classified.reason === 'stream_endpoint_not_found'
    rule = likelyModelNotFound404
      ? '404_model_not_found_not_request_mode'
      : classified.reason === 'provider_policy_blocked'
        ? '404_provider_policy_not_request_mode'
        : decision
          ? '404_stream_endpoint_shape'
          : '404_not_request_mode'
  } else if (wrappedError.status === 404) {
    rule = likelyModelNotFound404
      ? '404_model_not_found_not_request_mode'
      : '404_not_stream_creation_context'
  } else if (localStreamShapeWrapped || localStreamShapeCause) {
    rule = 'local_stream_shape_error_retry_stream_first'
  } else if (
    classified.reason === 'timeout' ||
    classified.reason === 'rate_limit' ||
    classified.reason === 'overloaded' ||
    classified.reason === 'server_error' ||
    classified.reason === 'connection' ||
    classified.reason === 'context_overflow' ||
    classified.reason === 'max_tokens_too_large' ||
    classified.reason === 'thinking_signature' ||
    classified.reason === 'long_context_tier'
  ) {
    rule = 'retryable_or_request_error_uses_retry_semantics'
  } else {
    // Only local stream validation/protocol-shape failures fall back to
    // non-streaming. Other status-less local errors keep the normal retry path.
    rule = 'no_non_streaming_fallback_rule'
  }

  logNonStreamingFallbackDecision({
    label: context.debugLabel,
    provider: provider.name,
    model,
    error,
    wrappedError,
    classified,
    committedAssistantMessages: context.committedAssistantMessages ?? 0,
    allowStreamEndpoint404Fallback:
      context.allowStreamEndpoint404Fallback === true,
    providerStreamUnsupported,
    likelyModelNotFound404,
    localStreamShapeWrapped,
    localStreamShapeCause,
    decision,
    rule,
  })

  return decision
}

function logNonStreamingFallbackDecision(input: {
  label?: string
  provider: string
  model: string
  error: unknown
  wrappedError: LLMAPIError
  classified: ReturnType<typeof classifyError>
  committedAssistantMessages: number
  allowStreamEndpoint404Fallback: boolean
  providerStreamUnsupported: boolean
  likelyModelNotFound404: boolean
  localStreamShapeWrapped: boolean
  localStreamShapeCause: boolean
  decision: boolean
  rule: string
}): void {
  if (!input.label) {
    return
  }
  logForDebugging(
    [
      '[api:non-streaming-fallback:decision]',
      `label=${input.label}`,
      `provider=${input.provider}`,
      `model=${input.model}`,
      `decision=${input.decision}`,
      `rule=${input.rule}`,
      `reason=${input.classified.reason}`,
      `retryable=${input.classified.retryable}`,
      `status=${input.wrappedError.status ?? 'none'}`,
      `committedAssistantMessages=${input.committedAssistantMessages}`,
      `allowStreamEndpoint404Fallback=${input.allowStreamEndpoint404Fallback}`,
      `providerStreamUnsupported=${input.providerStreamUnsupported}`,
      `likelyModelNotFound404=${input.likelyModelNotFound404}`,
      `localStreamShapeWrapped=${input.localStreamShapeWrapped}`,
      `localStreamShapeCause=${input.localStreamShapeCause}`,
      `error=${formatDebugError(input.error)}`,
      `wrapped=${formatDebugError(input.wrappedError)}`,
    ].join(' '),
    { level: 'debug' },
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

function shouldRetryStreamingConsumptionError(
  provider: import('./provider.js').LLMProvider,
  error: unknown,
  model: string,
): boolean {
  if (shouldUseNonStreamingFallbackForStreamError(provider, error, model)) {
    return false
  }

  const wrappedError = provider.wrapError(error)
  const classified = classifyError(wrappedError, {
    provider: provider.name,
    model,
  })

  return classified.retryable
}

function resolveStreamIdleTimeoutPolicy(protocol: string, overrideMs?: number) {
  const policy = resolveApiTimeoutPolicy({
    protocol:
      protocol === 'openai-chat' ||
      protocol === 'openai-responses' ||
      protocol === 'anthropic'
        ? protocol
        : 'axiomate-generic',
    operation: 'stream',
    streamPhase: 'streaming',
  })
  return overrideMs !== undefined ? { ...policy, timeoutMs: overrideMs } : policy
}

/**
 * Parse the AXIOMATE_CODE_EXTRA_BODY environment variable into a
 * provider-neutral JSON object that gets spread into every API request.
 * Users set this to inject arbitrary fields (e.g. provider-specific options)
 * without axiomate needing to know about them.
 */
export function getExtraBodyParams(): JsonObject {
  const extraBodyStr = process.env.AXIOMATE_CODE_EXTRA_BODY
  if (!extraBodyStr) return {}

  try {
    const parsed = safeParseJSON(extraBodyStr)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Shallow clone — safeParseJSON is LRU-cached and returns the same
      // object reference for the same string. Callers mutate the result
      // (see configureEffortParams), which would poison the cache.
      return { ...(parsed as JsonObject) }
    }
    logForDebugging(
      `AXIOMATE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
      { level: 'error' },
    )
  } catch (error) {
    logForDebugging(
      `Error parsing AXIOMATE_CODE_EXTRA_BODY: ${errorMessage(error)}`,
      { level: 'error' },
    )
  }
  return {}
}

export function getPromptCachingEnabled(model: string): boolean {
  // Global disable takes precedence
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // Disable for small/fast auxiliary route primaries.
  if (isEnvTruthy(process.env.AXIOMATE_DISABLE_PROMPT_CACHING_FAST_MODEL)) {
    if (isAuxiliaryProfilePrimary(model, 'auxiliary-fast')) {
      return false
    }
  }

  // Disable for quality/judge auxiliary route primaries.
  if (isEnvTruthy(process.env.AXIOMATE_DISABLE_PROMPT_CACHING_MID_MODEL)) {
    if (
      isAuxiliaryProfilePrimary(model, 'auxiliary-quality') ||
      isAuxiliaryProfilePrimary(model, 'auxiliary-judge')
    ) {
      return false
    }
  }

  // Check if we should disable for the configured main model
  if (isEnvTruthy(process.env.AXIOMATE_DISABLE_PROMPT_CACHING_MAIN_MODEL)) {
    const mainModel = getDefaultMainLoopModel()
    if (model === mainModel) return false
  }

  return true
}

function isAuxiliaryProfilePrimary(model: string, profile: string): boolean {
  const config = getGlobalConfig()
  for (const task of Object.keys(config.auxiliary ?? {})) {
    try {
      const policy = getAuxiliaryTaskPolicy(task)
      if (policy.primary === model && policy.recoveryProfile === profile) {
        return true
      }
    } catch {
      // Ignore partially configured auxiliary policies; validation surfaces
      // those elsewhere.
    }
  }
  return false
}

export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * Determines if 1h TTL should be used for prompt caching. 1h TTL is part of
 * the public Anthropic messages API (cache_control), enabled for all
 * Anthropic-protocol providers — they support it natively. OpenAI-protocol
 * providers don't use cache_control so this is irrelevant for them
 * (getCacheControl is only called in the Anthropic request-builder path).
 */
function should1hCacheTTL(_querySource?: QuerySource): boolean {
  return true
}

/** Anthropic output_config shape — local type to avoid SDK import. */
type OutputConfig = Record<string, unknown> & { effort?: string; format?: unknown }

/**
 * Configure effort parameters for API request.
 *
 */
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: OutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  // Models with a user-supplied ModelProviderConfig route effort through
  // the vendor template (anthropicProvider.ts:applyThinkingTemplate).
  // Skipping here avoids double-writing output_config.effort.
  if (getGlobalConfig().models?.[model]) {
    return
  }

  if (effortValue === undefined) {
    // No effort override — use server default
  } else if (typeof effortValue === 'string') {
    // Send string effort level as is
    outputConfig.effort = effortValue
  }
}


export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
  onRecoveryTrace?: RecoveryTraceSink,
  modelOverride?: string,
): Promise<boolean> {
  // Skip API verification if running in print mode (isNonInteractiveSession)
  if (isNonInteractiveSession) {
    return true
  }

  const model = modelOverride ?? getAuxiliaryTaskPolicy('verifyConnection').primary
  try {
    const provider = getProviderForModel(model)
    if (!provider.verifyConnection) {
      return true // Provider doesn't support verification
    }
    return await provider.verifyConnection({ model, apiKey, onRecoveryTrace })
  } catch (error) {
    logError(error)
    const classified = classifyError(error, { provider: 'axiomate', model })
    if (
      classified.reason === 'auth' ||
      classified.reason === 'auth_permanent'
    ) {
      return false
    }
    throw error
  }
}

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // Clone array content to prevent in-place mutations from contaminating the
  // original message.
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking' &&
          (true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })) as ContentBlockParam[], // ContentBlock[] → ContentBlockParam[] at SDK boundary (echo-back)
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content as ContentBlockParam[], // ContentBlock[] → ContentBlockParam[] at SDK boundary
  }
}

export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: import('./streamTypes.js').ToolChoice | undefined
  isNonInteractiveSession: boolean
  /** Anthropic server-side tools (web_search, etc.) — bypasses neutralToolToSDK */
  extraServerTools?: Record<string, unknown>[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  recoveryRouteId?: string
  recoveryFromModel?: string
  recoveryChainIndex?: number
  recoveryPolicyGate?: RecoveryTraceContext['policyGate']
  recoveryAuxiliaryTask?: string
  recoveryMaxRetries?: number
  // Authoritative foreground/background classification computed by the
  // auxiliary budget resolver (which considers task + recoveryProfile). When
  // set it overrides the querySource-only isForegroundRecoverySource() guess —
  // auxiliary tasks like sessionTitle (auxiliary-fast) are foreground for
  // recovery purposes even though their querySource is not in the foreground
  // retry source set, so connection failures must still reach model fallback.
  recoveryForegroundSource?: boolean
  recoveryTimeoutMs?: number
  onStreamingFallback?: () => void
  onRecoveryTrace?: RecoveryTraceSink
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: unknown
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId // Only set for subagents
  outputFormat?: import('./streamTypes.js').NeutralOutputFormat
  addNotification?: (notif: Notification) => void
}

export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // Store the assistant message but continue consuming the generator to ensure
  // logAPISuccessAndDuration gets called (which happens after all yields)
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // If the signal was aborted, throw APIUserAbortError instead of a generic error
    // This allows callers to handle abort scenarios gracefully
    if (signal.aborted) {
      throw new LLMAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

/**
 * Per-attempt timeout for non-streaming fallback requests, in milliseconds.
 * Reads API_TIMEOUT_MS when set so slow backends and the streaming path
 * share the same ceiling.
 *
 * Otherwise defaults to 300s — long enough for slow backends without
 * approaching the API's 10-minute non-streaming boundary.
 */
/**
 * Extracts the request ID from the most recent assistant message in the
 * conversation. Used to link consecutive API requests in analytics so we can
 * join them for cache-hit-rate analysis and incremental token tracking.
 *
 * Deriving this from the message array (rather than global state) ensures each
 * query chain (main thread, subagent, teammate) tracks its own request chain
 * independently, and rollback/undo naturally updates the value.
 */
function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

// isMedia, isToolResult, stripExcessMediaItems moved to anthropicMessagePreprocessing.ts
import { stripExcessMediaItems } from './anthropicMessagePreprocessing.js'
export { stripExcessMediaItems } from './anthropicMessagePreprocessing.js'

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // Derive previous request ID from the last assistant message in this query chain.
  // This is scoped per message array (main thread, subagent, teammate each have their own),
  // so concurrent agents don't clobber each other's request chain tracking.
  // Also naturally handles rollback/undo since removed messages won't be in the array.
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  const resolvedModel = options.model

  queryCheckpoint('query_tool_schema_build_start')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model)

  // Check if tool search is enabled (checks mode, model support, and threshold for auto mode)
  // This is async because it may need to calculate MCP tool description sizes for TstAuto mode
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

  // Precompute once — isDeferredTool does 2 config lookups per call
  const deferredToolNames = new Set<string>()
  if (useToolSearch) {
    for (const t of tools) {
      if (isDeferredTool(t)) deferredToolNames.add(t.name)
    }
  }

  // Even if tool search mode is enabled, skip if there are no deferred tools
  // AND no MCP servers are still connecting. When servers are pending, keep
  // ToolSearch available so the model can discover tools after they connect.
  if (
    useToolSearch &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      'Tool search disabled: no deferred tools available to search',
    )
    useToolSearch = false
  }

  // Filter out ToolSearchTool if tool search is not enabled
  let filteredTools: Tools

  if (useToolSearch) {
    // Dynamic tool loading: only include deferred tools that ToolSearchTool
    // has already surfaced in the message history. This removes the need to
    // predeclare every deferred tool schema upfront, and with it the practical
    // limit on tool quantity.
    const discoveredToolNames = extractDiscoveredToolNames(messages)

    filteredTools = tools.filter(tool => {
      // Always include non-deferred tools
      if (!deferredToolNames.has(tool.name)) return true
      // Always include ToolSearchTool (so it can discover more tools)
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
      // Only include deferred tools that have been discovered
      return discoveredToolNames.has(tool.name)
    })
  } else {
    filteredTools = tools.filter(
      t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME),
    )
  }

  // Global cache scope is unused — axiomate always uses 'none'.
  const globalCacheStrategy: GlobalCacheStrategy = 'none'

  // Build tool schemas for the filtered tool list.
  // Note: We pass the full `tools` list (not filteredTools) to toolToAPISchema so that
  // ToolSearchTool's prompt can list ALL available MCP tools. The filtering only affects
  // which tools are actually sent to the API, not what the model sees in tool descriptions.
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
      }),
    ),
  )

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, t =>
      deferredToolNames.has(t.name),
    )
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    )
  }

  queryCheckpoint('query_tool_schema_build_end')

  // Normalize messages before building system prompt (needed for fingerprinting)
  // Instrumentation: Track message count before normalization

  queryCheckpoint('query_message_normalization_start')
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  queryCheckpoint('query_message_normalization_end')

  // Repair tool_use/tool_result pairing mismatches that can occur when resuming
  // interrupted sessions. Inserts synthetic error tool_results for orphaned
  // tool_uses and strips orphaned tool_results referencing non-existent tool_uses.
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // Strip excess media items before making the API call.
  // The API rejects requests with >100 media items but returns a confusing error.
  // Rather than erroring (which is hard to recover from in embedded host
  // sessions), we silently drop the oldest media items to stay within the limit.
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // Instrumentation: Track message count after normalization

  if (useToolSearch) {
    const deferredToolList = tools
      .filter(t => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
          isMeta: true,
        }),
        ...messagesForAPI,
      ]
    }
  }

  systemPrompt = asSystemPrompt(
    [
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
    ].filter(Boolean),
  )

  // Prepend system prompt block for easy API identification
  logAPIPrefix(systemPrompt)

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    querySource: options.querySource,
  })
  const useBetas = betas.length > 0

  // Build minimal context for detailed tracing (when beta tracing is enabled)
  // Note: The actual new_context message extraction is done in sessionTracing.ts using
  // hash-based tracking per querySource (agent) from the messagesForAPI array
  const allTools = [...toolSchemas]

  // Server tools (web_search, etc.) bypass neutralToolToSDK and are passed
  // as raw objects to the API.
  const serverTools: Record<string, unknown>[] = [
    ...(options.extraServerTools ?? []),
  ]

  // Sticky-on latches for dynamic beta headers. Each header, once first
  // sent, keeps being sent for the rest of the session so mid-session
  // toggles don't change the server-side cache key and bust ~50-70K tokens.
  // Latches are cleared on /clear and /compact via clearBetaHeaderLatches().
  // Per-call gates (isAgenticQuery, querySource===repl_main_thread) stay
  // per-call so non-agentic queries keep their own stable header set.

  let afkHeaderLatched = getAfkModeHeaderLatched() === true

  // Only latch from agentic queries so a classifier call doesn't flip the
  // main thread's context_management mid-turn.
  let thinkingClearLatched = getThinkingClearLatched() === true
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  const effort = resolveAppliedEffort(
    options.model,
    options.effortValue !== undefined
      ? { [options.model]: options.effortValue }
      : undefined,
  )

  const newContext: LLMRequestNewContext | undefined = isBetaTracingEnabled()
    ? {
        systemPrompt: systemPrompt.join('\n\n'),
        querySource: options.querySource,
        tools: jsonStringify(allTools),
      }
    : undefined

  // Capture the span so we can pass it to endLLMRequestSpan later
  // This ensures responses are matched to the correct request when multiple requests run in parallel
  const llmSpan = startLLMRequestSpan(
    options.model,
    newContext,
    messagesForAPI,
  )

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  // Raw stream is now managed by the Provider internally.
  // This variable is kept for releaseStreamResources() which is called from
  // idle timer and error handlers. cleanupStream(undefined) is a no-op.
  let stream: { controller: { signal: AbortSignal; abort(): void } } | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in Node 18+ and is used by the SDK
  let streamResponse: Response | undefined = undefined

  // Release all stream resources to prevent native memory leaks.
  // The Response object holds native TLS/socket buffers that live outside the
  // V8 heap (observed on the Node.js/npm path; see GH #32920), so we must
  // explicitly cancel and release it regardless of how the generator exits.
  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // Capture the betas sent in the last API request, including the ones that
  // were dynamically added, so we can log and send it to telemetry.
  let lastRequestBetas: string[] | undefined

  const paramsFromContext = async (retryContext: RetryContext) => {
    const betasParams = retryContext.disableLongContextBeta
      ? betas.filter(beta => !beta.toLowerCase().includes('context'))
      : [...betas]


    const extraBodyParams = getExtraBodyParams()

    const outputConfig: OutputConfig = {
      ...((extraBodyParams.output_config as OutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    // Merge outputFormat into extraBodyParams.output_config alongside effort
    // Requires structured-outputs beta header per SDK (see parse() in messages.mjs)
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat
    }

    // Retry context gets preference because it tries to course correct if we exceed the context window limit
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking =
      retryContext.thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_THINKING)
    let thinking: { type: 'enabled' | 'adaptive' | 'disabled'; budget_tokens?: number } | undefined = undefined

    // IMPORTANT: Do not change the adaptive-vs-budget thinking selection below
    // without notifying the model launch DRI and research. This is a sensitive
    // setting that can greatly affect model quality and bashing.
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        !isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        // For models that support adaptive thinking, always use adaptive
        // thinking without a budget.
        thinking = {
          type: 'adaptive' as const,
        }
      } else {
        // For models that do not support adaptive thinking, use the default
        // thinking budget unless explicitly specified.
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          retryContext.thinkingConfig.type === 'enabled' &&
          retryContext.thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = retryContext.thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled' as const,
        }
      }
    }

    // Get API context management strategies if enabled
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: false,
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)


    // Only send temperature when thinking is disabled — the API requires
    // temperature: 1 when thinking is enabled, which is already the default.
    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    lastRequestBetas = betasParams

    // Record prompt state for cache break detection.
    // Compares hashes across requests to identify what caused cache invalidation.
    recordPromptState({
      system,
      toolSchemas: allTools,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      globalCacheStrategy,
      betas: betasParams,
      autoModeActive: false,
      cachedMCEnabled: false,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    })

    let retryMessagesForAPI = retryContext.downgradeMultimodalToolContent
      ? (downgradeMultimodalToolResultContent(
          messagesForAPI,
        ) as typeof messagesForAPI)
      : messagesForAPI
    if (retryContext.rewriteImagePayload) {
      retryMessagesForAPI = await rewriteImagePayloadsForRecovery(
        retryMessagesForAPI,
        {
          profile: retryContext.imageRecoveryProfile,
        },
      )
    }
    const retryTools = retryContext.stripJsonSchemaKeywords
      ? stripUnsupportedJsonSchemaKeywordsFromTools(allTools)
      : allTools

    const params = {
      model: resolveModelStringForAPI(options.model),
      messages: addCacheBreakpoints(
        retryMessagesForAPI,
        enablePromptCaching,
        options.querySource,
        false,
        null,
        [],
        options.skipCacheWrite,
      ),
      system,
      tools: [
        ...retryTools.map(neutralToolToSDK),
        ...serverTools,
      ],
      tool_choice: toolChoiceToAnthropic(options.toolChoice),
      ...(betasParams.length > 0 && { betas: betasParams }),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        betasParams.length > 0 && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
    }

    for (const field of retryContext.omittedRequestFields ?? []) {
      delete (params as Record<string, unknown>)[field]
    }
    return params
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let hasResponseStart = false
  const contentBlocks: (import('./streamTypes.js').ContentBlock | ConnectorTextBlock)[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: import('./streamTypes.js').StopReason = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined = undefined
  let research: unknown = undefined
  const provider = getProviderForModel(options.model)

  // --- Build protocol-neutral StreamIntent ---
  // Declared before try so it's accessible in both the main path and catch fallbacks.
  const hasThinkingForIntent =
    thinkingConfig.type !== 'disabled' &&
    !isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_THINKING)
  // Picker effort already resolved at line 1350 above. Pass it through the
  // neutral intent so providers (openai-chat / openai-responses / anthropic)
  // can merge it over the static decl.thinking.effort before applying the
  // vendor template — the wizard-written default no longer silently wins
  // over the user's runtime choice.
  const intentEffort =
    effort !== undefined ? convertEffortValueToLevel(effort) : undefined
  const neutralThinking: import('./streamTypes.js').StreamIntent['thinking'] =
    hasThinkingForIntent && modelSupportsThinking(options.model)
      ? modelSupportsAdaptiveThinking(options.model) &&
          !isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_ADAPTIVE_THINKING)
        ? { type: 'adaptive', ...(intentEffort ? { effort: intentEffort } : {}) }
        : {
            type: 'enabled',
            budgetTokens: getMaxThinkingTokensForModel(options.model),
            ...(intentEffort ? { effort: intentEffort } : {}),
          }
      : { type: 'disabled' }

  const streamIntent: import('./streamTypes.js').StreamIntent = {
    model: options.model,
    messages: messagesForAPI,
    systemPrompt: system,
    tools: allTools,
    toolChoice: options.toolChoice as import('./streamTypes.js').ToolChoice | undefined,
    maxOutputTokens: options.maxOutputTokensOverride || getMaxOutputTokensForModel(options.model),
    temperature: options.temperatureOverride,
    thinking: neutralThinking,
  }

  const recoveryTraceContext: RecoveryTraceContext = {
    streamPhase: 'client_init',
    routeId: options.recoveryRouteId,
    fromModel: options.recoveryFromModel,
    toModel: options.fallbackModel,
    chainIndex: options.recoveryChainIndex,
    policyGate: options.recoveryPolicyGate,
    auxiliaryTask: options.recoveryAuxiliaryTask,
  }
  const streamCreationTraceId = createRecoveryTraceId('api-stream-creation')
  const streamConsumptionTraceId = createRecoveryTraceId(
    'api-stream-consumption',
  )
  const streamConsumptionRecoverySession = new RecoverySession({
    protocol: provider.name,
  })
  const nonStreamingFallbackTraceId = createRecoveryTraceId(
    'api-stream-non-streaming-fallback',
  )
  const maxStreamConsumptionRetries =
    options.recoveryMaxRetries ?? getDefaultMaxRetries()
  const maxStreamConsumptionAttempts = maxStreamConsumptionRetries + 1
  const streamDebug = streamDebugScope({
    querySource: options.querySource,
    routeId: options.recoveryRouteId,
    model: options.model,
    provider: provider.name,
    streamCreationTraceId,
    streamConsumptionTraceId,
  })
  logForDebugging(
    `[api:stream-orchestrator:init] ${streamDebug} fallbackModel=${options.fallbackModel ?? 'none'} maxConsumptionRetries=${maxStreamConsumptionRetries}`,
    { level: 'debug' },
  )
  const foregroundRecoverySource =
    options.recoveryForegroundSource ??
    isForegroundRecoverySource(options.querySource)

  // --- Provider-specific config (hoisted before try for fallback reuse) ---
  const streamingExt = {
    buildParams: async (context: RetryContext) => {
      const params = await paramsFromContext(context)
      captureAPIRequest(params, options.querySource)
      return params
    },
    onRecoveryTrace: options.onRecoveryTrace,
    retryOptions: {
      protocol: provider.name,
      model: options.model,
      fallbackModel: options.fallbackModel,
      thinkingConfig,
      // Anthropic provider reads context.runtimeEffort to merge the picker's
      // current effort over the static decl before applyThinkingTemplate.
      // openai-chat / openai-responses use StreamIntent.thinking.effort
      // instead — both surfaces are kept in sync so picker changes always
      // reach the wire.
      ...(intentEffort !== undefined ? { runtimeEffort: intentEffort } : {}),
      signal,
      querySource: options.querySource,
      recoveryForegroundSource: options.recoveryForegroundSource,
      operation: 'stream',
      traceId: streamCreationTraceId,
      onRecoveryTrace: options.onRecoveryTrace,
      recoveryTraceContext,
    },
  } satisfies import('./provider.js').ProviderRequestExt

  // Separate from provider creation retries: this outer loop restarts a stream
  // after retryable consumption failures before any assistant message exists.
  // It may replay UI stream events (ttfb/response_start) from a fresh stream;
  // final assistant content stays clean because processStream is recreated.
  let streamConsumptionAttempt = 0
  let lastStreamConsumptionRetryTrace: RecoveryTraceEvent | undefined
  streamConsumptionRetry: while (true) {
    streamConsumptionAttempt++
    logForDebugging(
      `[api:stream-orchestrator:attempt-start] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt}/${maxStreamConsumptionAttempts}`,
      { level: 'debug' },
    )
    didFallBackToNonStreaming = false
    fallbackMessage = undefined
    setRecoveryTraceContext(recoveryTraceContext, {
      requestId: undefined,
      safeHeaders: undefined,
      streamPhase: 'client_init',
      ttfbMs: undefined,
      bytesReceived: undefined,
      elapsedMs: undefined,
      timeoutKind: undefined,
      timeoutMs: undefined,
      innerCause: undefined,
    })
    try {
    queryCheckpoint('query_client_creation_start')

    const bound = provider.bind(streamingExt)
    const providerGen = bound.createStream({
      model: options.model,
      signal,
      intent: streamIntent,
      hooks: {
        onAttemptStart: (info: { attempt: number; start: number }) => {
          attemptNumber = info.attempt
          start = info.start
          setRecoveryTraceContext(recoveryTraceContext, {
            streamPhase: 'request_sent',
            elapsedMs: 0,
          })
          attemptStartTimes.push(info.start)
          queryCheckpoint('query_client_creation_end')
          queryCheckpoint('query_api_request_sent')
          if (!options.agentId) {
            headlessProfilerCheckpoint('api_request_sent')
          }
        },
        onRequestSent: (info: { maxOutputTokens: number; requestId?: string; response?: unknown }) => {
          maxOutputTokens = info.maxOutputTokens
          streamRequestId = info.requestId
          streamResponse = info.response as Response | undefined
          setRecoveryTraceContext(recoveryTraceContext, {
            requestId: info.requestId,
            streamPhase: 'response_headers',
            safeHeaders: safeRecoveryTraceHeaders(
              (info.response as { headers?: Headers } | undefined)?.headers,
            ),
            elapsedMs: Date.now() - start,
          })
          queryCheckpoint('query_response_headers_received')
        },
        onProviderEvent: (event: import('./provider.js').ProviderEvent) => {
          if (event.type === 'ttfb') {
            ttftMs = event.ms
            setRecoveryTraceContext(recoveryTraceContext, {
              ttfbMs: event.ms,
              streamPhase: 'first_byte',
              elapsedMs: Date.now() - start,
            })
          }
          if (event.type === 'bytes') {
            setRecoveryTraceContext(recoveryTraceContext, {
              bytesReceived:
                (recoveryTraceContext.bytesReceived ?? 0) + event.bytes,
              elapsedMs: Date.now() - start,
            })
          }
          if (event.type === 'research') {
          }
        },
      },
    })

    // Consume Provider generator: yield retry messages, get stream result
    // Provider generator yields SystemAPIErrorMessage (retry notifications) then
    // returns ProviderStreamResult. TS cannot narrow IteratorResult (TS#33352),
    // so assertions are justified by the LLMProvider.createStream() type contract.
    let providerResult: import('./provider.js').ProviderStreamResult
    for (;;) {
      const next = await providerGen.next()
      if (next.done) {
        providerResult = next.value as import('./provider.js').ProviderStreamResult
        break
      }
      yield next.value as SystemAPIErrorMessage
    }
    logForDebugging(
      `[api:stream-orchestrator:provider-result] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} requestId=${providerResult.requestId ?? 'none'} maxOutputTokens=${providerResult.maxOutputTokens}`,
      { level: 'debug' },
    )
    maxOutputTokens = providerResult.maxOutputTokens
    streamRequestId = providerResult.requestId
    setRecoveryTraceContext(recoveryTraceContext, {
      requestId: providerResult.requestId ?? recoveryTraceContext.requestId,
      safeHeaders:
        safeRecoveryTraceHeaders(providerResult.responseHeaders) ??
        recoveryTraceContext.safeHeaders,
      streamPhase: 'streaming',
      elapsedMs: Date.now() - start,
    })

    // reset state
    newMessages.length = 0
    ttftMs = 0
    hasResponseStart = false
    contentBlocks.length = 0
    usage = EMPTY_USAGE
    stopReason = null

    // Streaming idle timeout watchdog: abort the stream if no chunks arrive
    // for the resolved stream idle timeout. Unlike the stall detection below (which only
    // fires when the *next* chunk arrives), this uses setTimeout to actively
    // kill hung streams. Without this, a silently dropped connection can hang
    // the session indefinitely since the SDK's request timeout only covers the
    // initial fetch(), not the streaming body.
    const streamWatchdogEnabled = isEnvTruthy(
      process.env.AXIOMATE_ENABLE_STREAM_WATCHDOG,
    )
    const streamIdleTimeoutPolicy = resolveStreamIdleTimeoutPolicy(
      provider.name,
      options.recoveryTimeoutMs,
    )
    const envStreamIdleTimeoutMs = parseInt(
      process.env.AXIOMATE_STREAM_IDLE_TIMEOUT_MS || '',
      10,
    )
    const streamIdleTimeoutMs =
      envStreamIdleTimeoutMs > 0
        ? envStreamIdleTimeoutMs
        : streamIdleTimeoutPolicy.timeoutMs
    const streamIdleWarningMs = streamIdleTimeoutMs / 2
    let streamIdleAborted = false
    // performance.now() snapshot when watchdog fires, for measuring abort propagation delay
    let streamWatchdogFiredAt: number | null = null
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    function clearStreamIdleTimers(): void {
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer)
        streamIdleWarningTimer = null
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }
    function resetStreamIdleTimer(): void {
      clearStreamIdleTimers()
      if (!streamWatchdogEnabled) {
        return
      }
      streamIdleWarningTimer = setTimeout(
        warnMs => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
            { level: 'warn' },
          )
          logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
        },
        streamIdleWarningMs,
        streamIdleWarningMs,
      )
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        setRecoveryTraceContext(
          recoveryTraceContext,
          streamIdleTimeoutPolicy,
        )
        logForDebugging(
          `Streaming idle timeout: no chunks received for ${streamIdleTimeoutMs / 1000}s, aborting stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        releaseStreamResources()
      }, streamIdleTimeoutMs)
    }
    resetStreamIdleTimer()

    startSessionActivity('api_call')
    try {
      let stallCount = 0
      let totalStallTime = 0

      // Provider already adapted raw stream → neutral StreamEvent (with onRawEvent callback)
      const neutralStream = providerResult.stream

      // --- Stall detection middleware (protocol-agnostic) ---
      // Threshold is per-request adaptive: per-model override → local-hostname
      // shortcut → max(absolute-token, ratio-of-window). See stallThreshold.ts.
      const monitoredStream = withStallDetection(neutralStream, {
        thresholdMs: computeStallThreshold({
          baseUrl: getGlobalConfig().models?.[options.model]?.baseUrl,
          model: options.model,
          estimatedInputTokens: estimateInputTokens(messagesForAPI),
        }),
        onFirstEvent() {
          logForDebugging('Stream started - received first chunk')
          setRecoveryTraceContext(recoveryTraceContext, {
            streamPhase: 'streaming',
            elapsedMs: Date.now() - start,
          })
          queryCheckpoint('query_first_chunk_received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
          }
          endQueryProfile()
        },
        onStall(info) {
          stallCount = info.stallCount
          totalStallTime = info.totalStallTimeMs
          logForDebugging(
            `Streaming stall detected: ${(info.durationMs / 1000).toFixed(1)}s gap between events (stall #${info.stallCount})`,
            { level: 'warn' },
          )
        },
        onStreamEnd(summary) {
          logForDebugging(
            `Streaming completed with ${summary.stallCount} stall(s), total stall time: ${(summary.totalStallTimeMs / 1000).toFixed(1)}s`,
            { level: 'warn' },
          )
        },
      })

      // --- Consume neutral stream via processStream ---
      const accumulatorConfig = {
        tools,
        agentId: options.agentId,
        model: options.model,
        streamRequestId,
        maxOutputTokens,
      }
      const accumulator = processStream(monitoredStream, accumulatorConfig)
      let accResult: import('./streamAccumulator.js').StreamAccumulatorResult | undefined

      for (;;) {
        const next = await accumulator.next()
        if (next.done) {
          accResult = next.value
          break
        }
        const output = next.value as import('./streamAccumulator.js').StreamOutput
        switch (output.type) {
          case 'assistant_message': {
            const m = output.message
            newMessages.push(m)
            yield m
            break
          }
          case 'error_message':
            yield output.message
            break
          case 'stream_event': {
            // Idle timer reset (protocol-agnostic: any event = stream alive)
            resetStreamIdleTimer()
            // Cost calculation on response_delta
            if (output.event.type === 'response_delta') {
              const deltaUsage = neutralUsageToDeltaUsage(output.event.usage)
              usage = updateUsage(usage, deltaUsage)
              stopReason = output.event.stopReason as typeof stopReason
              // Use full NonNullableUsage for cost (includes server_tool_use, service_tier)
              const costUSDForPart = calculateUSDCost(resolvedModel, usage)
              costUSD += addToTotalSessionCost(
                costUSDForPart,
                usage,
                options.model,
              )
            }
            // Yield neutral stream event for UI
            yield {
              type: 'stream_event',
              event: output.event,
              ...(output.event.type === 'response_start'
                ? { ttftMs }
                : undefined),
            }
            break
          }
        }
      }

      // Update state from processStream result for post-loop checks
      if (accResult) {
        if (accResult.hasResponseStart) {
          hasResponseStart = true
        }
        if (accResult.stopReason) {
          stopReason = accResult.stopReason as typeof stopReason
        }
      }
      logForDebugging(
        `[api:stream-orchestrator:accumulator-result] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} requestId=${streamRequestId ?? 'none'} hasResponseStart=${hasResponseStart} newMessages=${newMessages.length} stopReason=${stopReason ?? 'null'} usage=input:${usage.input_tokens},output:${usage.output_tokens}`,
        { level: 'debug' },
      )
      // Clear the idle timeout watchdog now that the stream loop has exited
      clearStreamIdleTimers()
      setRecoveryTraceContext(recoveryTraceContext, {
        streamPhase: 'stream_complete',
        elapsedMs: Date.now() - start,
      })

      // If the stream was aborted by our idle timeout watchdog, fall back to
      // non-streaming retry rather than treating it as a completed stream.
      if (streamIdleAborted) {
        // Instrumentation: proves the for-await exited after the watchdog fired
        // (vs. hung forever). exit_delay_ms measures abort propagation latency:
        // 0-10ms = abort worked; >>1000ms = something else woke the loop.
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        setRecoveryTraceContext(recoveryTraceContext, {
          streamPhase: 'streaming',
          elapsedMs: Date.now() - start,
          ...resolveStreamIdleTimeoutPolicy(
            provider.name,
            options.recoveryTimeoutMs,
          ),
        })
        // Prevent double-emit: this throw lands in the catch block below,
        // whose exit_path='error' probe guards on streamWatchdogFiredAt.
        streamWatchdogFiredAt = null
        throw new LLMTimeoutError('Stream idle timeout - no chunks received')
      }

      // Detect when the stream completed without producing any assistant messages.
      // This covers two proxy failure modes:
      // 1. No events at all (!partialMessage): proxy returned 200 with non-SSE body
      // 2. Partial events (partialMessage set but no content blocks completed AND
      //    no stop_reason received): proxy returned message_start but stream ended
      //    before content_block_stop and before message_delta with stop_reason
      // BetaMessageStream had the first check in _endRequest() but the raw Stream
      // does not - without it the generator silently returns no assistant messages,
      // causing "Execution error" in -p mode.
      // Note: We must check stopReason to avoid false positives. For example, with
      // structured output (--json-schema), the model calls a StructuredOutput tool
      // on turn 1, then on turn 2 responds with end_turn and no content blocks.
      // That's a legitimate empty response, not an incomplete stream.
      if (!hasResponseStart || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          [
            !hasResponseStart
              ? 'Stream completed without receiving message_start event - entering recovery'
              : 'Stream completed with message_start but no content blocks completed - entering recovery',
            streamDebug,
            `consumptionAttempt=${streamConsumptionAttempt}`,
            `requestId=${streamRequestId ?? 'none'}`,
            `newMessages=${newMessages.length}`,
            `stopReason=${stopReason ?? 'null'}`,
            `bytes=${recoveryTraceContext.bytesReceived ?? 'none'}`,
            `ttfbMs=${recoveryTraceContext.ttfbMs ?? 'none'}`,
          ].join(' '),
          { level: 'error' },
        )
        throw new EmptyStreamResponseError(
          !hasResponseStart
            ? 'Stream ended without receiving any events'
            : 'Stream ended before producing assistant output',
        )
      }

      if (lastStreamConsumptionRetryTrace) {
        emitStreamConsumptionRecoveredTrace({
          sink: options.onRecoveryTrace,
          retryTrace: lastStreamConsumptionRetryTrace,
          attempt: streamConsumptionAttempt,
          context: recoveryTraceContext,
        })
        lastStreamConsumptionRetryTrace = undefined
      }

      // Stall summary is now logged by withStallDetection.onStreamEnd

      // Check if the cache actually broke based on response tokens.
      // Skips automatically for providers that don't return cache metrics.
      void checkResponseForCacheBreak(
        options.querySource,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
        messages,
        options.agentId,
        streamRequestId,
      )

      // Process response headers for rate limit tracking and gateway detection
      const resp = streamResponse
      if (resp) {
        // Track rate limit state from provider headers (OpenAI x-ratelimit-* or Anthropic anthropic-ratelimit-*)
        const rlInfo = parseRateLimitHeaders(resp.headers, 'axiomate')
        if (rlInfo) updateRateLimitInfo(rlInfo)
        // Store headers for gateway detection
        responseHeaders = resp.headers
        setRecoveryTraceContext(recoveryTraceContext, {
          safeHeaders:
            safeRecoveryTraceHeaders(resp.headers) ??
            recoveryTraceContext.safeHeaders,
        })
      }
    } catch (streamingError) {
      // Clear the idle timeout watchdog on error path too
      clearStreamIdleTimers()
      logForDebugging(
        `[api:stream-orchestrator:catch] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} requestId=${streamRequestId ?? 'none'} hasResponseStart=${hasResponseStart} newMessages=${newMessages.length} stopReason=${stopReason ?? 'null'} error=${formatDebugError(streamingError)}`,
        { level: 'error' },
      )
      setRecoveryTraceContext(recoveryTraceContext, {
        elapsedMs: Date.now() - start,
        innerCause: formatBoundaryRecoveryCause(streamingError),
        ...(streamIdleAborted
          ? resolveStreamIdleTimeoutPolicy(
              provider.name,
              options.recoveryTimeoutMs,
            )
          : {}),
      })

      // Instrumentation: if the watchdog had already fired and the for-await
      // threw (rather than exiting cleanly), record that the loop DID exit and
      // how long after the watchdog. Distinguishes true hangs from error exits.
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
      }

      if (provider.wrapError(streamingError) instanceof LLMAbortError) {
        // Check if the abort signal was triggered by the user (ESC key)
        // If the signal is aborted, it's a user-initiated abort
        // If not, it's likely a timeout from the SDK
        if (signal.aborted) {
          if (lastStreamConsumptionRetryTrace) {
            emitStreamConsumptionAbortedTrace({
              sink: options.onRecoveryTrace,
              retryTrace: lastStreamConsumptionRetryTrace,
              attempt: streamConsumptionAttempt,
              context: recoveryTraceContext,
              error: streamingError,
            })
            logForDebugging(
              `[api:stream-orchestrator:abort-terminal-trace] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} previousReason=${lastStreamConsumptionRetryTrace.reason} previousAction=${lastStreamConsumptionRetryTrace.action}`,
              { level: 'warn' },
            )
            lastStreamConsumptionRetryTrace = undefined
          }
          // This is a real user abort (ESC key was pressed)
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          throw streamingError
        } else {
          // The SDK threw APIUserAbortError but our signal wasn't aborted
          // This means it's a timeout from the SDK's internal timeout
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          streamingError = new LLMTimeoutError('Request timed out')
        }
      }

      // When the flag is enabled, skip the non-streaming fallback and let the
      // error propagate to withRetry. The mid-stream fallback causes double tool
      // execution when streaming tool execution is active: the partial stream
      // starts a tool, then the non-streaming retry produces the same tool_use
      // and runs it again.
      const disableFallback =
        isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        false

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        throw streamingError
      }

      if (
        !shouldUseNonStreamingFallbackForStreamError(
          provider,
          streamingError,
          options.model,
          {
            committedAssistantMessages: newMessages.length,
            debugLabel: 'stream-consumption-catch',
          },
        )
      ) {
        if (
          streamingError instanceof PartialStreamRecoveryError &&
          newMessages.length === 0
        ) {
          const wrappedStreamingError = provider.wrapError(
            streamingError.originalError,
          )
          setRecoveryTraceContext(recoveryTraceContext, {
            streamPhase: 'streaming',
            elapsedMs: Date.now() - start,
            innerCause: formatBoundaryRecoveryCause(streamingError),
            ...(streamIdleAborted
              ? resolveStreamIdleTimeoutPolicy(
                  provider.name,
                  options.recoveryTimeoutMs,
                )
              : {}),
          })
          emitStreamConsumptionPartialSalvageTrace({
            sink: options.onRecoveryTrace,
            traceId: streamConsumptionTraceId,
            protocol: provider.name,
            model: options.model,
            querySource: options.querySource,
            attempt: streamConsumptionAttempt,
            maxAttempts: maxStreamConsumptionAttempts,
            error: wrappedStreamingError,
            context: recoveryTraceContext,
            previousTrace: lastStreamConsumptionRetryTrace,
          })
          lastStreamConsumptionRetryTrace = undefined
          const m = createPartialStreamRecoveryMessage({
            response: streamingError.response,
            snapshot: streamingError.snapshot,
            usage: streamingError.usage,
            streamRequestId: streamingError.streamRequestId,
          })
          newMessages.push(m)
          stopReason = 'max_tokens'
          yield m
          break
        }

        if (
          newMessages.length === 0 &&
          shouldRetryStreamingConsumptionError(
            provider,
            streamingError instanceof PartialStreamRecoveryError
              ? streamingError.originalError
              : streamingError,
            options.model,
          ) &&
          streamConsumptionAttempt <= maxStreamConsumptionRetries
        ) {
          const errorForRetry =
            streamingError instanceof PartialStreamRecoveryError
              ? streamingError.originalError
              : streamingError
          const wrappedStreamingError = provider.wrapError(errorForRetry)
          const classified = classifyError(wrappedStreamingError, {
            provider: provider.name,
            model: options.model,
          })
          const delayMs = getRecoveryDelay(
            streamConsumptionAttempt,
            classified,
          )
          setRecoveryTraceContext(recoveryTraceContext, {
            streamPhase: 'streaming',
            elapsedMs: Date.now() - start,
            innerCause: formatBoundaryRecoveryCause(streamingError),
            ...(streamIdleAborted
              ? resolveStreamIdleTimeoutPolicy(
                  provider.name,
                  options.recoveryTimeoutMs,
                )
              : {}),
          })
          const streamConsumptionRecovery = emitStreamConsumptionRecoveryTrace({
            sink: options.onRecoveryTrace,
            traceId: streamConsumptionTraceId,
            session: streamConsumptionRecoverySession,
            protocol: provider.name,
            model: options.model,
            querySource: options.querySource,
            attempt: streamConsumptionAttempt,
            maxAttempts: maxStreamConsumptionAttempts,
            error: wrappedStreamingError,
            delayMs,
            context: recoveryTraceContext,
            recoveryBudgetExhausted: false,
            foregroundSource: foregroundRecoverySource,
          })
          if (
            !streamConsumptionRetryIsExecutable(
              streamConsumptionRecovery.decision,
            )
          ) {
            logForDebugging(
              `[api:stream-orchestrator:retry-not-executable] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} decision=${streamConsumptionRecovery.decision.action}/${streamConsumptionRecovery.decision.outcome} reason=${streamConsumptionRecovery.trace.reason}`,
              { level: 'debug' },
            )
            throw wrappedStreamingError
          }
          lastStreamConsumptionRetryTrace = streamConsumptionRecovery.trace
          logForDebugging(
            `[api:stream-orchestrator:retry-decision] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} nextAttempt=${streamConsumptionAttempt + 1} reason=${streamConsumptionRecovery.trace.reason} action=${streamConsumptionRecovery.trace.action} outcome=${streamConsumptionRecovery.trace.outcome} rule=${streamConsumptionRecovery.trace.ruleId ?? 'none'} delayMs=${delayMs}`,
            { level: 'warn' },
          )
          yield createSystemAPIErrorMessage(
            wrappedStreamingError,
            delayMs,
            streamConsumptionAttempt,
            maxStreamConsumptionRetries,
            classified.reason,
          )
          await sleep(delayMs, signal)
          continue streamConsumptionRetry
        }

        if (
          newMessages.length === 0 &&
          streamConsumptionAttempt > maxStreamConsumptionRetries &&
          shouldRetryStreamingConsumptionError(
            provider,
            streamingError instanceof PartialStreamRecoveryError
              ? streamingError.originalError
              : streamingError,
            options.model,
          ) &&
          !(streamingError instanceof PartialStreamRecoveryError)
        ) {
          const wrappedStreamingError = provider.wrapError(streamingError)
          const classified = classifyError(wrappedStreamingError, {
            provider: provider.name,
            model: options.model,
          })
          setRecoveryTraceContext(recoveryTraceContext, {
            streamPhase: 'streaming',
            elapsedMs: Date.now() - start,
            innerCause: formatBoundaryRecoveryCause(streamingError),
            ...(streamIdleAborted
              ? resolveStreamIdleTimeoutPolicy(
                  provider.name,
                  options.recoveryTimeoutMs,
                )
              : {}),
          })
          emitStreamConsumptionRecoveryTrace({
            sink: options.onRecoveryTrace,
            traceId: streamConsumptionTraceId,
            session: streamConsumptionRecoverySession,
            protocol: provider.name,
            model: options.model,
            querySource: options.querySource,
            attempt: streamConsumptionAttempt,
            maxAttempts: maxStreamConsumptionAttempts,
            error: wrappedStreamingError,
            delayMs: getRecoveryDelay(streamConsumptionAttempt, classified),
            context: recoveryTraceContext,
            recoveryBudgetExhausted: true,
            foregroundSource: foregroundRecoverySource,
          })
          logForDebugging(
            `[api:stream-orchestrator:retry-exhausted] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} reason=${classified.reason} error=${formatDebugError(wrappedStreamingError)}`,
            { level: 'error' },
          )
          throw wrappedStreamingError
        }

        logForDebugging(
          `Error streaming (handled by retry semantics, not non-streaming fallback): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        throw streamingError
      }

      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      didFallBackToNonStreaming = true
      setRecoveryTraceContext(recoveryTraceContext, {
        streamPhase: 'fallback',
        elapsedMs: Date.now() - start,
      })
      emitNonStreamingFallbackRecoveryTrace({
        sink: options.onRecoveryTrace,
        traceId: nonStreamingFallbackTraceId,
        protocol: provider.name,
        model: options.model,
        querySource: options.querySource,
        error: provider.wrapError(streamingError),
        context: recoveryTraceContext,
        foregroundSource: foregroundRecoverySource,
      })
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }


      // Fall back to non-streaming mode with retries.
      // If the streaming failure was itself a 529, count it toward the
      // consecutive-529 budget so total 529s-before-model-fallback is the
      // same whether the overload was hit in streaming or non-streaming mode.
      // This is a speculative fix for https://github.com/axiomates/axiomate/issues/1513
      // Instrumentation: proves executeNonStreamingRequest was entered (vs. the
      // fallback event firing but the call itself hanging at dispatch).
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      const fallbackBound = provider.bind({
        ...streamingExt,
        retryOptions: {
          ...streamingExt.retryOptions,
          operation: 'non_streaming_fallback',
          traceId: nonStreamingFallbackTraceId,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          recoveryTraceContext,
        },
        onNonStreamingAttempt: (attempt: number, _start: number, tokens: number) => {
          attemptNumber = attempt
          maxOutputTokens = tokens
        },
        captureRequest: (params: Record<string, unknown>) => captureAPIRequest(params, options.querySource),
        originatingRequestId: streamRequestId,
      } satisfies import('./provider.js').ProviderRequestExt)
      if (!fallbackBound.createNonStreamingFallback) {
        throw new Error('Provider does not support non-streaming fallback')
      }
      const fallbackGen = fallbackBound.createNonStreamingFallback({
        model: options.model,
        signal,
        intent: streamIntent,
      })
      let fallbackResult: import('./provider.js').NonStreamingResult
      for (;;) {
        const next = await fallbackGen.next()
        if (next.done) { fallbackResult = next.value as import('./provider.js').NonStreamingResult; break }
        yield next.value as SystemAPIErrorMessage
      }

      const m: AssistantMessage = {
        message: {
          ...fallbackResult.message,
          content: normalizeContentFromAPI(
            fallbackResult.message.content,
            tools,
            options.agentId,
          ),
        },
        requestId: fallbackResult.requestId ?? streamRequestId ?? undefined,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      }
      newMessages.push(m)
      fallbackMessage = m
      yield m
    } finally {
      clearStreamIdleTimers()
    }
  } catch (errorFromRetry) {
    // FallbackTriggeredError must propagate to query.ts, which performs the
    // actual model switch. Swallowing it here would turn the fallback into a
    // no-op — the user would just see "Model fallback triggered: X -> Y" as
    // an error message with no actual retry on the fallback model.
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    if (provider.wrapError(errorFromRetry) instanceof LLMAbortError) {
      if (lastStreamConsumptionRetryTrace) {
        emitStreamConsumptionAbortedTrace({
          sink: options.onRecoveryTrace,
          retryTrace: lastStreamConsumptionRetryTrace,
          attempt: streamConsumptionAttempt,
          context: recoveryTraceContext,
          error: errorFromRetry,
        })
        logForDebugging(
          `[api:stream-orchestrator:abort-terminal-trace] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} previousReason=${lastStreamConsumptionRetryTrace.reason} previousAction=${lastStreamConsumptionRetryTrace.action}`,
          { level: 'warn' },
        )
        lastStreamConsumptionRetryTrace = undefined
      }
      releaseStreamResources()
      return
    }

    // Check if this is a 404 error during stream creation that should trigger
    // non-streaming fallback. This handles gateways that return 404 for streaming
    // endpoints but work fine with non-streaming. Before v2.1.8, BetaMessageStream
    // threw 404s during iteration (caught by inner catch with fallback), but now
    // with raw streams, 404s are thrown during creation (caught here).
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      (() => {
        const wrapped = provider.wrapError(errorFromRetry.originalError)
        const classified = classifyError(wrapped, {
          provider: provider.name,
          model: options.model,
        })
        return (
          wrapped.status === 404 &&
          classified.reason === 'stream_endpoint_not_found' &&
          !isLikelyModelNotFound404(wrapped, options.model)
        )
      })()

    const isDeferredModelNotFound404 =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      !!options.fallbackModel &&
      options.fallbackModel !== options.model &&
      (() => {
        const wrapped = provider.wrapError(errorFromRetry.originalError)
        return (
          wrapped.status === 404 &&
          isLikelyModelNotFound404(wrapped, options.model)
        )
      })()

    if (isDeferredModelNotFound404) {
      const wrapped = provider.wrapError(errorFromRetry.originalError)
      const boundaryFallbackAvailability = resolveModelFallbackAvailability({
        currentModel: options.model,
        candidateModel: options.fallbackModel,
        classified: classifyError(wrapped, {
          provider: provider.name,
          model: options.model,
        }),
        policy: options.recoveryPolicyGate,
      })
      if (boundaryFallbackAvailability.available) {
        const boundaryDecision = emitBoundaryRecoveryDecisionTrace({
          traceId: streamCreationTraceId,
          sink: options.onRecoveryTrace,
          protocol: provider.name,
          model: options.model,
          attempt: attemptNumber,
          maxAttempts: attemptNumber,
          error: errorFromRetry.originalError,
          wrappedError: wrapped,
          context: {
            ...recoveryTraceContext,
            streamPhase: 'client_init',
            elapsedMs: Date.now() - start,
            innerCause: formatBoundaryRecoveryCause(
              errorFromRetry.originalError,
            ),
          },
          operation: 'stream',
          querySource: options.querySource,
          fallbackAvailability: boundaryFallbackAvailability,
          foregroundSource: foregroundRecoverySource,
          recoveryBudgetExhausted: true,
          final: true,
        })
        if (boundaryDecision.disposition === 'fallback_model') {
          throw new FallbackTriggeredError(
            options.model,
            options.fallbackModel!,
          )
        }
        const apiRecovery = {
          action: boundaryDecision.action,
          intent: boundaryDecision.intent,
          reason: 'model_not_found' as const,
          mutation: boundaryDecision.mutation,
        }
        yield getAssistantMessageFromError(wrapped, options.model, {
          messages,
          messagesForAPI,
          apiRecovery,
        })
        releaseStreamResources()
        return
      }
    }

    // Check if this is a 400 whose message indicates the endpoint does not
    // support streaming at all (e.g. DeepSeek-OCR). The provider's heuristic
    // decides whether the 400 body matches known "streaming not supported"
    // phrasing — this avoids false positives on unrelated 400s.
    const rawErrorForStreamCheck = errorFromRetry instanceof CannotRetryError
      ? errorFromRetry.originalError
      : errorFromRetry
    const streamCreationUnsupported = provider.isStreamUnsupportedError?.(
      rawErrorForStreamCheck,
    ) ?? false
    logForDebugging(
      [
        '[api:non-streaming-fallback:stream-creation-check]',
        `provider=${provider.name}`,
        `model=${options.model}`,
        `is404StreamCreationError=${is404StreamCreationError}`,
        `isDeferredModelNotFound404=${isDeferredModelNotFound404}`,
        `is400StreamUnsupportedError=${streamCreationUnsupported}`,
        `error=${formatDebugError(rawErrorForStreamCheck)}`,
      ].join(' '),
      { level: 'debug' },
    )
    const is400StreamUnsupportedError =
      !didFallBackToNonStreaming &&
      !is404StreamCreationError &&
      streamCreationUnsupported

    if (is404StreamCreationError) {
      // 404 is thrown at .withResponse() before streamRequestId is assigned,
      // and CannotRetryError means every retry failed — so grab the failed
      // request's ID from the error header instead.
      const failedRequestId =
        (errorFromRetry.originalError as { request_id?: string }).request_id
      setRecoveryTraceContext(recoveryTraceContext, {
        requestId: failedRequestId,
        streamPhase: 'fallback',
        elapsedMs: Date.now() - start,
        innerCause: formatBoundaryRecoveryCause(errorFromRetry.originalError),
      })
      emitNonStreamingFallbackRecoveryTrace({
        sink: options.onRecoveryTrace,
        traceId: streamCreationTraceId,
        protocol: provider.name,
        model: options.model,
        querySource: options.querySource,
        error: provider.wrapError(errorFromRetry.originalError),
        decisionError: createStreamEndpointNotFoundDecisionError(
          errorFromRetry.originalError,
        ),
        context: recoveryTraceContext,
        foregroundSource: foregroundRecoverySource,
      })
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }


      try {
        // Fall back to non-streaming mode
        const fallback404Bound = provider.bind({
          ...streamingExt,
          retryOptions: {
            ...streamingExt.retryOptions,
            operation: 'non_streaming_fallback',
            traceId: nonStreamingFallbackTraceId,
            recoveryTraceContext,
          },
          onNonStreamingAttempt: (attempt: number, _start: number, tokens: number) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          captureRequest: (params: Record<string, unknown>) => captureAPIRequest(params, options.querySource),
          originatingRequestId: failedRequestId ?? null,
        } satisfies import('./provider.js').ProviderRequestExt)
        if (!fallback404Bound.createNonStreamingFallback) {
          throw new Error('Provider does not support non-streaming fallback')
        }
        const fallback404Gen = fallback404Bound.createNonStreamingFallback({
          model: options.model,
          signal,
          intent: streamIntent,
        })
        let fallback404Result: import('./provider.js').NonStreamingResult
        for (;;) {
          const next = await fallback404Gen.next()
          if (next.done) { fallback404Result = next.value as import('./provider.js').NonStreamingResult; break }
          yield next.value as SystemAPIErrorMessage
        }

        const m: AssistantMessage = {
          message: {
            ...fallback404Result.message,
            content: normalizeContentFromAPI(
              fallback404Result.message.content,
              tools,
              options.agentId,
            ),
          },
          requestId: fallback404Result.requestId ?? streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m

        // Continue to success logging below
      } catch (fallbackError) {
        // Propagate model-fallback signal to query.ts (see comment above).
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        // Fallback also failed, handle as normal error
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        let apiRecovery: AssistantAPIRecovery | undefined
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
          apiRecovery = apiRecoveryFromRetryContext(fallbackError.retryContext)
        }

        // Wrap raw SDK error into neutral LLMAPIError at the provider boundary
        const wrappedError = provider.wrapError(error)

        logAPIError({
          error: wrappedError,
          model: errorModel,
          durationMs: Date.now() - start,
          attempt: attemptNumber,
          clientRequestId,
          llmSpan,
        })

        // Protocol-neutral abort detection via wrapped error type
        if (wrappedError instanceof LLMAbortError) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
          apiRecovery,
        })
        releaseStreamResources()
        return
      }
    } else if (is400StreamUnsupportedError) {
      // 400 with "streaming not supported" message — endpoint cannot handle
      // stream: true at all (e.g. DeepSeek-OCR). Fall back to non-streaming.
      const failedRequestId =
        (errorFromRetry instanceof CannotRetryError
          ? (errorFromRetry.originalError as { request_id?: string }).request_id
          : undefined)
      setRecoveryTraceContext(recoveryTraceContext, {
        requestId: failedRequestId,
        streamPhase: 'fallback',
        elapsedMs: Date.now() - start,
        innerCause: formatBoundaryRecoveryCause(rawErrorForStreamCheck),
      })
      emitNonStreamingFallbackRecoveryTrace({
        sink: options.onRecoveryTrace,
        traceId: streamCreationTraceId,
        protocol: provider.name,
        model: options.model,
        querySource: options.querySource,
        error: provider.wrapError(rawErrorForStreamCheck),
        context: recoveryTraceContext,
        foregroundSource: foregroundRecoverySource,
      })
      logForDebugging(
        'Endpoint reported streaming not supported (400), falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      try {
        const fallbackStreamBound = provider.bind({
          ...streamingExt,
          retryOptions: {
            ...streamingExt.retryOptions,
            operation: 'non_streaming_fallback',
            traceId: streamCreationTraceId,
            recoveryTraceContext,
          },
          onNonStreamingAttempt: (attempt: number, _start: number, tokens: number) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          captureRequest: (params: Record<string, unknown>) => captureAPIRequest(params, options.querySource),
          originatingRequestId: failedRequestId ?? null,
        } satisfies import('./provider.js').ProviderRequestExt)
        if (!fallbackStreamBound.createNonStreamingFallback) {
          throw new Error('Provider does not support non-streaming fallback')
        }
        const fallbackStreamGen = fallbackStreamBound.createNonStreamingFallback({
          model: options.model,
          signal,
          intent: streamIntent,
        })
        let fallbackStreamResult: import('./provider.js').NonStreamingResult
        for (;;) {
          const next = await fallbackStreamGen.next()
          if (next.done) { fallbackStreamResult = next.value as import('./provider.js').NonStreamingResult; break }
          yield next.value as SystemAPIErrorMessage
        }

        const m: AssistantMessage = {
          message: {
            ...fallbackStreamResult.message,
            content: normalizeContentFromAPI(
              fallbackStreamResult.message.content,
              tools,
              options.agentId,
            ),
          },
          requestId: fallbackStreamResult.requestId ?? streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m
      } catch (fallbackError) {
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        let apiRecovery: AssistantAPIRecovery | undefined
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
          apiRecovery = apiRecoveryFromRetryContext(fallbackError.retryContext)
        }

        const wrappedError = provider.wrapError(error)

        logAPIError({
          error: wrappedError,
          model: errorModel,
          durationMs: Date.now() - start,
          attempt: attemptNumber,
          clientRequestId,
          llmSpan,
        })

        if (wrappedError instanceof LLMAbortError) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
          apiRecovery,
        })
        releaseStreamResources()
        return
      }
    } else {
      // Original error handling for non-404 errors
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      let apiRecovery: AssistantAPIRecovery | undefined
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
        apiRecovery = apiRecoveryFromRetryContext(errorFromRetry.retryContext)
      }

      // Wrap raw SDK error into neutral LLMAPIError at the provider boundary
      const wrappedError = provider.wrapError(error)

      logAPIError({
        error: wrappedError,
        model: errorModel,
        durationMs: Date.now() - start,
        attempt: attemptNumber,
        clientRequestId,
        llmSpan,
      })

      // Protocol-neutral abort detection via wrapped error type
      if (wrappedError instanceof LLMAbortError) {
        if (lastStreamConsumptionRetryTrace) {
          emitStreamConsumptionAbortedTrace({
            sink: options.onRecoveryTrace,
            retryTrace: lastStreamConsumptionRetryTrace,
            attempt: streamConsumptionAttempt,
            context: recoveryTraceContext,
            error: wrappedError,
          })
          logForDebugging(
            `[api:stream-orchestrator:abort-terminal-trace] ${streamDebug} consumptionAttempt=${streamConsumptionAttempt} previousReason=${lastStreamConsumptionRetryTrace.reason} previousAction=${lastStreamConsumptionRetryTrace.action}`,
            { level: 'warn' },
          )
          lastStreamConsumptionRetryTrace = undefined
        }
        releaseStreamResources()
        return
      }

      yield getAssistantMessageFromError(wrappedError, errorModel, {
        messages,
        messagesForAPI,
        apiRecovery,
      })
      releaseStreamResources()
      return
    }
    } finally {
    stopSessionActivity('api_call')
    // Must be in the finally block: if the generator is terminated early
    // via .return() (e.g. consumer breaks out of for-await-of, or query.ts
    // encounters an abort), code after the try/finally never executes.
    // Without this, the Response object's native TLS/socket buffers leak
    // until the generator itself is GC'd (see GH #32920).
    releaseStreamResources()

    // Non-streaming fallback cost: the streaming path tracks cost in the
    // message_delta handler before any yield. Fallback pushes to newMessages
    // then yields, so tracking must be here to survive .return() at the yield.
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      // Use full NonNullableUsage for cost calculation (matches v0.1.0 behavior)
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage as NonNullableUsage)
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage as NonNullableUsage,
        options.model,
      )
    }
  }
    break streamConsumptionRetry
  }

  // Track the last requestId for the main conversation chain so shutdown
  // can send a cache eviction hint to inference. Exclude backgrounded
  // sessions (Ctrl+B) which share the repl_main_thread querySource but
  // run inside an agent context — they are independent conversation chains
  // whose cache should not be evicted when the foreground session clears.
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  logAPISuccessAndDuration({
    model: newMessages[0]?.message.model ?? options.model,
    usage,
    start,
    startIncludingRetries,
    attempt: attemptNumber,
    ttftMs,
    costUSD,
    // Pass newMessages for beta tracing - extraction happens in logging.ts
    // only when beta tracing is enabled
    newMessages,
    llmSpan,
    requestSetupMs: start - startIncludingRetries,
    attemptStartTimes,
  })

  // Defensive: also release on normal completion (no-op if finally already ran).
  releaseStreamResources()
}

/**
 * Cleans up stream resources to prevent memory leaks.
 * @internal Exported for testing
 */
export function cleanupStream(
  stream: { controller: { signal: AbortSignal; abort(): void } } | undefined,
): void {
  if (!stream) {
    return
  }
  try {
    // Abort the stream via its controller if not already aborted
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // Ignore - stream may already be closed
  }
}

/**
 * Updates usage statistics with new values from streaming API events.
 * Note: Anthropic's streaming API provides cumulative usage totals, not incremental deltas.
 * Each event contains the complete usage up to that point in the stream.
 *
 * Input-related tokens (input_tokens, cache_creation_input_tokens, cache_read_input_tokens)
 * are typically set in message_start and remain constant. message_delta events may send
 * explicit 0 values for these fields, which should not overwrite the values from message_start.
 * We only update these fields if they have a non-null, non-zero value.
 */
// Re-exported from usageUtils.ts for backwards compatibility
export { updateUsage, accumulateUsage } from './usageUtils.js'


// Exported for testing cache_reference placement constraints
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  _useCachedMC = false,
  _newCacheEdits?: unknown,
  _pinnedEdits?: unknown[],
  skipCacheWrite = false,
): MessageParam[] {

  // Exactly one message-level cache_control marker per request.
  // For fire-and-forget forks (skipCacheWrite) we shift the marker to the
  // second-to-last message: that's the last shared-prefix point.
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  return messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })
}

export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    querySource?: QuerySource
  },
): TextBlockParam[] {
  // IMPORTANT: Do not add any more blocks for caching or you will get a 400
  return splitSysPromptPrefix(systemPrompt).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}

type AuxiliaryTaskQueryOptions = Omit<
  Options,
  'model' | 'getToolPermissionContext'
> & {
  auxiliaryTask?: AuxiliaryTaskId
}

export async function queryAuxiliaryTask({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: import('./streamTypes.js').NeutralOutputFormat
  signal: AbortSignal
  options: AuxiliaryTaskQueryOptions
}): Promise<AssistantMessage> {
  const { auxiliaryTask = 'sessionTitle', ...queryOptions } = options
  const taskPolicy = getAuxiliaryTaskPolicy(auxiliaryTask)
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const result = await runAuxiliaryTask<AssistantMessage | null>({
        task: auxiliaryTask,
        operation: 'inference',
        querySource: queryOptions.querySource,
        signal,
        sink: queryOptions.onRecoveryTrace,
        execute: attempt => {
          const messages = [
            createUserMessage({
              content: userPrompt,
            }),
          ]

          return queryModelWithoutStreaming({
            messages,
            systemPrompt,
            thinkingConfig: { type: 'disabled' },
            tools: [],
            signal,
            options: {
              ...queryOptions,
              ...auxiliaryAttemptQueryOptions(
                attempt,
                queryOptions.querySource,
              ),
              maxOutputTokensOverride:
                taskPolicy.maxOutputTokens ?? queryOptions.maxOutputTokensOverride,
              enablePromptCaching: queryOptions.enablePromptCaching ?? false,
              outputFormat,
              async getToolPermissionContext() {
                return getEmptyToolPermissionContext()
              },
            },
          })
        },
        onFailure: auxiliaryFailureAssistantMessage,
      })
      return result ? [result] : []
    },
  )
  // Auxiliary task queries use the non-streaming path, so the VCR result
  // contains at most one assistant response.
  const message = result[0] as AssistantMessage | undefined
  if (!message) {
    throw new Error(`Auxiliary task "${auxiliaryTask}" returned no result`)
  }
  return message
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * Query a specific model through the Axiomate infrastructure.
 * This goes through the full query pipeline including proper authentication,
 * betas, and headers - unlike direct API calls.
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: import('./streamTypes.js').NeutralOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}

// Non-streaming requests have a 10min max per the docs:
// Long request error handling
// The SDK's 21333-token cap is derived from 10min × 128k tokens/hour, but we
// bypass it by setting a client-level timeout, so we can cap higher.
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * Adjusts thinking budget when max_tokens is capped for non-streaming fallback.
 * Ensures the API constraint: max_tokens > thinking.budget_tokens
 *
 * @param params - The parameters that will be sent to the API
 * @param maxTokensCap - The maximum allowed tokens (MAX_NON_STREAMING_TOKENS)
 * @returns Adjusted parameters with thinking budget capped if needed
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: { type: string; budget_tokens?: number }
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // Adjust thinking budget if it would exceed capped max_tokens
  // to maintain the constraint: max_tokens > thinking.budget_tokens
  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // Must be at least 1 less than max_tokens
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

export function getMaxOutputTokensForModel(model: string): number {
  const defaultTokens = getModelMaxOutputTokens(model)
  // env var is an intentional escape hatch; no provider-specific upper bound.
  const result = validateBoundedIntEnvVar(
    'AXIOMATE_CODE_MAX_OUTPUT_TOKENS',
    process.env.AXIOMATE_CODE_MAX_OUTPUT_TOKENS,
    defaultTokens,
    Number.MAX_SAFE_INTEGER,
  )
  return result.effective
}
