import type {
  AuxiliaryFailureDisposition,
  AuxiliaryTaskConfig,
  GlobalConfig,
  MainModelRoutingConfig,
  ModelRecoveryPolicyAction,
  ModelRouteConfig,
  ModelSwitchReason,
} from '../config.js'

export type AuxiliaryTaskId =
  | 'goalJudge'
  | 'sessionSearchSummary'
  | 'memdirRelevance'
  | 'tokenCounting'
  | 'awaySummary'
  | 'toolUseSummary'
  | 'sessionTitle'
  | 'conversationRename'
  | 'webFetchSummary'
  | 'permissionExplainer'
  | 'compact'
  | 'sideQuestion'
  | 'forkedAgent'
  | 'visionOcr'
  | string

export type ResolvedModelRoute = Required<
  Pick<ModelRouteConfig, 'primary' | 'fallbackChain' | 'allowActions' | 'switchModelOn'>
> & {
  id: string
  recoveryProfile: string
}

export type ResolvedAuxiliaryTaskPolicy = ResolvedModelRoute & {
  task: AuxiliaryTaskId
  failure: AuxiliaryFailureDisposition
  timeoutMs?: number
  extraBody?: Record<string, unknown>
}

export type MainModelOverride =
  | { type: 'default-route' }
  | { type: 'route'; routeId: string }
  | { type: 'single-model-route'; modelId: string }

export type RouteValidationIssue = {
  path: string
  message: string
}

export const DEFAULT_ROUTE_ID = 'default'

export const DEFAULT_MAIN_ALLOW_ACTIONS: ModelRecoveryPolicyAction[] = [
  'retry_same_model',
  'adapt_request',
  'switch_model',
]

export const DEFAULT_AUXILIARY_ALLOW_ACTIONS: ModelRecoveryPolicyAction[] = [
  'retry_same_model',
  'adapt_request',
  'switch_model',
]

export const DEFAULT_MAIN_SWITCH_MODEL_ON: ModelSwitchReason[] = [
  'rate_limit',
  'overloaded',
  'timeout',
  'connection',
  'server_error',
  'malformed_response',
  'responses_null_output',
  'model_not_found',
  'provider_policy_blocked',
]

export const DEFAULT_AUXILIARY_SWITCH_MODEL_ON: ModelSwitchReason[] = [
  'timeout',
  'connection',
  'server_error',
  'malformed_response',
  'responses_null_output',
  'model_not_found',
  'provider_policy_blocked',
]

const VALID_POLICY_ACTIONS = new Set<ModelRecoveryPolicyAction>([
  'retry_same_model',
  'adapt_request',
  'switch_model',
])

const VALID_SWITCH_REASONS = new Set<ModelSwitchReason>([
  'connection',
  'timeout',
  'overloaded',
  'rate_limit',
  'server_error',
  'malformed_response',
  'responses_null_output',
  'model_not_found',
  'provider_policy_blocked',
  'unknown',
])

const VALID_AUXILIARY_FAILURES = new Set<AuxiliaryFailureDisposition>([
  'fail_open',
  'fail_closed',
  'return_null',
  'return_original',
  'return_empty',
  'propagate_error',
])

export const DEFAULT_AUXILIARY_TASK_POLICIES: Record<
  string,
  Omit<AuxiliaryTaskConfig, 'primary' | 'fallbackChain'>
