import type { QuerySource } from '../../constants/querySource.js'
import { sleep } from '../../utils/sleep.js'
import {
  resolveApiTimeoutPolicy,
  withApiTimeout,
} from './apiTimeoutPolicy.js'
import { classifyError } from './errorClassifier.js'
import type { LLMProvider } from './provider.js'
import {
  recoveryTracePolicyGateFromAvailability,
  resolveModelFallbackAvailability,
  type ModelFallbackAvailability,
} from './recoveryFallback.js'
import { decideRecovery } from './recoveryDecision.js'
import { resolveRecoveryAction } from './recoveryAction.js'
import { intentForAction } from './recoveryIntent.js'
import {
  createRecoveryTraceId,
  emitRecoveryTrace,
  type RecoveryTraceOperation,
  type RecoveryTraceSink,
} from './recoveryTrace.js'
import {
  RecoverySession,
  normalizeRecoveryProtocol,
  type RecoveryDecision,
  type RecoveryObservation,
  type RecoveryProtocol,
} from './recoverySession.js'
import { safeRecoveryTraceHeaders } from './recoveryTraceHeaders.js'
import { LLMAbortError } from './streamTypes.js'
import {
  FallbackTriggeredError,
  getRecoveryDelay,
  type RetryContext,
} from './withRetry.js'

// Foreground classification for auxiliary calls routed ONLY by querySource —
// i.e. callers that do NOT pass an auxiliaryTask (e.g. sideQuestion.ts). When
// an auxiliaryTask IS present, the task/profile branches in
// resolveAuxiliaryRecoveryBudget decide first and this set is never consulted.
// (That is why 'permission_explainer' is intentionally absent: its only caller
// passes auxiliaryTask:'permissionExplainer', so it resolves via the fast-task
// branch, not here — listing it here would be dead.) Distinct from
// FOREGROUND_RETRY_SOURCES in withRetry.ts, which classifies the MAIN request
// path; keep the two in sync deliberately, they are not interchangeable.
const FOREGROUND_AUXILIARY_SOURCES = new Set<string>([
  'side_question',
  'verification_agent',
])

const VALIDATION_AUXILIARY_SOURCES = new Set<string>(['model_validation'])

const QUALITY_AUXILIARY_PROFILES = new Set<string>([
  'auxiliary-quality',
  'auxiliary-judge',
])

const FAST_AUXILIARY_PROFILES = new Set<string>(['auxiliary-fast'])

const VALIDATION_AUXILIARY_TASKS = new Set<string>(['verifyConnection'])
const BACKGROUND_AUXILIARY_TASKS = new Set<string>(['promptSuggestion'])

export interface AuxiliaryRecoveryOptions {
  provider: Pick<LLMProvider, 'name' | 'wrapError'>
  model: string
  operation: RecoveryTraceOperation
  querySource?: QuerySource | string
  signal?: AbortSignal
  sink?: RecoveryTraceSink
  fallbackModel?: string
  routeId?: string
  auxiliaryTask?: string
  chainIndex?: number
  recoveryProfile?: string
  policyGate?: {
    allowActions?: string[]
    switchModelOn?: string[]
    actionAllowed?: boolean
    reasonAllowed?: boolean
  }
}

export type AuxiliaryRecoveryBudget = {
  maxRecoveryRetries: number
  foregroundSource: boolean
  reason:
    | 'background-direct'
    | 'foreground-side-query'
    | 'validation'
    | 'task-fast'
    | 'task-quality'
    | 'task-default'
}

