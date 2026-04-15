/**
 * Anthropic-specific sideQuery implementation.
 *
 * Handles: fingerprint attribution, CLI system prompt prefix, betas management,
 * thinking config, prompt caching, telemetry logging.
 * Delegates actual SDK call to provider.inference().
 */
import {
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
} from '../../../../bootstrap/state.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../../../constants/system.js'
import { logEvent } from '../../../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../../../services/analytics/metadata.js'
import { getAPIMetadata } from '../../claude.js'
import { getModelBetas } from '../../../../utils/betas.js'
import { computeFingerprint } from '../../../../utils/fingerprint.js'
import type { LLMProvider } from '../../provider.js'
import type {
  ContentBlockParam,
  InferenceResponse,
  TextBlockParam,
} from '../../streamTypes.js'
import type { NeutralSideQueryOptions } from '../sideQuery.js'

/**
 * Extract text from first user message for fingerprint computation.
 */
function extractFirstUserMessageText(messages: NeutralSideQueryOptions['messages']): string {
  const firstUserMessage = messages.find(m => m.role === 'user')
  if (!firstUserMessage) return ''
  const content = firstUserMessage.content
  if (typeof content === 'string') return content
  const textBlock = content.find(block => block.type === 'text')
  return textBlock?.type === 'text' ? textBlock.text : ''
}

export async function anthropicSideQuery(
  provider: LLMProvider,
  opts: NeutralSideQueryOptions,
): Promise<InferenceResponse> {
  const {
    model,
    system,
    messages,
    tools,
    toolChoice,
    outputFormat,
    maxTokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stopSequences,
    querySource,
  } = opts

  // Anthropic-specific: betas management
  const betas = [...getModelBetas(model)]

  // Anthropic-specific: fingerprint attribution for OAuth
  const messageText = extractFirstUserMessageText(messages)
  const fingerprint = computeFingerprint(messageText, MACRO.VERSION)
  const attributionHeader = getAttributionHeader(fingerprint)

  // Build system prompt with attribution + CLI prefix
  const systemBlocks: ContentBlockParam[] = [
    attributionHeader ? { type: 'text', text: attributionHeader } : null,
    ...(skipSystemPromptPrefix
      ? []
      : [{ type: 'text' as const, text: getCLISyspromptPrefix({ isNonInteractive: false, hasAppendSystemPrompt: false }) }]),
    ...(Array.isArray(system)
      ? system
      : system
        ? [{ type: 'text' as const, text: system }]
        : []),
  ].filter((block): block is TextBlockParam => block !== null)

  // Build thinking config
  let thinkingConfig: { type: 'enabled' | 'disabled' | 'adaptive'; budgetTokens?: number } | undefined
  if (thinking === false) {
    thinkingConfig = { type: 'disabled' }
  } else if (thinking !== undefined) {
    thinkingConfig = {
      type: 'enabled',
      budgetTokens: Math.min(thinking, maxTokens - 1),
    }
  }

  const start = Date.now()

  // Delegate to provider.inference() with Anthropic hints
  const response = await provider.inference({
    model,
    messages,
    system: systemBlocks,
    tools,
    toolChoice,
    outputFormat,
    maxTokens,
    temperature,
    thinking: thinkingConfig,
    stopSequences,
    signal,
    metadata: getAPIMetadata() as Record<string, unknown>,
    providerHints: {
      betas,
      maxRetries,
      source: querySource,
    },
  })

  // Telemetry (application-layer, not provider-specific)
  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('ax_api_success', {
    requestId: response.requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cachedInputTokens: response.usage.cacheReadTokens ?? 0,
    uncachedInputTokens: response.usage.cacheWriteTokens ?? 0,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs: lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  return response
}
