import { getGlobalConfig } from './config.js'
import { fuzzyMatchContextWindow } from './model/contextWindowFuzzy.js'

// Final fallback when neither the user config nor the fuzzy matcher can
// identify the model. 64K is the floor because most modern open-weight
// LLMs ship with at least that much context (Qwen 2.x at 32K is rare
// today; Qwen 3, Llama 3.1+, DeepSeek V2+, Kimi K2, GLM-4 are all ≥ 128K).
// Picking 64K means: even a totally unknown model gets enough headroom
// to avoid premature compact while staying under any model's real cap.
export const MODEL_CONTEXT_WINDOW_DEFAULT = 64_000

export function getContextWindowForModel(model: string): number {
  return (
    getGlobalConfig().models?.[model]?.contextWindow ??
    fuzzyMatchContextWindow(model) ??
    MODEL_CONTEXT_WINDOW_DEFAULT
  )
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
