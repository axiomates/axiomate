/**
 * Axiomate has no hardcoded model aliases. The only model input surface is
 * the `config.models` map in ~/.axiomate.json — user-provided keys (e.g.
 * "fast", "qwen-coder", "my-model") are the aliases.
 *
 * These arrays remain empty so the rest of the code can still call
 * isModelAlias / isModelFamilyAlias without conditionals; both always
 * return false.
 */

export const MODEL_ALIASES = [] as const
// Kept as `string` so legacy type signatures `model?: ModelAlias` still accept
// any value the user passes. Runtime isModelAlias check always returns false.
export type ModelAlias = string

export function isModelAlias(_modelInput: string): boolean {
  return false
}

export const MODEL_FAMILY_ALIASES = [] as const

export function isModelFamilyAlias(_model: string): boolean {
  return false
}