> = {
  goalJudge: {
    recoveryProfile: 'auxiliary-judge',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: [
      'rate_limit',
      'overloaded',
      ...DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    ],
    failure: 'fail_open',
    timeoutMs: 30_000,
  },
  sessionSearchSummary: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_original',
    timeoutMs: 30_000,
  },
  memdirRelevance: {
    recoveryProfile: 'auxiliary-quality',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 30_000,
  },
  tokenCounting: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: ['retry_same_model', 'switch_model'],
    switchModelOn: ['timeout', 'connection', 'server_error'],
    failure: 'return_null',
    timeoutMs: 15_000,
  },
  awaySummary: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 30_000,
  },
  toolUseSummary: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 15_000,
  },
  sessionTitle: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 15_000,
  },
  conversationRename: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 15_000,
  },
  webFetchSummary: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_original',
    timeoutMs: 30_000,
  },
  permissionExplainer: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 15_000,
  },
  hookPrompt: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 30_000,
  },
  hookAgent: {
    recoveryProfile: 'auxiliary-quality',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: [
      'rate_limit',
      'overloaded',
      ...DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    ],
    failure: 'propagate_error',
    timeoutMs: 45_000,
  },
  skillImprovement: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 30_000,
  },
  mcpDateTimeParse: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 15_000,
  },
  shellPrefix: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    failure: 'return_null',
    timeoutMs: 15_000,
  },
  verifyConnection: {
    recoveryProfile: 'auxiliary-fast',
    allowActions: ['retry_same_model'],
    switchModelOn: [],
    failure: 'propagate_error',
    timeoutMs: 15_000,
  },
  compact: {
    recoveryProfile: 'auxiliary-quality',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: [
      'rate_limit',
      'overloaded',
      ...DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    ],
    failure: 'propagate_error',
    timeoutMs: 45_000,
  },
  sideQuestion: {
    recoveryProfile: 'auxiliary-quality',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: [
      'rate_limit',
      'overloaded',
      ...DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    ],
    failure: 'propagate_error',
    timeoutMs: 45_000,
  },
  forkedAgent: {
    recoveryProfile: 'auxiliary-quality',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: [
      'rate_limit',
      'overloaded',
      ...DEFAULT_AUXILIARY_SWITCH_MODEL_ON,
    ],
    failure: 'propagate_error',
    timeoutMs: 45_000,
  },
  visionOcr: {
    recoveryProfile: 'auxiliary-vision',
    allowActions: DEFAULT_AUXILIARY_ALLOW_ACTIONS,
    switchModelOn: [
      'rate_limit',
      'overloaded',
      'timeout',
      'connection',
      'server_error',
      'malformed_response',
      'responses_null_output',
    ],
    failure: 'return_null',
    timeoutMs: 45_000,
  },
}

export function normalizeModelRoutingConfig(config: GlobalConfig): GlobalConfig {
  const models = config.models ?? {}
  const modelIds = Object.keys(models)
  if (modelIds.length === 0) {
    return config
  }

  const defaultRoute = config.model?.defaultRoute
  const existingRoutes = config.model?.routes ?? {}

  const routes: Record<string, ModelRouteConfig> = {}
  for (const [routeId, route] of Object.entries(existingRoutes)) {
    routes[routeId] = normalizeRouteConfig(route)
  }

  const auxiliary = normalizeAuxiliaryPolicies(config, models)

  return {
    ...config,
    model: config.model
      ? {
          ...config.model,
          ...(defaultRoute ? { defaultRoute } : {}),
          routes,
        }
      : config.model,
    ...(Object.keys(auxiliary).length > 0 ? { auxiliary } : {}),
  }
}

export function validateModelRoutingConfig(
  config: GlobalConfig,
): RouteValidationIssue[] {
  const issues: RouteValidationIssue[] = []
  const models = config.models ?? {}
  const modelIds = new Set(Object.keys(models))

  const routes = config.model?.routes ?? {}
  if (Object.keys(models).length > 0 && !config.model?.defaultRoute) {
    issues.push({
      path: 'model.defaultRoute',
      message: 'Main route id is required when models are configured.',
    })
  }
  if (config.model?.defaultRoute && !routes[config.model.defaultRoute]) {
    issues.push({
      path: 'model.defaultRoute',
      message: `Route "${config.model.defaultRoute}" is not defined in model.routes.`,
    })
  }

  for (const [routeId, route] of Object.entries(routes)) {
    validateRouteLike(`model.routes.${routeId}`, route, modelIds, issues)
  }

  for (const [task, taskConfig] of Object.entries(config.auxiliary ?? {})) {
    validateRouteLike(`auxiliary.${task}`, taskConfig, modelIds, issues)
    if (
      taskConfig.failure &&
      !VALID_AUXILIARY_FAILURES.has(taskConfig.failure)
    ) {
      issues.push({
        path: `auxiliary.${task}.failure`,
        message: `Invalid auxiliary failure disposition "${taskConfig.failure}".`,
      })
    }
  }

  return issues
}

export function getDefaultRouteIdFromConfig(config: GlobalConfig): string {
  const routeId = normalizeModelRoutingConfig(config).model?.defaultRoute
  if (!routeId) {
    throw new Error(
      'No main model route configured. Set "model.defaultRoute" in ~/.axiomate.json.',
    )
  }
  return routeId
}

