import {
  getGlobalConfig,
  saveGlobalConfig,
  type AuxiliaryTaskConfig,
  type AuxiliaryFailureDisposition,
  type GlobalConfig,
  type ModelRecoveryPolicyAction,
  type ModelRouteConfig,
  type ModelSwitchReason,
} from '../config.js'
import {
  DEFAULT_MAIN_ALLOW_ACTIONS,
  DEFAULT_MAIN_SWITCH_MODEL_ON,
  DEFAULT_ROUTE_ID,
  getDefaultRouteIdFromConfig,
  normalizeModelRoutingConfig,
  validateModelRoutingConfig,
} from './modelRouting.js'
import type { AuxiliaryTaskId } from './modelRouting.js'

export function buildSinglePrimaryMainRoute(
  current: GlobalConfig,
  modelId: string,
): GlobalConfig {
  assertModelExists(current, modelId)
  const normalized = normalizeModelRoutingConfig(current)
  const routeId = normalized.model?.defaultRoute ?? DEFAULT_ROUTE_ID
  const existingRoute = normalized.model?.routes?.[routeId]

  return normalizeModelRoutingConfig({
    ...normalized,
    model: {
      ...normalized.model,
      defaultRoute: routeId,
      routes: {
        ...(normalized.model?.routes ?? {}),
        [routeId]: nextRouteForPrimary(existingRoute, modelId),
      },
    },
  })
}

export function buildSetDefaultRoute(
  current: GlobalConfig,
  routeId: string,
): GlobalConfig {
  const normalized = normalizeModelRoutingConfig(current)
  const existingRoute = normalized.model?.routes?.[routeId]
  if (!existingRoute) {
    throw new Error(`Route "${routeId}" is not defined in model.routes.`)
  }
  return normalizeAndValidate({
    ...normalized,
    model: {
      ...normalized.model,
      defaultRoute: routeId,
    },
  })
}

export function buildSetRoutePrimary(
  current: GlobalConfig,
  routeId: string,
  modelId: string,
): GlobalConfig {
  assertModelExists(current, modelId)
  const normalized = normalizeModelRoutingConfig(current)
  const existingRoute = normalized.model?.routes?.[routeId]
  return normalizeAndValidate({
    ...normalized,
    model: {
      ...normalized.model,
      defaultRoute: normalized.model?.defaultRoute ?? routeId,
      routes: {
        ...(normalized.model?.routes ?? {}),
        [routeId]: nextRouteForPrimary(existingRoute, modelId),
      },
    },
  })
}

export function buildAddRouteFallback(
  current: GlobalConfig,
  routeId: string,
  modelId: string,
): GlobalConfig {
  assertModelExists(current, modelId)
  const normalized = normalizeModelRoutingConfig(current)
  const route = normalized.model?.routes?.[routeId]
  if (!route) {
    throw new Error(`Route "${routeId}" is not defined in model.routes.`)
  }
  if (route.primary === modelId) {
    throw new Error(`Model "${modelId}" is already the primary for route "${routeId}".`)
  }
  const fallbackChain = uniqueStrings([
    ...(route.fallbackChain ?? []),
    modelId,
  ]).filter(candidate => candidate !== route.primary)
  return normalizeAndValidate({
    ...normalized,
    model: {
      ...normalized.model,
      routes: {
        ...(normalized.model?.routes ?? {}),
        [routeId]: {
          ...route,
          fallbackChain,
        },
      },
    },
  })
}

export function buildRemoveRouteFallback(
  current: GlobalConfig,
  routeId: string,
  modelId: string,
): GlobalConfig {
  const normalized = normalizeModelRoutingConfig(current)
  const route = normalized.model?.routes?.[routeId]
  if (!route) {
    throw new Error(`Route "${routeId}" is not defined in model.routes.`)
  }
  return normalizeAndValidate({
    ...normalized,
    model: {
      ...normalized.model,
      routes: {
        ...(normalized.model?.routes ?? {}),
        [routeId]: {
          ...route,
          fallbackChain: (route.fallbackChain ?? []).filter(
            candidate => candidate !== modelId,
          ),
        },
      },
    },
  })
}

