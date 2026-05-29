import { getSettings_DEPRECATED } from '../settings/settings.js'

/**
 * Check if a model name starts with a prefix at a segment boundary.
 * The prefix must match up to the end of the name or a "-" separator.
 */
function prefixMatchesModel(modelName: string, prefix: string): boolean {
  if (!modelName.startsWith(prefix)) {
    return false
  }
  return modelName.length === prefix.length || modelName[prefix.length] === '-'
}

/**
 * Check if a model is allowed by the availableModels allowlist in settings.
 * If availableModels is not set, all models are allowed. Empty array blocks all.
 *
 * Matching: exact match OR segment-boundary prefix match. Axiomate has no
 * hardcoded model names; the allowlist entry must literally match the
 * configured model key or be a prefix segment of it.
 */
export function isModelAllowed(model: string): boolean {
  const settings = getSettings_DEPRECATED() || {}
  const { availableModels } = settings
  if (!availableModels) {
    return true
  }
  if (availableModels.length === 0) {
    return false
  }

  const normalizedModel = model.trim().toLowerCase()
  const normalizedAllowlist = availableModels.map(m => m.trim().toLowerCase())

  if (normalizedAllowlist.includes(normalizedModel)) {
    return true
  }

  for (const entry of normalizedAllowlist) {
    if (prefixMatchesModel(normalizedModel, entry)) {
      return true
    }
  }

  return false
}
