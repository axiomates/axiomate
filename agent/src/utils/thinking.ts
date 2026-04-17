import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getSettingsWithErrors } from './settings/settings.js'
import { getGlobalConfig } from './config.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (config). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return true
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

/**
 * Thinking is opt-in per model: users declare `thinkingParams` on their
 * ModelProviderConfig (~/.axiomate.json) when the model supports it. The
 * ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES env vars also let pinned
 * Anthropic-family tiers declare capability without editing config.
 */
export function modelSupportsThinking(model: string): boolean {
  const modelConfig = getGlobalConfig().models?.[model]
  if (modelConfig) {
    return modelConfig.thinkingParams != null
  }
  const override = get3PModelCapabilityOverride(model, 'thinking')
  return override ?? false
}

export function modelSupportsAdaptiveThinking(model: string): boolean {
  const modelConfig = getGlobalConfig().models?.[model]
  if (modelConfig) {
    // Config-driven models use thinkingParams passthrough, not an adaptive protocol.
    return false
  }
  const override = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  return override ?? false
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}