export async function withAuxiliaryRecovery<T>(
  options: AuxiliaryRecoveryOptions,
  operation: (attempt: number, context: RetryContext) => Promise<T>,
): Promise<T> {
  const budget = resolveAuxiliaryRecoveryBudget(options)
  const protocol = normalizeRecoveryProtocol(options.provider.name)
  const session = new RecoverySession({ protocol })
  const traceId = createRecoveryTraceId(`api-${options.operation}-aux-recovery`)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
  }
  const timeoutPolicy = resolveApiTimeoutPolicy({
    protocol,
    operation: options.operation,
    querySource: options.querySource,
  })
  let lastError: unknown

  for (
    let attempt = 1;
    attempt <= budget.maxRecoveryRetries + 1;
    attempt++
  ) {
    if (options.signal?.aborted) {
      throw new LLMAbortError()
    }

    try {
      const result = await withApiTimeout(timeoutPolicy, options.signal, signal =>
        operation(attempt, { ...retryContext, signal }),
      )
      emitAuxiliaryRecoveredTraceIfNeeded({
        options,
        protocol,
        traceId,
        session,
      })
      return result
    } catch (error) {
      lastError = error
      const wrapped = options.provider.wrapError(error)
      const classified = classifyError(wrapped, {
        provider: protocol,
        model: options.model,
      })
      const fallbackAvailability = resolveModelFallbackAvailability({
        currentModel: options.model,
        candidateModel: options.fallbackModel,
        classified,
        policy: options.policyGate,
      })
      const observation = session.observeFailure({
        attempt,
        maxAttempts: budget.maxRecoveryRetries + 1,
        model: retryContext.model,
        classified,
      })
      const decision = decideRecovery(observation, {
        fallbackAvailability,
        canFallback: fallbackAvailability.available,
        foregroundSource: budget.foregroundSource,
        recoveryBudgetExhausted: attempt > budget.maxRecoveryRetries,
        deferStreamEndpoint404Fallback: false,
        willRefreshClient: false,
        retryContext,
        history: session.history,
        error: wrapped,
        delayMsForRetryable: () => getRecoveryDelay(attempt, classified),
      })
      const previousDecision = session.history.previousDecision
      const recordedDecision = session.recordDecision(decision)

      emitAuxiliaryDecisionTrace({
        options,
        protocol,
        observation,
        decision: recordedDecision,
        previousDecision,
        error,
        wrapped,
        traceId,
        fallbackAvailability,
      })

      if (recordedDecision.contextPatch) {
        Object.assign(retryContext, recordedDecision.contextPatch)
      }

      switch (recordedDecision.disposition) {
        case 'abort':
        case 'throw_original':
          throw wrapped
        case 'fallback_model':
          throw new FallbackTriggeredError(
            options.model,
            options.fallbackModel!,
          )
        case 'delegate':
        case 'fail':
          throw wrapped
        case 'retry':
          break
      }

      if (recordedDecision.delayMs !== undefined) {
        await sleep(recordedDecision.delayMs, options.signal, {
          abortError: () => new LLMAbortError(),
        })
      }
    }
  }

  throw options.provider.wrapError(lastError)
}