export function getMainRouteFromConfig(config: GlobalConfig): ResolvedModelRoute {
  const normalized = normalizeModelRoutingConfig(config)
  const routeId = normalized.model?.defaultRoute
  if (!routeId) {
    throw new Error(
      'No main model route configured. Set "model.defaultRoute" in ~/.axiomate.json.',
    )
  }
  const route = normalized.model?.routes?.[routeId]
  if (!route) {
    throw new Error(
      `No main model route configured. Set "model.defaultRoute" and "model.routes.${routeId}" in ~/.axiomate.json.`,
    )
  }
  return resolveRoute(routeId, route)
}

export function getModelRouteFromConfig(
  config: GlobalConfig,
  routeId: string,
): ResolvedModelRoute | undefined {
  const normalized = normalizeModelRoutingConfig(config)
  const route = normalized.model?.routes?.[routeId]
  return route ? resolveRoute(routeId, route) : undefined
}

export function resolveModelChainFromRoute(
  route: Pick<ResolvedModelRoute, 'primary' | 'fallbackChain'>,
): string[] {
  return uniqueStrings([route.primary, ...asArray(route.fallbackChain)])
}

export function resolveMainModelOverride(
  config: GlobalConfig,
  override: MainModelOverride | undefined,
): ResolvedModelRoute {
  if (!override || override.type === 'default-route') {
    return getMainRouteFromConfig(config)
  }
  if (override.type === 'route') {
    const route = getModelRouteFromConfig(config, override.routeId)
    if (!route) {
      throw new Error(`Model route "${override.routeId}" is not defined.`)
    }
    return route
  }
  if (!config.models?.[override.modelId]) {
    throw new Error(
      `Model "${override.modelId}" is not defined in config.models.`,
    )
  }
  return {
    id: `session:${override.modelId}`,
    primary: override.modelId,
    fallbackChain: [],
    recoveryProfile: 'main-agent',
    allowActions: DEFAULT_MAIN_ALLOW_ACTIONS,
    switchModelOn: DEFAULT_MAIN_SWITCH_MODEL_ON,
  }
}

export function getAuxiliaryTaskPolicyFromConfig(
  config: GlobalConfig,
  task: AuxiliaryTaskId,
): ResolvedAuxiliaryTaskPolicy {
  const normalized = normalizeModelRoutingConfig(config)
  const taskConfig = normalized.auxiliary?.[task]
  if (!taskConfig) {
    const main = getMainRouteFromConfig(normalized)
    return {
      ...main,
      id: String(task),
      task,
      recoveryProfile: 'auxiliary-fast',
      failure: 'return_null',
    }
  }
  const route = resolveRoute(String(task), taskConfig)
  return {
    ...route,
    task,
    failure: taskConfig.failure ?? 'return_null',
    timeoutMs: taskConfig.timeoutMs,
    extraBody: taskConfig.extraBody,
  }
}

function normalizeAuxiliaryPolicies(
  config: GlobalConfig,
  models: Record<string, unknown>,
): Record<string, AuxiliaryTaskConfig> {
  const auxiliary = { ...(config.auxiliary ?? {}) }
  const mainRouteId = config.model?.defaultRoute
  const mainPrimary = mainRouteId
    ? config.model?.routes?.[mainRouteId]?.primary
    : undefined
  const defaultPrimary = validModelOrUndefined(mainPrimary, models)

  for (const [task, defaults] of Object.entries(DEFAULT_AUXILIARY_TASK_POLICIES)) {
    const existing = auxiliary[task]
    if (!existing && !defaultPrimary) {
      continue
    }
    const primary =
      validModelOrUndefined(existing?.primary, models) ??
      (defaults.recoveryProfile === 'auxiliary-vision' && defaultPrimary
        ? findVisionModel(config, defaultPrimary)
        : defaultPrimary)
    if (!primary) {
      continue
    }
    const fallbackChain =
      existing?.fallbackChain != null
        ? uniqueModelIds(asArray(existing.fallbackChain), models).filter(
            candidate => candidate !== primary,
          )
        : defaults.recoveryProfile === 'auxiliary-vision' && defaultPrimary
          ? uniqueModelIds([defaultPrimary], models).filter(
              candidate => candidate !== primary,
            )
          : []

    auxiliary[task] = {
      ...defaults,
      ...existing,
      primary,
      fallbackChain,
    }
  }

  return auxiliary
}

