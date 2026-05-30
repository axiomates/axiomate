import type { ErrorFailoverReason } from './errorClassifier.js'
import type { RecoveryAction } from './recoveryAction.js'
import type { RecoveryIntent } from './recoveryIntent.js'
import type {
  RecoveryStreamPhase,
  RecoveryTraceEvent,
  RecoveryTraceOperation,
  RecoveryTraceOutcome,
} from './recoveryTrace.js'
import type { RecoveryDecisionRepeatPolicy, RecoveryProtocol } from './recoverySession.js'

export const MAX_API_RECOVERY_DIAGNOSTICS = 200

const SAFE_HEADER_NAMES = new Set([
  'retry-after',
  'x-request-id',
  'request-id',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
])

export interface SafeApiRecoveryTraceEvent {
  timestamp: string
  sequence?: number
  traceId?: string
  protocol: RecoveryProtocol
  model: string
  attempt: number
  maxAttempts: number
  reason: ErrorFailoverReason
  intent: RecoveryIntent
  action: RecoveryAction
  outcome: RecoveryTraceOutcome
  ruleId?: string
  repeatPolicy?: RecoveryDecisionRepeatPolicy
  statusCode?: number
  retryable: boolean
  shouldCompress: boolean
  shouldFallback: boolean
  delayMs?: number
  mutation?: string[]
  requestId?: string
  ttfbMs?: number
  elapsedMs?: number
  bytesReceived?: number
  streamPhase?: RecoveryStreamPhase
  timeoutKind?: RecoveryTraceEvent['timeoutKind']
  timeoutMs?: number
  innerCause?: string
  safeHeaders?: Record<string, string>
  operation?: RecoveryTraceOperation
  querySource?: string
  recommendedIntent?: RecoveryIntent
  recommendedAction?: RecoveryAction
  observationId?: number
  decisionId?: number
  previousReason?: ErrorFailoverReason
  previousIntent?: RecoveryIntent
  previousAction?: RecoveryAction
  isFirstFailure?: boolean
  isFirstFailureForReason?: boolean
  consecutiveSameReason?: number
  final?: boolean
  routeId?: string
  fromModel?: string
  toModel?: string
  chainIndex?: number
  policyGate?: {
    allowActions?: string[]
    switchModelOn?: string[]
    actionAllowed?: boolean
    reasonAllowed?: boolean
  }
  auxiliaryTask?: string
}

const events: SafeApiRecoveryTraceEvent[] = []

export function appendApiRecoveryTrace(event: RecoveryTraceEvent): void {
  events.push(toSafeApiRecoveryTraceEvent(event))
  if (events.length > MAX_API_RECOVERY_DIAGNOSTICS) {
    events.splice(0, events.length - MAX_API_RECOVERY_DIAGNOSTICS)
  }
}

export function listApiRecoveryTraces(): SafeApiRecoveryTraceEvent[] {
  return events.map(cloneSafeApiRecoveryTraceEvent).reverse()
}

export function clearApiRecoveryTraces(): void {
  events.length = 0
}

export function toSafeApiRecoveryTraceEvent(
  event: RecoveryTraceEvent,
): SafeApiRecoveryTraceEvent {
  return dropUndefined({
    timestamp: event.timestamp,
    sequence: event.sequence,
    traceId: truncate(event.traceId, 120),
    protocol: event.protocol,
    model: truncate(event.model, 160),
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    reason: event.reason,
    intent: event.intent,
    action: event.action,
    outcome: event.outcome,
    ruleId: truncate(event.ruleId, 160),
    repeatPolicy: event.repeatPolicy,
    statusCode: event.statusCode,
    retryable: event.retryable,
    shouldCompress: event.shouldCompress,
    shouldFallback: event.shouldFallback,
    delayMs: event.delayMs,
    mutation: sanitizeStringArray(event.mutation),
    requestId: truncate(event.requestId, 160),
    ttfbMs: event.ttfbMs,
    elapsedMs: event.elapsedMs,
    bytesReceived: event.bytesReceived,
    streamPhase: event.streamPhase,
    timeoutKind: event.timeoutKind,
    timeoutMs: event.timeoutMs,
    innerCause: sanitizeInnerCause(event.innerCause),
    safeHeaders: sanitizeSafeHeaders(event.safeHeaders),
    operation: event.operation,
    querySource: truncate(event.querySource, 80),
    recommendedIntent: event.recommendedIntent,
    recommendedAction: event.recommendedAction,
    observationId: event.observationId,
    decisionId: event.decisionId,
    previousReason: event.previousReason,
    previousIntent: event.previousIntent,
    previousAction: event.previousAction,
    isFirstFailure: event.isFirstFailure,
    isFirstFailureForReason: event.isFirstFailureForReason,
    consecutiveSameReason: event.consecutiveSameReason,
    final: event.final,
    routeId: truncate(event.routeId, 120),
    fromModel: truncate(event.fromModel, 160),
    toModel: truncate(event.toModel, 160),
    chainIndex: event.chainIndex,
    policyGate: sanitizePolicyGate(event.policyGate),
    auxiliaryTask: truncate(event.auxiliaryTask, 80),
  })
}

function sanitizeStringArray(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined
  return values.map(value => truncate(value, 120)).filter(Boolean) as string[]
}

function sanitizeSafeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined
  const safe: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (!SAFE_HEADER_NAMES.has(name)) continue
    if (typeof rawValue !== 'string' || rawValue.length === 0) continue
    safe[name] = truncate(rawValue, 160)
  }
  return Object.keys(safe).length > 0 ? safe : undefined
}

function sanitizePolicyGate(
  policyGate: RecoveryTraceEvent['policyGate'],
): SafeApiRecoveryTraceEvent['policyGate'] | undefined {
  if (!policyGate) return undefined
  return dropUndefined({
    allowActions: sanitizeStringArray(policyGate.allowActions),
    switchModelOn: sanitizeStringArray(policyGate.switchModelOn),
    actionAllowed: policyGate.actionAllowed,
    reasonAllowed: policyGate.reasonAllowed,
  })
}

function sanitizeInnerCause(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return undefined
  }
  const [prefix, ...rest] = normalized.split(':')
  const errorName = isLikelyErrorName(prefix) ? prefix : 'Error'
  const message = isLikelyErrorName(prefix)
    ? rest.join(':').trim()
    : normalized
  if (containsSensitiveText(message)) {
    return `${errorName}: [redacted]`
  }
  const redacted = redactSensitiveText(message)
  return `${errorName}: ${redacted}`.slice(0, 240)
}

function isLikelyErrorName(value: string | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*(Error)?$/.test(value)
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:bearer|token|api[-_ ]?key)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
}

function containsSensitiveText(value: string): boolean {
  return /\b(?:bearer|authorization|cookie|set-cookie|api[-_ ]?key|sk-[A-Za-z0-9._-]{8,}|raw prompt|prompt text)\b/i.test(value)
}

function cloneSafeApiRecoveryTraceEvent(
  event: SafeApiRecoveryTraceEvent,
): SafeApiRecoveryTraceEvent {
  return {
    ...event,
    mutation: event.mutation ? [...event.mutation] : undefined,
    safeHeaders: event.safeHeaders ? { ...event.safeHeaders } : undefined,
    policyGate: event.policyGate
      ? {
          ...event.policyGate,
          allowActions: event.policyGate.allowActions
            ? [...event.policyGate.allowActions]
            : undefined,
          switchModelOn: event.policyGate.switchModelOn
            ? [...event.policyGate.switchModelOn]
            : undefined,
        }
      : undefined,
  }
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length <= max) return value
  return value.slice(0, max)
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key]
    }
  }
  return value
}
