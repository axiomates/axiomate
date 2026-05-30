import type { ErrorFailoverReason } from './errorClassifier.js'
import type { RecoveryAction } from './recoveryAction.js'
import type { RecoveryIntent } from './recoveryIntent.js'
import type { RecoveryTraceOutcome } from './recoveryTrace.js'
import type { SafeApiRecoveryTraceEvent } from './apiRecoveryDiagnostics.js'

export type ApiFailureCardSeverity = 'info' | 'warning' | 'error'

export type ApiFailureCardStatus =
  | 'recovered'
  | 'switched_model'
  | 'switched_request_mode'
  | 'adapted_request'
  | 'adaptation_failed'
  | 'delegated_recovery'
  | 'blocked_by_policy'
  | 'salvaged'
  | 'exhausted'
  | 'aborted'
  | 'failed'
  | 'retrying'

export interface ApiFailureCardTimelineItem {
  timestamp: string
  attempt: number
  maxAttempts: number
  model: string
  reason: ErrorFailoverReason
  action: RecoveryAction
  intent: RecoveryIntent
  outcome: RecoveryTraceOutcome
  statusCode?: number
  mutation?: string[]
  delayMs?: number
  fromModel?: string
  toModel?: string
  final?: boolean
}

export interface ApiFailureCard {
  id: string
  severity: ApiFailureCardSeverity
  status: ApiFailureCardStatus
  title: string
  scope: string
  impact: string
  modelPath: string
  observed: string
  summary: string
  stoppedReason?: string
  nextAction: string
  timeline: ApiFailureCardTimelineItem[]
  advanced: {
    traceId?: string
    protocol?: string
    operation?: string
    routeId?: string
    auxiliaryTask?: string
    ruleIds: string[]
    requestIds: string[]
    timeout?: string
    elapsed?: string
    innerCause?: string
    safeHeaders?: Record<string, string>
    policyGate?: string
  }
}

interface TraceGroup {
  key: string
  events: SafeApiRecoveryTraceEvent[]
}

export function projectApiFailureCards(
  eventsNewestFirst: readonly SafeApiRecoveryTraceEvent[],
  options: { limit?: number } = {},
): ApiFailureCard[] {
  const groups = groupTraceEvents(eventsNewestFirst)
  const cards = groups.map(projectGroup)
  return cards.slice(0, options.limit ?? 5)
}

function groupTraceEvents(
  eventsNewestFirst: readonly SafeApiRecoveryTraceEvent[],
): TraceGroup[] {
  const groups = new Map<string, SafeApiRecoveryTraceEvent[]>()

  for (const event of eventsNewestFirst) {
    const key = groupingKey(event)
    const group = groups.get(key)
    if (group) {
      group.push(event)
    } else {
      groups.set(key, [event])
    }
  }

  return [...groups.entries()]
    .map(([key, events]) => ({
      key,
      events: [...events].sort(compareTraceEventsAscending),
    }))
    .sort((a, b) => latestMs(b.events) - latestMs(a.events))
}

function groupingKey(event: SafeApiRecoveryTraceEvent): string {
  if (event.traceId && event.traceId.length > 0) {
    return `trace:${event.traceId}`
  }
  const minuteBucket = Math.floor(Date.parse(event.timestamp) / 60_000)
  return [
    'fallback',
    event.operation ?? 'unknown-operation',
    event.routeId ?? event.auxiliaryTask ?? event.querySource ?? 'unknown-scope',
    event.protocol,
    event.model,
    Number.isFinite(minuteBucket) ? minuteBucket : 'unknown-time',
  ].join(':')
}

function projectGroup(group: TraceGroup): ApiFailureCard {
  const events = group.events
  const latest = events[events.length - 1]!
  const status = classifyStatus(events)
  const severity = severityForStatus(status)
  const scope = scopeFor(latest)
  const modelPath = modelPathFor(events)
  const observed = observedFor(latest)
  const timeline = events.map(event => ({
    timestamp: event.timestamp,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    model: event.model,
    reason: event.reason,
    action: event.action,
    intent: event.intent,
    outcome: event.outcome,
    statusCode: event.statusCode,
    mutation: event.mutation,
    delayMs: event.delayMs,
    fromModel: event.fromModel,
    toModel: event.toModel,
    final: event.final,
  }))

  return {
    id: group.key,
    severity,
    status,
    title: titleFor(status, latest),
    scope,
    impact: impactFor(latest),
    modelPath,
    observed,
    summary: summaryFor(status, latest, events),
    stoppedReason: stoppedReasonFor(status, latest),
    nextAction: nextActionFor(latest),
    timeline,
    advanced: {
      traceId: latest.traceId,
      protocol: latest.protocol,
      operation: latest.operation,
      routeId: latest.routeId,
      auxiliaryTask: latest.auxiliaryTask,
      ruleIds: unique(events.map(event => event.ruleId)),
      requestIds: unique(events.map(event => event.requestId)),
      timeout: timeoutFor(latest),
      elapsed: elapsedFor(latest),
      innerCause: latest.innerCause,
      safeHeaders: latest.safeHeaders,
      policyGate: policyGateFor(latest),
    },
  }
}

