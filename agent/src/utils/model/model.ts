/**
 * Model resolution and display utilities.
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { getGlobalConfig } from '../config.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getAuxiliaryTaskPolicyFromConfig,
  getDefaultRouteIdFromConfig,
  getMainRouteFromConfig,
  getModelRouteFromConfig,
  normalizeModelRoutingConfig,
  resolveMainModelOverride,
  resolveModelChainFromRoute,
  type AuxiliaryTaskId,
  type MainModelOverride,
  type ResolvedAuxiliaryTaskPolicy,
  type ResolvedModelRoute,
} from './modelRouting.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | null

function isConfiguredModel(model: ModelSetting | undefined): model is ModelName {
  return typeof model === 'string' && !!getGlobalConfig().models?.[model]
}

export function singleModelOverride(modelId: ModelName): MainModelOverride {
  return { type: 'single-model-route', modelId: parseUserSpecifiedModel(modelId) }
}

export function defaultRouteOverride(): MainModelOverride {
  return { type: 'default-route' }
}

/**
 * Get the model from an explicit session override or the configured default
 * route.
 *
 * Priority:
 * 1. MainModelOverride for this session/startup, when present
 * 2. model.defaultRoute primary (from ~/.axiomate.json)
 *
 * No implicit fallback outside the normalized route config.
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    specifiedModel = resolveMainModelOverride(getGlobalConfig(), modelOverride).primary
  }

  if (!specifiedModel) {
    specifiedModel = getDefaultMainLoopModelSetting()
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

export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  return params.mainLoopModel
}

export function getDefaultMainLoopModelSetting(): ModelName {
  return getMainRouteFromConfig(getGlobalConfig()).primary
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
  const model = getMainRouteFromConfig(config).primary
  if (!model) return 'unconfigured'
  const name = config.models?.[model]?.name ?? model
  return name
}

export function getDefaultRouteId(): string {
  return getDefaultRouteIdFromConfig(getGlobalConfig())
}

export function getMainRoute(): ResolvedModelRoute {
  return getMainRouteFromConfig(getGlobalConfig())
}

export function getModelRoute(routeId: string): ResolvedModelRoute | undefined {
  return getModelRouteFromConfig(getGlobalConfig(), routeId)
}

export function resolveModelRef(model: ModelName): ModelName {
  const trimmed = parseUserSpecifiedModel(model)
  const config = getGlobalConfig()
  if (!config.models?.[trimmed]) {
    throw new Error(
      `Model "${trimmed}" is not defined in config.models. Add it to ~/.axiomate.json.`,
    )
  }
  return trimmed
}

export function resolveModelChain(route = getMainRoute()): ModelName[] {
  const config = getGlobalConfig()
  return resolveModelChainFromRoute(route).map(model => {
    if (!config.models?.[model]) {
      throw new Error(
        `Model "${model}" is not defined in config.models. Add it to ~/.axiomate.json.`,
      )
    }
    return model
  })
}

export function getMainModelCandidate(index = 0): ModelName {
  const chain = resolveModelChain()
  const model = chain[index]
  if (!model) {
    throw new Error(`No main model candidate exists at index ${index}.`)
  }
  return model
}

export function getAuxiliaryTaskPolicy(
  task: AuxiliaryTaskId,
): ResolvedAuxiliaryTaskPolicy {
  return getAuxiliaryTaskPolicyFromConfig(getGlobalConfig(), task)
}

export function getNormalizedModelRoutingConfig() {
  return normalizeModelRoutingConfig(getGlobalConfig())
}

export function renderDefaultModelSetting(
  setting: ModelName,
): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function renderModelSetting(setting: ModelName): string {
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
  modelInput: ModelName,
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
