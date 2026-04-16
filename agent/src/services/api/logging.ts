import { feature } from 'bun:bundle'
import { APIError } from '@anthropic-ai/sdk'
import type { NonNullableUsage, NonNullableUsage as Usage } from '../../entrypoints/sdk/sdkUtilityTypes.js'
import type { StopReason } from './streamTypes.js'
import {
  addToTotalDurationState,
  consumePostCompaction,
  getIsNonInteractiveSession,
  getLastApiCompletionTimestamp,
  getTeleportedSessionInfo,
  markFirstTeleportMessageLogged,
  setLastApiCompletionTimestamp,
} from '../../bootstrap/state.js'
import type { QueryChainTracking } from '../../Tool.js'
import { isConnectorTextBlock } from '../../types/connectorText.js'
import type { AssistantMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import type { EffortLevel } from '../../utils/effort.js'
import { logError } from '../../utils/log.js'
import { getAPIProviderForanalytics } from '../../utils/model/providers.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import {
  endLLMRequestSpan,
  isBetaTracingEnabled,
  type Span,
} from '../../utils/telemetry/sessionTracing.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import {
  logEvent,
} from '../analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../analytics/metadata.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import { classifyAPIError } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

export type { NonNullableUsage }
export { EMPTY_USAGE }

// Strategy used for global prompt caching
export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

function getErrorMessage(error: unknown): string {
  if (error instanceof APIError) {
    const body = error.error as { error?: { message?: string } } | undefined
    if (body?.error?.message) return body.error.message
  }
  return error instanceof Error ? error.message : String(error)
}

type KnownGateway =
  | 'litellm'
  | 'helicone'
  | 'portkey'
  | 'cloudflare-ai-gateway'
  | 'kong'
  | 'braintrust'
  | 'databricks'

// Gateway fingerprints for detecting AI gateways from response headers
const GATEWAY_FINGERPRINTS: Partial<
  Record<KnownGateway, { prefixes: string[] }>
> = {
  // https://docs.litellm.ai/docs/proxy/response_headers
  litellm: {
    prefixes: ['x-litellm-'],
  },
  // https://docs.helicone.ai/helicone-headers/header-directory
  helicone: {
    prefixes: ['helicone-'],
  },
  // https://portkey.ai/docs/api-reference/response-schema
  portkey: {
    prefixes: ['x-portkey-'],
  },
  // https://developers.cloudflare.com/ai-gateway/evaluations/add-human-feedback-api/
  'cloudflare-ai-gateway': {
    prefixes: ['cf-aig-'],
  },
  // https://developer.konghq.com/ai-gateway/ — X-Kong-Upstream-Latency, X-Kong-Proxy-Latency
  kong: {
    prefixes: ['x-kong-'],
  },
  // https://www.braintrust.dev/docs/guides/proxy — x-bt-used-endpoint, x-bt-cached
  braintrust: {
    prefixes: ['x-bt-'],
  },
}

// Gateways that use provider-owned domains (not self-hosted), so the
// ANTHROPIC_BASE_URL hostname is a reliable signal even without a
// distinctive response header.
const GATEWAY_HOST_SUFFIXES: Partial<Record<KnownGateway, string[]>> = {
  // https://docs.databricks.com/aws/en/ai-gateway/
  databricks: [
    '.cloud.databricks.com',
    '.azuredatabricks.net',
    '.gcp.databricks.com',
  ],
}

function detectGateway({
  headers,
  baseUrl,
}: {
  headers?: globalThis.Headers
  baseUrl?: string
}): KnownGateway | undefined {
  if (headers) {
    // Header names are already lowercase from the Headers API
    const headerNames: string[] = []
    headers.forEach((_, key) => headerNames.push(key))
    for (const [gw, { prefixes }] of Object.entries(GATEWAY_FINGERPRINTS)) {
      if (prefixes.some(p => headerNames.some(h => h.startsWith(p)))) {
        return gw as KnownGateway
      }
    }
  }

  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase()
      for (const [gw, suffixes] of Object.entries(GATEWAY_HOST_SUFFIXES)) {
        if (suffixes.some(s => host.endsWith(s))) {
          return gw as KnownGateway
        }
      }
    } catch {
      // malformed URL — ignore
    }
  }

  return undefined
}

function getAnthropicEnvMetadata() {
  return {
    ...(process.env.ANTHROPIC_BASE_URL
      ? {
          baseUrl: process.env
        }
      : {}),
    ...(process.env.ANTHROPIC_MODEL
      ? {
          envModel: process.env
        }
      : {}),
    ...(process.env.ANTHROPIC_SMALL_FAST_MODEL
      ? {
          envSmallFastModel: process.env
        }
      : {}),
  }
}

