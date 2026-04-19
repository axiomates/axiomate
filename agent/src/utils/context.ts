import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'

// Fallback when ModelProviderConfig.contextWindow is not set.
// Small on purpose: signals "model unknown / unconfigured" rather than
// assuming a large window the real model may not have.
export const MODEL_CONTEXT_WINDOW_DEFAULT = 32_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by deployment admins to disable 1M context for compliance.
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
 * Returns the max output tokens for a given model.
 *
 * Rule:
 *   - If user pinned maxOutputTokens in ModelProviderConfig → use it
 *   - Else: contextWindow / 4 (reserve 1/4 of budget for output)
 *
 * No hard cap: scales naturally with the model's declared contextWindow.
 */
export function getModelMaxOutputTokens(model: string): number {
  const cfg = getGlobalConfig().models?.[model]
  if (cfg?.maxOutputTokens) return cfg.maxOutputTokens
  const contextWindow = cfg?.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT
  return Math.floor(contextWindow / 4)
}

/**
 * Returns the max thinking budget tokens for a given model. Derived from
 * the context window: thinking budget shouldn't exceed what the model can
 * produce. Kept slightly below the ceiling so callers can still add a
 * text response alongside thinking.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getContextWindowForModel(model) - 1
}