function normalizeRouteConfig(
  route: ModelRouteConfig,
): ModelRouteConfig {
  return {
    ...route,
    fallbackChain: uniqueStrings(asArray(route.fallbackChain)).filter(
      candidate => candidate !== route.primary,
    ),
    allowActions: route.allowActions ?? DEFAULT_MAIN_ALLOW_ACTIONS,
    switchModelOn: route.switchModelOn ?? DEFAULT_MAIN_SWITCH_MODEL_ON,
    recoveryProfile: route.recoveryProfile ?? 'main-agent',
  }
}

function resolveRoute(id: string, route: ModelRouteConfig): ResolvedModelRoute {
  if (!route.primary) {
    throw new Error(`Model route "${id}" has no primary model configured.`)
  }
  return {
    id,
    primary: route.primary,
    fallbackChain: uniqueStrings(asArray(route.fallbackChain)).filter(
      candidate => candidate !== route.primary,
    ),
    recoveryProfile: route.recoveryProfile ?? 'main-agent',
    allowActions: route.allowActions ?? DEFAULT_MAIN_ALLOW_ACTIONS,
    switchModelOn: route.switchModelOn ?? DEFAULT_MAIN_SWITCH_MODEL_ON,
  }
}

function validateRouteLike(
  path: string,
  route: ModelRouteConfig,
  modelIds: Set<string>,
  issues: RouteValidationIssue[],
): void {
  if (!route.primary) {
    issues.push({ path: `${path}.primary`, message: 'Primary model is missing.' })
  } else if (!modelIds.has(route.primary)) {
    issues.push({
      path: `${path}.primary`,
      message: `Model "${route.primary}" is not defined in models.`,
    })
  }

  const seen = new Set<string>()
  if (
    route.fallbackChain !== undefined &&
    !Array.isArray(route.fallbackChain)
  ) {
    issues.push({
      path: `${path}.fallbackChain`,
      message: 'fallbackChain must be an array of model ids.',
    })
    return
  }
  for (const [index, modelId] of asArray(route.fallbackChain).entries()) {
    if (!modelIds.has(modelId)) {
      issues.push({
        path: `${path}.fallbackChain[${index}]`,
        message: `Model "${modelId}" is not defined in models.`,
      })
    }
    if (modelId === route.primary) {
      issues.push({
        path: `${path}.fallbackChain[${index}]`,
        message: `Fallback model "${modelId}" duplicates primary.`,
      })
    }
    if (seen.has(modelId)) {
      issues.push({
        path: `${path}.fallbackChain[${index}]`,
        message: `Fallback model "${modelId}" is duplicated.`,
      })
    }
    seen.add(modelId)
  }

  for (const [index, action] of (route.allowActions ?? []).entries()) {
    if (!VALID_POLICY_ACTIONS.has(action)) {
      issues.push({
        path: `${path}.allowActions[${index}]`,
        message: `Invalid policy action "${action}".`,
      })
    }
  }

  for (const [index, reason] of (route.switchModelOn ?? []).entries()) {
    if (!VALID_SWITCH_REASONS.has(reason)) {
      issues.push({
        path: `${path}.switchModelOn[${index}]`,
        message: `Invalid switch reason "${reason}".`,
      })
    }
  }
}

function findVisionModel(config: GlobalConfig, fallback: string): string {
  const models = config.models ?? {}
  const explicitOcr = validModelOrUndefined('deepseek-ai/DeepSeek-OCR', models)
  if (explicitOcr) return explicitOcr
  const firstVision = Object.entries(models).find(
    ([, modelConfig]) => modelConfig.supportsImages !== false,
  )?.[0]
  return firstVision ?? fallback
}

function validModelOrUndefined<T extends Record<string, unknown>>(
  candidate: string | undefined,
  models: T,
): string | undefined {
  if (!candidate) return undefined
  return Object.prototype.hasOwnProperty.call(models, candidate)
    ? candidate
    : undefined
}

function uniqueModelIds(
  candidates: readonly (string | undefined)[],
  models: Record<string, unknown>,
): string[] {
  return uniqueStrings(
    candidates.filter(
      (candidate): candidate is string =>
        !!candidate && Object.prototype.hasOwnProperty.call(models, candidate),
    ),
  )
}

function uniqueStrings(candidates: readonly string[]): string[] {
  return [...new Set(candidates)]
}

function asArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : []
}