function classifyStatus(events: readonly SafeApiRecoveryTraceEvent[]): ApiFailureCardStatus {
  const latest = events[events.length - 1]!
  if (latest.outcome === 'recovered') return 'recovered'
  if (latest.outcome === 'aborted' || latest.action === 'abort') return 'aborted'
  if (latest.outcome === 'salvaged') return 'salvaged'
  if (isModelFallbackBlockedByPolicy(latest)) return 'blocked_by_policy'
  if (latest.action === 'non_streaming_fallback') {
    return 'switched_request_mode'
  }
  if (isModelSwitchEvent(latest)) {
    return 'switched_model'
  }
  if (isDelegatedRecovery(latest)) {
    return 'delegated_recovery'
  }
  if (latest.outcome === 'failing') {
    if (events.some(event => isRequestShapeAdaptation(event.action))) {
      return 'adaptation_failed'
    }
    return latest.intent === 'fail_recovery_exhausted' ? 'exhausted' : 'failed'
  }
  if (events.some(event => isRequestShapeAdaptation(event.action))) {
    return 'adapted_request'
  }
  if (latest.outcome === 'retrying') return 'retrying'
  return latest.final ? 'failed' : 'retrying'
}

function severityForStatus(status: ApiFailureCardStatus): ApiFailureCardSeverity {
  if (
    status === 'failed' ||
    status === 'exhausted' ||
    status === 'aborted' ||
    status === 'adaptation_failed' ||
    status === 'blocked_by_policy'
  ) {
    return 'error'
  }
  if (status === 'adapted_request' || status === 'salvaged') {
    return 'info'
  }
  return 'warning'
}

function titleFor(
  status: ApiFailureCardStatus,
  latest: SafeApiRecoveryTraceEvent,
): string {
  switch (status) {
    case 'switched_model':
      return 'API request switched model'
    case 'switched_request_mode':
      return 'API request switched to non-streaming'
    case 'adapted_request':
      return 'API request adapted for retry'
    case 'adaptation_failed':
      return 'API request adaptation failed'
    case 'delegated_recovery':
      return latest.action === 'request_compaction'
        ? 'API recovery delegated to compaction'
        : 'API recovery delegated'
    case 'blocked_by_policy':
      return 'API fallback blocked by route policy'
    case 'salvaged':
      return 'API stream recovered from partial output'
    case 'recovered':
      return 'API request recovered'
    case 'exhausted':
      return 'API request exhausted retries'
    case 'aborted':
      return 'API request was aborted'
    case 'retrying':
      return 'API request is retrying'
    case 'failed':
      return latest.reason === 'auth' || latest.reason === 'auth_permanent'
        ? 'API authentication failed'
        : 'API request failed'
  }
}

function summaryFor(
  status: ApiFailureCardStatus,
  latest: SafeApiRecoveryTraceEvent,
  events: readonly SafeApiRecoveryTraceEvent[],
): string {
  const attempts = events.length === 1 ? '1 event' : `${events.length} events`
  if (status === 'switched_model' && latest.toModel) {
    return `${attempts}; switched ${latest.fromModel ?? latest.model} -> ${latest.toModel}.`
  }
  if (status === 'switched_request_mode') {
    return `${attempts}; switched request mode to non-streaming fallback.`
  }
  if (status === 'blocked_by_policy') {
    return `${attempts}; route policy blocked model fallback.`
  }
  if (status === 'delegated_recovery') {
    return `${attempts}; delegated recovery to ${latest.action}.`
  }
  if (status === 'recovered') {
    return `${attempts}; recovered after ${latest.action}.`
  }
  if (status === 'adaptation_failed') {
    return `${attempts}; adapted request but latest failure was ${latest.reason}.`
  }
  if (status === 'adapted_request') {
    const mutations = unique(events.flatMap(event => event.mutation ?? []))
    if (mutations.length > 0) {
      return `${attempts}; applied ${mutations.join(', ')}.`
    }
  }
  if (latest.mutation && latest.mutation.length > 0) {
    return `${attempts}; applied ${latest.mutation.join(', ')}.`
  }
  return `${attempts}; latest action ${latest.action}.`
}

