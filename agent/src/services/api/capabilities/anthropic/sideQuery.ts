/**
 * Anthropic-specific sideQuery implementation.
 *
 * Handles: CLI system prompt prefix, betas management, thinking config,
 * prompt caching, telemetry logging. Delegates actual SDK call to
 * provider.inference().
 */
import {
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
} from '../../../../bootstrap/state.js'
import { getCLISyspromptPrefix } from '../../../../constants/system.js'
import { getModelBetas } from '../../../../utils/betas.js'
import type { LLMProvider } from '../../provider.js'
import type {
  ContentBlockParam,
  InferenceResponse,
  TextBlockParam,
} from '../../streamTypes.js'
import type { NeutralSideQueryOptions } from '../sideQuery.js'

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

  // Build system prompt with CLI prefix
  const systemBlocks: ContentBlockParam[] = [
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
    providerHints: {
      betas,
      maxRetries,
      source: querySource,
    },
  })

  // Telemetry (application-layer, not provider-specific)
  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  setLastApiCompletionTimestamp(now)

  return response
}