function emitAuxiliaryRecoveredTraceIfNeeded(input: {
  options: AuxiliaryRecoveryOptions
  protocol: RecoveryProtocol
  traceId: string
  session: RecoverySession
}): void {
  const previousObservation = input.session.observations.at(-1)
  const previousDecision = input.session.decisions.at(-1)
  if (!previousObservation || !previousDecision) {
    return
  }

  emitRecoveryTrace(input.options.sink, {
    traceId: input.traceId,
    protocol: input.protocol,
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
    operation: input.options.operation,
    querySource: input.options.querySource,
    routeId: input.options.routeId,
    fromModel: input.options.model,
    toModel: input.options.fallbackModel,
    chainIndex: input.options.chainIndex,
    policyGate: recoveryTracePolicyGateFromAvailability(
      resolveModelFallbackAvailability({
        currentModel: input.options.model,
        candidateModel: input.options.fallbackModel,
        classified: previousObservation.classified,
        policy: input.options.policyGate,
      }),
    ),
    auxiliaryTask: input.options.auxiliaryTask,
    foregroundSource: input.session.decisions.length
      ? resolveAuxiliaryRecoveryBudget(input.options).foregroundSource
      : undefined,
    recommendedIntent: previousDecision.intent,
    recommendedAction: previousDecision.action,
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

export function resolveAuxiliaryRecoveryBudget(
  options: Pick<
    AuxiliaryRecoveryOptions,
    'querySource' | 'auxiliaryTask' | 'recoveryProfile'
  >,
): AuxiliaryRecoveryBudget {
  if (
    (options.querySource !== undefined &&
      VALIDATION_AUXILIARY_SOURCES.has(options.querySource)) ||
    (options.auxiliaryTask !== undefined &&
      VALIDATION_AUXILIARY_TASKS.has(options.auxiliaryTask))
  ) {
    return {
      maxRecoveryRetries: 1,
      foregroundSource: true,
      reason: 'validation',
    }
  }

  if (
    options.auxiliaryTask !== undefined &&
    BACKGROUND_AUXILIARY_TASKS.has(options.auxiliaryTask)
  ) {
    return {
      maxRecoveryRetries: 0,
      foregroundSource: false,
      reason: 'background-direct',
    }
  }

  if (options.auxiliaryTask !== undefined) {
    if (
      options.recoveryProfile !== undefined &&
      QUALITY_AUXILIARY_PROFILES.has(options.recoveryProfile)
    ) {
      return {
        maxRecoveryRetries: 2,
        foregroundSource: true,
        reason: 'task-quality',
      }
    }
    if (
      options.recoveryProfile !== undefined &&
      FAST_AUXILIARY_PROFILES.has(options.recoveryProfile)
    ) {
      return {
        maxRecoveryRetries: 1,
        foregroundSource: true,
        reason: 'task-fast',
      }
    }
    return {
      maxRecoveryRetries: 1,
      foregroundSource: true,
      reason: 'task-default',
    }
  }

  if (
    options.querySource !== undefined &&
    FOREGROUND_AUXILIARY_SOURCES.has(options.querySource)
  ) {
    return {
      maxRecoveryRetries: 2,
      foregroundSource: true,
      reason: 'foreground-side-query',
    }
  }

  return {
    maxRecoveryRetries: 0,
    foregroundSource: false,
    reason: 'background-direct',
  }
}

function formatAuxiliaryRecoveryCause(error: unknown): string | undefined {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 240)
  }
  if (typeof error === 'string') {
    return error.slice(0, 240)
  }
  return undefined
}

function emitAuxiliaryDecisionTrace(input: {
  options: AuxiliaryRecoveryOptions
  protocol: RecoveryProtocol
  observation: RecoveryObservation
  decision: RecoveryDecision
  previousDecision: RecoveryDecision | undefined
  error: unknown
  wrapped: ReturnType<LLMProvider['wrapError']>
  traceId: string
  fallbackAvailability: ModelFallbackAvailability
}): void {
  const recommendedAction = resolveRecoveryAction(input.observation.classified, {
    canFallback: input.fallbackAvailability.available,
  })
  const recommendedIntent = intentForAction(
    recommendedAction,
    input.observation.classified,
  )
  const timeoutPolicy =
    input.observation.reason === 'timeout'
      ? resolveApiTimeoutPolicy({
          protocol: input.protocol,
          operation: input.options.operation,
          querySource: input.options.querySource,
        })
      : undefined

  emitRecoveryTrace(input.options.sink, {
    traceId: input.traceId,
    protocol: input.protocol,
    model: input.observation.model,
    attempt: input.observation.attempt,
    maxAttempts: input.observation.maxAttempts,
    reason: input.observation.reason,
    intent: input.decision.intent,
    action: input.decision.action,
    outcome: input.decision.outcome,
    ruleId: input.decision.ruleId,
    repeatPolicy: input.decision.repeatPolicy,
    statusCode: input.observation.statusCode,
    retryable: input.observation.retryable,
    shouldCompress: input.observation.shouldCompress,
    shouldFallback: input.observation.shouldFallback,
    delayMs: input.decision.delayMs,
    mutation: input.decision.mutation,
    timeoutKind: timeoutPolicy?.timeoutKind,
    timeoutMs: timeoutPolicy?.timeoutMs,
    requestId: input.wrapped.request_id,
    innerCause: formatAuxiliaryRecoveryCause(input.error),
    safeHeaders: safeRecoveryTraceHeaders(input.wrapped.headers),
    operation: input.options.operation,
    querySource: input.options.querySource,
    routeId: input.options.routeId,
    fromModel: input.options.model,
    toModel: input.options.fallbackModel,
    chainIndex: input.options.chainIndex,
    policyGate: recoveryTracePolicyGateFromAvailability(
      input.fallbackAvailability,
    ),
    auxiliaryTask: input.options.auxiliaryTask,
    foregroundSource: resolveAuxiliaryRecoveryBudget(input.options)
      .foregroundSource,
    recommendedIntent,
    recommendedAction,
    observationId: input.observation.id,
    decisionId: input.decision.id,
    previousReason: input.observation.previousReason,
    previousIntent: input.previousDecision?.intent,
    previousAction: input.previousDecision?.action,
    isFirstFailure: input.observation.isFirstFailure,
    isFirstFailureForReason: input.observation.isFirstFailureForReason,
    consecutiveSameReason: input.observation.consecutiveSameReason,
    final: input.decision.disposition !== 'retry',
  })
}
