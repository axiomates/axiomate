import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// llm.ts:getMaxOutputTokensForModel to avoid the config→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.AXIOMATE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (has1mContext(model)) {
    return true
  }
  const modelConfig = getGlobalConfig().models?.[model]
  return (modelConfig?.contextWindow ?? 0) >= 1_000_000
}

export function getContextWindowForModel(
  model: string,
  _betas?: string[],
): number {
  // Config-driven: check ModelProviderConfig.contextWindow (for OpenAI/custom models)
  const modelConfig = getGlobalConfig().models?.[model]
  if (modelConfig?.contextWindow) {
    return modelConfig.contextWindow
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  // Config-driven: use explicit maxOutputTokens or derive from contextWindow
  const modelConfig = getGlobalConfig().models?.[model]
  if (modelConfig) {
    if (modelConfig.maxOutputTokens) {
      return { default: modelConfig.maxOutputTokens, upperLimit: modelConfig.maxOutputTokens }
    }
    if (modelConfig.contextWindow) {
      upperLimit = modelConfig.contextWindow
      defaultTokens = Math.min(MAX_OUTPUT_TOKENS_DEFAULT, Math.floor(modelConfig.contextWindow / 4))
      return { default: defaultTokens, upperLimit }
    }
  }

  defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
  upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