function scopeFor(event: SafeApiRecoveryTraceEvent): string {
  if (event.auxiliaryTask) return `auxiliary:${event.auxiliaryTask}`
  if (event.routeId) return `route:${event.routeId}`
  if (event.querySource) return event.querySource
  return event.operation ?? 'api'
}

function impactFor(event: SafeApiRecoveryTraceEvent): string {
  switch (event.operation) {
    case 'stream':
      return 'main response streaming'
    case 'non_streaming_fallback':
      return 'non-streaming fallback'
    case 'side_query':
      return 'side query'
    case 'inference':
      return 'auxiliary inference'
    case 'verify_connection':
      return 'model validation'
    case 'count_tokens':
      return 'token counting'
    default:
      return event.auxiliaryTask ? 'auxiliary model call' : 'API request'
  }
}

function modelPathFor(events: readonly SafeApiRecoveryTraceEvent[]): string {
  const path: string[] = []
  for (const event of events) {
    const current = event.fromModel ?? event.model
    if (current && path[path.length - 1] !== current) path.push(current)
    if (
      isModelSwitchEvent(event) &&
      event.toModel &&
      path[path.length - 1] !== event.toModel
    ) {
      path.push(event.toModel)
    }
  }
  return path.join(' -> ')
}

function observedFor(event: SafeApiRecoveryTraceEvent): string {
  const parts: string[] = [observedReasonFor(event)]
  if (event.statusCode !== undefined) parts.push(`HTTP ${event.statusCode}`)
  if (event.streamPhase) parts.push(`phase ${event.streamPhase}`)
  const cause = compactCause(event.innerCause)
  if (cause) parts.push(cause)
  const requestId = event.requestId ?? event.safeHeaders?.['x-request-id'] ?? event.safeHeaders?.['request-id']
  if (requestId) parts.push(`request ${requestId}`)
  return parts.join(' · ')
}

function observedReasonFor(event: SafeApiRecoveryTraceEvent): string {
  if (event.reason !== 'unknown') {
    return event.reason
  }
  if (event.statusCode !== undefined) {
    return 'unclassified provider error'
  }
  if (event.streamPhase) {
    return 'unclassified stream error'
  }
  return 'unclassified API error'
}

function compactCause(cause: string | undefined): string | undefined {
  if (!cause) {
    return undefined
  }
  return cause.replace(/\s+/g, ' ').slice(0, 120)
}

function stoppedReasonFor(
  status: ApiFailureCardStatus,
  event: SafeApiRecoveryTraceEvent,
): string | undefined {
  if (status === 'retrying') return undefined
  if (status === 'delegated_recovery') return undefined
  if (status === 'recovered') return undefined
  if (status === 'adapted_request') return undefined
  if (status === 'salvaged') return undefined
  if (status === 'switched_request_mode') return undefined
  if (status === 'switched_model') return undefined
  if (status === 'blocked_by_policy') return policyBlockedReasonFor(event)
  if (event.action === 'fail_fast') {
    return event.intent === 'fail_recovery_exhausted'
      ? 'retry budget exhausted'
      : 'failure is not retryable'
  }
  if (event.action === 'fallback_model' && !event.toModel) {
    return 'no fallback model was available'
  }
  if (event.action === 'abort') return 'request was cancelled'
  return event.final ? `final outcome: ${event.outcome}` : undefined
}