export function buildSetAuxiliaryPrimary(
  current: GlobalConfig,
  task: AuxiliaryTaskId,
  modelId: string,
): GlobalConfig {
  assertModelExists(current, modelId)
  const normalized = normalizeModelRoutingConfig(current)
  const existing = normalized.auxiliary?.[task]
  const nextTask: AuxiliaryTaskConfig = {
    ...existing,
    primary: modelId,
    fallbackChain: (existing?.fallbackChain ?? []).filter(
      candidate => candidate !== modelId,
    ),
  }
  return normalizeAndValidate({
    ...normalized,
    auxiliary: {
      ...(normalized.auxiliary ?? {}),
      [task]: nextTask,
    },
  })
}

export function buildCreateRoute(
  current: GlobalConfig,
  routeId: string,
  primary: string,
): GlobalConfig {
  assertValidRouteId(routeId)
  assertModelExists(current, primary)
  const normalized = normalizeModelRoutingConfig(current)
  if (normalized.model?.routes?.[routeId]) {
    throw new Error(`Route "${routeId}" already exists.`)
  }
  return normalizeAndValidate({
    ...normalized,
    model: {
      ...normalized.model,
      defaultRoute: normalized.model?.defaultRoute ?? routeId,
      routes: {
        ...(normalized.model?.routes ?? {}),
        [routeId]: nextRouteForPrimary(undefined, primary),
      },
    },
  })
}

export function buildDeleteRoute(
  current: GlobalConfig,
  routeId: string,
): GlobalConfig {
  const normalized = normalizeModelRoutingConfig(current)
  const routes = { ...(normalized.model?.routes ?? {}) }
  if (!routes[routeId]) {
    throw new Error(`Route "${routeId}" is not defined in model.routes.`)
  }
  if ((normalized.model?.defaultRoute ?? DEFAULT_ROUTE_ID) === routeId) {
    throw new Error(`Cannot delete active default route "${routeId}".`)
  }
  delete routes[routeId]
  return normalizeAndValidate({
    ...normalized,
    model: {
      ...normalized.model,
      routes,
    },
  })
}

export function buildRenameRoute(
  current: GlobalConfig,
  fromRouteId: string,
  toRouteId: string,
): GlobalConfig {
  assertValidRouteId(toRouteId)
  const normalized = normalizeModelRoutingConfig(current)
  const routes = { ...(normalized.model?.routes ?? {}) }
  const route = routes[fromRouteId]
  if (!route) {
    throw new Error(`Route "${fromRouteId}" is not defined in model.routes.`)
  }
  if (routes[toRouteId]) {
    throw new Error(`Route "${toRouteId}" already exists.`)
  }
  delete routes[fromRouteId]
  routes[toRouteId] = route
  const defaultRoute =
    (normalized.model?.defaultRoute ?? DEFAULT_ROUTE_ID) === fromRouteId
      ? toRouteId
      : normalized.model?.defaultRoute
  return normalizeAndValidate({
    ...normalized,
    model: {
      ...normalized.model,
      defaultRoute,
      routes,
    },
  })
}

export function buildSetRoutePolicyField(
  current: GlobalConfig,
  routeId: string,
  field: 'allowActions' | 'switchModelOn' | 'recoveryProfile',
  value: ModelRecoveryPolicyAction[] | ModelSwitchReason[] | string,
): GlobalConfig {
  const normalized = normalizeModelRoutingConfig(current)
  const route = normalized.model?.routes?.[routeId]
  if (!route) {
    throw new Error(`Route "${routeId}" is not defined in model.routes.`)
  }
  return normalizeAndValidate({
    ...normalized,
    model: {
      ...normalized.model,
      routes: {
        ...(normalized.model?.routes ?? {}),
        [routeId]: {
          ...route,
          [field]: value,
        },
      },
    },
  })
}

