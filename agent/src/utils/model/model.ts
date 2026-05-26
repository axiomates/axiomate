/**
 * Model resolution and display utilities.
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { getGlobalConfig } from '../config.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias } from './aliases.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

/**
 * Get the user's current model. This is the primary model configured in ~/.axiomate.json.
 * Throws if currentModel is missing or not present in config.models.
 */
function getCurrentModel(): ModelName {
  const config = getGlobalConfig()
  if (!config.currentModel) {
    throw new Error(
      'No currentModel configured. Set "currentModel" in ~/.axiomate.json to a key from the "models" object.',
    )
  }
  if (!config.models?.[config.currentModel]) {
    throw new Error(
      `currentModel "${config.currentModel}" is not defined in config.models. Add it to ~/.axiomate.json.`,
    )
  }
  return config.currentModel
}

export function getFastModel(): ModelName {
  const config = getGlobalConfig()
  if (config.fastModel && config.models?.[config.fastModel]) return config.fastModel
  return getCurrentModel()
}

/**
 * Get the model from /model command, --model flag, settings, or config.
 *
 * Priority:
 * 1. Model override during session (from /model command)
 * 2. Model override at startup (from --model flag)
 * 3. Settings (from user's saved settings)
 * 4. config.currentModel (from ~/.axiomate.json)
 *
 * No implicit fallback to the first model in config.models — users must
 * set currentModel explicitly.
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = settings.model || undefined
  }

  if (!specifiedModel) {
    const config = getGlobalConfig()
    specifiedModel = config.currentModel ?? undefined
  }

  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getBestModel(): ModelName {
  return getDefaultMainLoopModel()
}

export function getMidModel(): ModelName {
  const config = getGlobalConfig()
  if (config.midModel && config.models?.[config.midModel]) return config.midModel
  return getCurrentModel()
}

/**
 * Resolve the model for a non-main-loop "auxiliary" role (e.g. goal judge).
 *
 * Priority chain reuses axiomate's existing three-tier model concept —
 * no new config field. Goal judges are mid-tier "side tasks" by nature
 * (need decent instruction following + JSON discipline, but cheaper
 * than the main loop), so midModel comes first:
 *
 *   1. `midModel` — best fit, semantically what midModel was built for.
 *   2. `fastModel` — also fine, slightly weaker on JSON discipline.
 *   3. `currentModel` — fallback only; caller surfaces a one-shot warning
 *      so users notice their judge is burning main-model tokens.
 *
 * `tier` lets the caller decide whether to nudge the user about cost.
 * 'main' = expensive fallback, anything else = OK.
 */
export type AuxiliaryModelTier = 'mid' | 'fast' | 'main'

export function getAuxiliaryModel(_role: 'goalJudge'): {
  model: ModelName
  tier: AuxiliaryModelTier
} {
  const config = getGlobalConfig()
  if (config.midModel && config.models?.[config.midModel]) {
    return { model: config.midModel, tier: 'mid' }
  }
  if (config.fastModel && config.models?.[config.fastModel]) {
    return { model: config.fastModel, tier: 'fast' }
  }
  return { model: getCurrentModel(), tier: 'main' }
}

export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  return params.mainLoopModel
}

export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  return getCurrentModel()
}

export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

/**
 * Returns the canonical short name for a model ID (lowercased).
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  return fullModelName.toLowerCase()
}

export function getDefaultModelDescription(): string {
  const config = getGlobalConfig()
  const model = config.currentModel
  if (!model) return 'unconfigured'
  const name = config.models?.[model]?.name ?? model
  return name
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  return renderModelName(setting)
}

export function getPublicModelDisplayName(model: ModelName): string | null {
  const userConfig = getGlobalConfig().models?.[model]
  if (userConfig?.name) {
    return userConfig.name
  }
  return null
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  return model
}

export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  return publicName ?? model
}

/**
 * Parse a user-specified model string. Axiomate has no hardcoded aliases;
 * the input is treated as a config.models key or raw model ID and passed
 * through unchanged (apart from trim).
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  return modelInput.trim()
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

export function getMarketingNameForModel(modelId: string): string | undefined {
  return getGlobalConfig().models?.[modelId]?.name ?? undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