function nextActionFor(event: SafeApiRecoveryTraceEvent): string {
  if (event.policyGate?.actionAllowed === false) {
    return `In ~/.axiomate.json, allow switch_model in ${routeField(event, 'allowActions')}, or switch to a route whose policy permits model fallback.`
  }
  if (event.policyGate?.reasonAllowed === false) {
    return `In ~/.axiomate.json, add this reason to ${routeField(event, 'switchModelOn')}, or choose a route that allows fallback for it.`
  }

  switch (event.reason) {
    case 'auth':
    case 'auth_permanent':
      return `Check ${modelField(event, 'apiKey')} or its environment variable, then verify the provider account and model access.`
    case 'billing':
      return `Top up the provider account, or edit ${routeField(event, 'primary')} / ${routeField(event, 'fallbackChain')} to use an available cheaper model.`
    case 'rate_limit':
    case 'overloaded':
      return `Wait for provider capacity, or use /model route show and edit ${routeField(event, 'fallbackChain')} to include another provider.`
    case 'timeout':
    case 'connection':
      return `Check network/proxy settings and ${modelField(event, 'baseUrl')}; if the provider is slow, review the API timeout policy before retrying.`
    case 'model_not_found':
      return `Check ${modelField(event, 'model')}, ${modelField(event, 'protocol')}, and ${modelField(event, 'baseUrl')}, then run /model route show to confirm the active route points at it.`
    case 'provider_policy_blocked':
      return `Choose a provider/model allowed by the account or gateway policy, then update ${modelEntry(event)} or the active route.`
    case 'content_policy_blocked':
      return `The provider safety/content filter rejected this prompt. Rephrase the request, or use a route whose fallback policy allows another provider for content_policy_blocked.`
    case 'streaming_unsupported':
      return `This endpoint explicitly rejected streaming. Keep the automatic non-streaming fallback, or set ${modelField(event, 'protocol')} / ${modelField(event, 'baseUrl')} to an endpoint with streaming support.`
    case 'stream_endpoint_not_found':
      return `The streaming endpoint returned 404 while model-not-found was not indicated. Check ${modelField(event, 'baseUrl')} and ${modelField(event, 'protocol')}; non-streaming fallback may still work for this gateway.`
    case 'context_overflow':
    case 'payload_too_large':
      return event.action === 'request_compaction'
        ? 'Let compaction finish; if this repeats, reduce large tool/file output or run /compact before retrying.'
        : 'Compact the conversation or reduce large tool/file output before retrying.'
    case 'unsupported_parameter':
    case 'max_tokens_too_large':
    case 'invalid_encrypted_content':
    case 'multimodal_tool_content_unsupported':
    case 'thinking_signature':
    case 'long_context_tier':
    case 'oauth_long_context_beta_forbidden':
    case 'llama_cpp_grammar_pattern':
    case 'slash_enum_unsupported':
      return event.mutation && event.mutation.length > 0
        ? `Axiomate adapted the request shape; if this repeats, check ${modelField(event, 'vendor')}, ${modelField(event, 'template')}, and ${modelField(event, 'extraParams')} compatibility.`
        : `Check ${modelField(event, 'vendor')}, ${modelField(event, 'template')}, and ${modelField(event, 'extraParams')} for provider compatibility with this request shape.`
    case 'image_too_large':
      return `Resize or reduce image inputs; if the model is text-only, set ${modelField(event, 'supportsImages')}=false or choose an image-capable model.`
    case 'responses_null_output':
      return `For OpenAI Responses null output, check ${modelField(event, 'protocol')} / ${modelField(event, 'baseUrl')} compatibility or switch this model to OpenAI Chat if the gateway only emulates chat.`
    case 'malformed_response':
    case 'format_error':
      return `Check ${modelField(event, 'protocol')} / ${modelField(event, 'baseUrl')} compatibility; if it repeats, switch route or use a provider with reliable streaming/non-streaming support.`
    case 'server_error':
      return `Retry later, or edit ${routeField(event, 'fallbackChain')} so server-side failures can switch to another provider.`
    case 'abort':
      return 'No action needed unless this was unexpected; retry the request.'
    case 'unknown':
      if (event.statusCode === 404) {
        return `Check ${modelField(event, 'baseUrl')} and ${modelField(event, 'protocol')}; HTTP 404 without a model-not-found signal usually means an endpoint path or gateway routing problem.`
      }
      if (event.innerCause) {
        return `Use the observed cause above with ${modelField(event, 'baseUrl')}, ${modelField(event, 'protocol')}, and provider status; add a classifier rule if this provider emits the same stable error shape.`
      }
      return `Reproduce once, then inspect ${modelField(event, 'protocol')}, ${modelField(event, 'baseUrl')}, and provider status; add a classifier rule if the same unclassified shape repeats.`
  }
}

function modelEntry(event: SafeApiRecoveryTraceEvent): string {
  return event.model ? `models${configKey(event.model)}` : 'models.<model>'
}