export function buildAddAuxiliaryFallback(
  current: GlobalConfig,
  task: AuxiliaryTaskId,
  modelId: string,
): GlobalConfig {
  assertModelExists(current, modelId)
  const normalized = normalizeModelRoutingConfig(current)
  const existing = normalized.auxiliary?.[task]
  if (!existing) {
    throw new Error(`Auxiliary task "${task}" is not defined.`)
  }
  if (existing.primary === modelId) {
    throw new Error(
      `Model "${modelId}" is already the primary for auxiliary "${task}".`,
    )
  }
  const fallbackChain = uniqueStrings([
    ...(existing.fallbackChain ?? []),
    modelId,
  ]).filter(candidate => candidate !== existing.primary)
  return normalizeAndValidate({
    ...normalized,
    auxiliary: {
      ...(normalized.auxiliary ?? {}),
      [task]: {
        ...existing,
        fallbackChain,
      },
    },
  })
}

export function buildRemoveAuxiliaryFallback(
  current: GlobalConfig,
  task: AuxiliaryTaskId,
  modelId: string,
): GlobalConfig {
  const normalized = normalizeModelRoutingConfig(current)
  const existing = normalized.auxiliary?.[task]
  if (!existing) {
    throw new Error(`Auxiliary task "${task}" is not defined.`)
  }
  return normalizeAndValidate({
    ...normalized,
    auxiliary: {
      ...(normalized.auxiliary ?? {}),
      [task]: {
        ...existing,
        fallbackChain: (existing.fallbackChain ?? []).filter(
          candidate => candidate !== modelId,
        ),
      },
    },
  })
}

export function buildSetAuxiliaryPolicyField(
  current: GlobalConfig,
  task: AuxiliaryTaskId,
  field:
    | 'allowActions'
    | 'switchModelOn'
    | 'recoveryProfile'
    | 'failure'
    | 'timeoutMs',
  value:
    | ModelRecoveryPolicyAction[]
    | ModelSwitchReason[]
    | AuxiliaryFailureDisposition
    | string
    | number,
): GlobalConfig {
  const normalized = normalizeModelRoutingConfig(current)
  const existing = normalized.auxiliary?.[task]
  if (!existing) {
    throw new Error(`Auxiliary task "${task}" is not defined.`)
  }
  return normalizeAndValidate({
    ...normalized,
    auxiliary: {
      ...(normalized.auxiliary ?? {}),
      [task]: {
        ...existing,
        [field]: value,
      },
    },
  })
}

export function persistMainRoutePrimary(modelId: string): void {
  saveGlobalConfig(current => buildSinglePrimaryMainRoute(current, modelId))
}

export function getPersistedMainRoutePrimary(): string | null {
  const normalized = normalizeModelRoutingConfig(getGlobalConfig())
  const routeId = getDefaultRouteIdFromConfig(normalized)
  return normalized.model?.routes?.[routeId]?.primary ?? null
}

function nextRouteForPrimary(
  existingRoute: ModelRouteConfig | undefined,
  modelId: string,
): ModelRouteConfig {
  return {
    ...existingRoute,
    primary: modelId,
    fallbackChain: (existingRoute?.fallbackChain ?? []).filter(
      candidate => candidate !== modelId,
    ),
    recoveryProfile: existingRoute?.recoveryProfile ?? 'main-agent',
    allowActions: existingRoute?.allowActions ?? DEFAULT_MAIN_ALLOW_ACTIONS,
    switchModelOn: existingRoute?.switchModelOn ?? DEFAULT_MAIN_SWITCH_MODEL_ON,
  }
}

function assertModelExists(config: GlobalConfig, modelId: string): void {
  if (!config.models?.[modelId]) {
    throw new Error(`Model "${modelId}" is not defined in models.`)
  }
}

function assertValidRouteId(routeId: string): void {
  if (!routeId.trim()) {
    throw new Error('Route id is required.')
  }
  if (/\s/.test(routeId)) {
    throw new Error('Route id must not contain whitespace.')
  }
}

function normalizeAndValidate(config: GlobalConfig): GlobalConfig {
  const normalized = normalizeModelRoutingConfig(config)
  const issues = validateModelRoutingConfig(normalized)
  if (issues.length > 0) {
    throw new Error(
      `Invalid model routing config:\n${issues.map(issue => `- ${issue.path}: ${issue.message}`).join('\n')}`,
    )
  }
  return normalized
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}