function getBuildAgeMinutes(): number | undefined {
  if (!MACRO.BUILD_TIME) return undefined
  const buildTime = new Date(MACRO.BUILD_TIME).getTime()
  if (isNaN(buildTime)) return undefined
  return Math.floor((Date.now() - buildTime) / 60000)
}

export function logAPIQuery({
  model,
  messagesLength,
  temperature,
  betas,
  permissionMode,
  querySource,
  queryTracking,
  thinkingType,
  effortValue,
  previousRequestId,
}: {
  model: string
  messagesLength: number
  temperature: number
  betas?: string[]
  permissionMode?: PermissionMode
  querySource: string
  queryTracking?: QueryChainTracking
  thinkingType?: 'adaptive' | 'enabled' | 'disabled'
  effortValue?: EffortLevel | null
  previousRequestId?: string | null
}): void {
}

export function logAPIError({
  error,
  model,
  messageCount,
  messageTokens,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  requestId,
  clientRequestId,
  didFallBackToNonStreaming,
  promptCategory,
  headers,
  queryTracking,
  querySource,
  llmSpan,
  previousRequestId,
}: {
  error: unknown
  model: string
  messageCount: number
  messageTokens?: number
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  requestId?: string | null
  /** Client-generated ID sent as x-client-request-id header (survives timeouts) */
  clientRequestId?: string
  didFallBackToNonStreaming?: boolean
  promptCategory?: string
  headers?: globalThis.Headers
  queryTracking?: QueryChainTracking
  querySource?: string
  /** The span from startLLMRequestSpan - pass this to correctly match responses to requests */
  llmSpan?: Span
  previousRequestId?: string | null
}): void {
  const gateway = detectGateway({
    headers:
      error instanceof APIError && error.headers ? error.headers : headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  const errStr = getErrorMessage(error)
  const status = error instanceof APIError ? String(error.status) : undefined
  const errorType = classifyAPIError(error)

  // Log detailed connection error info to debug logs (visible via --debug)
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    const sslLabel = connectionDetails.isSSLError ? ' (SSL error)' : ''
    logForDebugging(
      `Connection error details: code=${connectionDetails.code}${sslLabel}, message=${connectionDetails.message}`,
      { level: 'error' },
    )
  }

  const invocation = consumeInvokingRequestId()

  if (clientRequestId) {
    logForDebugging(
      `API error x-client-request-id=${clientRequestId} (give this to the API team for server-log lookup)`,
      { level: 'error' },
    )
  }

  logError(error as Error)

  // Log API error event for OTLP
  void logOTelEvent('api_error', {
    model: model,
    error: errStr,
    status_code: String(status),
    duration_ms: String(durationMs),
    attempt: String(attempt),
    speed: 'normal',
  })

  // Pass the span to correctly match responses to requests when beta tracing is enabled
  endLLMRequestSpan(llmSpan, {
    success: false,
    statusCode: status ? parseInt(status) : undefined,
    error: errStr,
    attempt,
  })

  // Log first error for teleported sessions (reliability tracking)
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    markFirstTeleportMessageLogged()
  }
}

function logAPISuccess({
  model,
  preNormalizedModel,
  messageCount,
  messageTokens,
  usage,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  ttftMs,
  requestId,
  stopReason,
  costUSD,
  didFallBackToNonStreaming,
  querySource,
  gateway,
  queryTracking,
  permissionMode,
  globalCacheStrategy,
  textContentLength,
  thinkingContentLength,
  toolUseContentLengths,
  connectorTextBlockCount,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  messageCount: number
  messageTokens: number
  usage: Usage
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  ttftMs: number | null
  requestId: string | null
  stopReason: StopReason | null
  costUSD: number
  didFallBackToNonStreaming: boolean
  querySource: string
  gateway?: KnownGateway
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  globalCacheStrategy?: GlobalCacheStrategy
  textContentLength?: number
  thinkingContentLength?: number
  toolUseContentLengths?: Record<string, number>
  connectorTextBlockCount?: number
  previousRequestId?: string | null
  betas?: string[]
}): void {
  const isNonInteractiveSession = getIsNonInteractiveSession()
  const isPostCompaction = consumePostCompaction()
  const hasPrintFlag =
    process.argv.includes('-p') || process.argv.includes('--print')

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  const timeSinceLastApiCallMs =
    lastCompletion !== null ? now - lastCompletion : undefined

  const invocation = consumeInvokingRequestId()


  setLastApiCompletionTimestamp(now)
}