function modelField(
  event: SafeApiRecoveryTraceEvent,
  field: string,
): string {
  return `${modelEntry(event)}.${field}`
}

function routeField(
  event: SafeApiRecoveryTraceEvent,
  field: string,
): string {
  const route = event.routeId
    ? `model.routes${configKey(event.routeId)}`
    : 'model.routes.<route>'
  return `${route}.${field}`
}

function configKey(key: string): string {
  return `["${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

function timeoutFor(event: SafeApiRecoveryTraceEvent): string | undefined {
  if (!event.timeoutKind && event.timeoutMs === undefined) return undefined
  return [event.timeoutKind, event.timeoutMs !== undefined ? `${event.timeoutMs}ms` : undefined]
    .filter(Boolean)
    .join(' ')
}

function elapsedFor(event: SafeApiRecoveryTraceEvent): string | undefined {
  const parts = []
  if (event.ttfbMs !== undefined) parts.push(`TTFB ${event.ttfbMs}ms`)
  if (event.elapsedMs !== undefined) parts.push(`elapsed ${event.elapsedMs}ms`)
  if (event.bytesReceived !== undefined) parts.push(`${event.bytesReceived} bytes`)
  return parts.length > 0 ? parts.join(', ') : undefined
}

function policyGateFor(event: SafeApiRecoveryTraceEvent): string | undefined {
  const gate = event.policyGate
  if (!gate) return undefined
  const parts = []
  if (gate.actionAllowed !== undefined) parts.push(`actionAllowed=${gate.actionAllowed}`)
  if (gate.reasonAllowed !== undefined) parts.push(`reasonAllowed=${gate.reasonAllowed}`)
  if (gate.allowActions?.length) parts.push(`allowActions=${gate.allowActions.join(',')}`)
  if (gate.switchModelOn?.length) parts.push(`switchModelOn=${gate.switchModelOn.join(',')}`)
  return parts.length > 0 ? parts.join(' ') : undefined
}

function compareTraceEventsAscending(
  a: SafeApiRecoveryTraceEvent,
  b: SafeApiRecoveryTraceEvent,
): number {
  if (a.sequence !== undefined && b.sequence !== undefined) {
    return a.sequence - b.sequence
  }
  const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp)
  if (byTime !== 0) return byTime
  if (a.decisionId !== undefined && b.decisionId !== undefined) {
    return a.decisionId - b.decisionId
  }
  if (a.observationId !== undefined && b.observationId !== undefined) {
    return a.observationId - b.observationId
  }
  return a.attempt - b.attempt
}

function latestMs(events: readonly SafeApiRecoveryTraceEvent[]): number {
  const latest = events[events.length - 1]
  return latest?.sequence ?? (Date.parse(latest?.timestamp ?? '') || 0)
}

function isModelFallbackBlockedByPolicy(event: SafeApiRecoveryTraceEvent): boolean {
  if (!event.final || event.outcome !== 'failing') {
    return false
  }
  if (!event.shouldFallback && event.intent !== 'switch_to_fallback_model') {
    return false
  }
  return (
    event.policyGate?.actionAllowed === false ||
    event.policyGate?.reasonAllowed === false
  )
}

function policyBlockedReasonFor(event: SafeApiRecoveryTraceEvent): string {
  if (event.policyGate?.actionAllowed === false) {
    return 'route policy disallowed model fallback'
  }
  if (event.policyGate?.reasonAllowed === false) {
    return `route policy disallowed model fallback for ${event.reason}`
  }
  return 'route policy blocked model fallback'
}

function isDelegatedRecovery(event: SafeApiRecoveryTraceEvent): boolean {
  return (
    event.outcome === 'delegated' ||
    event.action === 'request_compaction' ||
    event.intent === 'delegate_conversation_compaction'
  )
}

function isModelSwitchEvent(event: SafeApiRecoveryTraceEvent): boolean {
  return event.action === 'fallback_model'
}

function isRequestShapeAdaptation(action: RecoveryAction): boolean {
  const actions: readonly RecoveryAction[] = [
    'omit_request_fields',
    'strip_reasoning_replay',
    'downgrade_multimodal_tool_content',
    'strip_json_schema_keywords',
    'strip_slash_enums',
    'drop_max_tokens',
    'reduce_max_tokens',
    'disable_thinking',
    'disable_long_context_beta',
    'lower_context_tier',
    'rewrite_image_payload',
  ]
  return actions.includes(action)
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))]
}
