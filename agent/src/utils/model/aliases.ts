/**
 * Axiomate has no hardcoded model aliases. The only model input surface is
 * the `config.models` map in ~/.axiomate.json — user-provided keys (e.g.
 * "fast", "qwen-coder", "my-model") are the aliases.
 *
 * `ModelAlias` is kept as `string` so legacy type signatures
 * `model?: ModelAlias` still accept any value the user passes.
 */

export type ModelAlias = string