export function logAPISuccessAndDuration({
  model,
  preNormalizedModel,
  start,
  startIncludingRetries,
  ttftMs,
  usage,
  attempt,
  messageCount,
  messageTokens,
  requestId,
  stopReason,
  didFallBackToNonStreaming,
  querySource,
  headers,
  costUSD,
  queryTracking,
  permissionMode,
  newMessages,
  llmSpan,
  globalCacheStrategy,
  requestSetupMs,
  attemptStartTimes,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  start: number
  startIncludingRetries: number
  ttftMs: number | null
  usage: NonNullableUsage
  attempt: number
  messageCount: number
  messageTokens: number
  requestId: string | null
  stopReason: StopReason | null
  didFallBackToNonStreaming: boolean
  querySource: string
  headers?: globalThis.Headers
  costUSD: number
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  /** Assistant messages from the response - used to extract model_output and thinking_output
   *  when beta tracing is enabled */
  newMessages?: AssistantMessage[]
  /** The span from startLLMRequestSpan - pass this to correctly match responses to requests */
  llmSpan?: Span
  /** Strategy used for global prompt caching: 'tool_based', 'system_prompt', or 'none' */
  globalCacheStrategy?: GlobalCacheStrategy
  /** Time spent in pre-request setup before the successful attempt */
  requestSetupMs?: number
  /** Timestamps (Date.now()) of each attempt start — used for retry sub-spans in Perfetto */
  attemptStartTimes?: number[]
  /** Request ID from the previous API call in this session */
  previousRequestId?: string | null
  betas?: string[]
}): void {
  const gateway = detectGateway({
    headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  let textContentLength: number | undefined
  let thinkingContentLength: number | undefined
  let toolUseContentLengths: Record<string, number> | undefined
  let connectorTextBlockCount: number | undefined

  if (newMessages) {
    let textLen = 0
    let thinkingLen = 0
    let hasToolUse = false
    const toolLengths: Record<string, number> = {}
    let connectorCount = 0

    for (const msg of newMessages) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          textLen += block.text.length
        } else if (false && isConnectorTextBlock(block)) {
          connectorCount++
        } else if (block.type === 'thinking') {
          thinkingLen += block.thinking.length
        } else if (
          block.type === 'tool_use' ||
          block.type === 'server_tool_use' ||
          (block.type as string) === 'mcp_tool_use'
        ) {
          const toolBlock = block as { input: unknown; name: string }
          const inputLen = jsonStringify(toolBlock.input).length
          const sanitizedName = sanitizeToolNameForAnalytics(toolBlock.name)
          toolLengths[sanitizedName] =
            (toolLengths[sanitizedName] ?? 0) + inputLen
          hasToolUse = true
        }
      }
    }

    textContentLength = textLen
    thinkingContentLength = thinkingLen > 0 ? thinkingLen : undefined
    toolUseContentLengths = hasToolUse ? toolLengths : undefined
    connectorTextBlockCount = connectorCount > 0 ? connectorCount : undefined
  }

  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  addToTotalDurationState(durationMsIncludingRetries, durationMs)

  logAPISuccess({
    model,
    preNormalizedModel,
    messageCount,
    messageTokens,
    usage,
    durationMs,
    durationMsIncludingRetries,
    attempt,
    ttftMs,
    requestId,
    stopReason,
    costUSD,
    didFallBackToNonStreaming,
    querySource,
    gateway,
    queryTracking,
    permissionMode,
    globalCacheStrategy,
    textContentLength,
    thinkingContentLength,
    toolUseContentLengths,
    connectorTextBlockCount,
    previousRequestId,
    betas,
  })
  // Log API request event for OTLP
  void logOTelEvent('api_request', {
    model,
    input_tokens: String(usage.input_tokens),
    output_tokens: String(usage.output_tokens),
    cache_read_tokens: String(usage.cache_read_input_tokens),
    cache_creation_tokens: String(usage.cache_creation_input_tokens),
    cost_usd: String(costUSD),
    duration_ms: String(durationMs),
    speed: 'normal',
  })

  // Extract model output, thinking output, and tool call flag when beta tracing is enabled
  let modelOutput: string | undefined
  let thinkingOutput: string | undefined
  let hasToolCall: boolean | undefined

  if (isBetaTracingEnabled() && newMessages) {
    // Model output - visible to all users
    modelOutput =
      newMessages
        .flatMap(m =>
          m.message.content
            .filter(c => c.type === 'text')
            .map(c => (c as { type: 'text'; text: string }).text),
        )
        .join('\n') || undefined


    // Check if any tool_use blocks were in the output
    hasToolCall = newMessages.some(m =>
      m.message.content.some(c => c.type === 'tool_use'),
    )
  }

  // Pass the span to correctly match responses to requests when beta tracing is enabled
  endLLMRequestSpan(llmSpan, {
    success: true,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    attempt,
    modelOutput,
    thinkingOutput,
    hasToolCall,
    ttftMs: ttftMs ?? undefined,
    requestSetupMs,
    attemptStartTimes,
  })

  // Log first successful message for teleported sessions (reliability tracking)
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    markFirstTeleportMessageLogged()
  }
}
