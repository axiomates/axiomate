import {
  getGlobalConfig,
  saveGlobalConfig,
  type GlobalConfig,
} from '../../utils/config.js'
import {
  DEFAULT_ROUTE_ID,
  normalizeModelRoutingConfig,
  resolveModelChainFromRoute,
} from '../../utils/model/modelRouting.js'
import type { AuxiliaryTaskId } from '../../utils/model/modelRouting.js'
import {
  buildAddAuxiliaryFallback,
  buildAddRouteFallback,
  buildCreateRoute,
  buildDeleteRoute,
  buildRemoveAuxiliaryFallback,
  buildRemoveRouteFallback,
  buildRenameRoute,
  buildSetAuxiliaryPolicyField,
  buildSetAuxiliaryPrimary,
  buildSetDefaultRoute,
  buildSetRoutePolicyField,
  buildSetRoutePrimary,
} from '../../utils/model/modelRoutePersistence.js'
import type {
  AuxiliaryFailureDisposition,
  ModelRecoveryPolicyAction,
  ModelSwitchReason,
} from '../../utils/config.js'

export type ModelRouteCommandResult =
  | { handled: false }
  | {
      handled: true
      message: string
      activeModel?: string | null
    }

export function handleModelRouteCommand(
  rawArgs: string,
): ModelRouteCommandResult {
  const args = rawArgs.trim()
  if (!args) {
    return { handled: false }
  }

  const parts = args.split(/\s+/)
  const sub = parts[0]

  try {
    switch (sub) {
      case 'route':
        return handleRouteSubcommand(parts.slice(1))
      case 'use':
        return handleUseSubcommand(parts.slice(1))
      case 'default':
        return handleDefaultSubcommand(parts.slice(1))
      case 'fallback':
        return handleFallbackSubcommand(parts.slice(1))
      case 'aux':
        return handleAuxSubcommand(parts.slice(1))
      default:
        return { handled: false }
    }
  } catch (error) {
    return {
      handled: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function handleRouteSubcommand(parts: string[]): ModelRouteCommandResult {
  const op = parts[0]
  if (!op || op === 'list' || op === 'ls') {
    return {
      handled: true,
      message: renderRoutes(getGlobalConfig()),
    }
  }

  if (op === 'show') {
    const config = getGlobalConfig()
    const routeId =
      parts[1] ??
      normalizeModelRoutingConfig(config).model?.defaultRoute ??
      DEFAULT_ROUTE_ID
    return {
      handled: true,
      message: renderRoute(config, routeId),
    }
  }

  if (op === 'create') {
    const routeId = parts[1]
    const primary = parts.slice(2).join(' ').trim()
    if (!routeId || !primary) {
      return {
        handled: true,
        message: 'Usage: /model route create <route-id> <model-id>',
      }
    }
    const next = buildCreateRoute(getGlobalConfig(), routeId, primary)
    saveGlobalConfig(() => next)
    return {
      handled: true,
      message: `Created route ${routeId} with primary ${primary}`,
    }
  }

  if (op === 'delete' || op === 'rm') {
    const routeId = parts[1]
    if (!routeId) {
      return {
        handled: true,
        message: 'Usage: /model route delete <route-id>',
      }
    }
    const next = buildDeleteRoute(getGlobalConfig(), routeId)
    saveGlobalConfig(() => next)
    return {
      handled: true,
      message: `Deleted route ${routeId}`,
    }
  }

  if (op === 'rename') {
    const fromRouteId = parts[1]
    const toRouteId = parts[2]
    if (!fromRouteId || !toRouteId) {
      return {
        handled: true,
        message: 'Usage: /model route rename <from-route-id> <to-route-id>',
      }
    }
    const next = buildRenameRoute(getGlobalConfig(), fromRouteId, toRouteId)
    saveGlobalConfig(() => next)
    return {
      handled: true,
      message: `Renamed route ${fromRouteId} to ${toRouteId}`,
      activeModel:
        (normalizeModelRoutingConfig(next).model?.defaultRoute ??
          DEFAULT_ROUTE_ID) === toRouteId
          ? getRoutePrimary(next, toRouteId)
          : undefined,
    }
  }

  if (op === 'policy') {
    return handleRoutePolicySubcommand(parts.slice(1))
  }

  const routeId = op
  const next = buildSetDefaultRoute(getGlobalConfig(), routeId)
  saveGlobalConfig(() => next)
  return {
    handled: true,
    message: `Set active model route to ${routeId}`,
    activeModel: getRoutePrimary(next, routeId),
  }
}

function handleRoutePolicySubcommand(
  parts: string[],
): ModelRouteCommandResult {
  const routeId = parts[0]
  const field = parts[1]
  const value = parts.slice(2).join(' ').trim()
  if (!routeId || !field || !value) {
    return {
      handled: true,
      message:
        'Usage: /model route policy <route-id> allowActions|switchModelOn|recoveryProfile <value>',
    }
  }

  let next: GlobalConfig
  if (field === 'allowActions') {
    next = buildSetRoutePolicyField(
      getGlobalConfig(),
      routeId,
      'allowActions',
      parseCsv(value) as ModelRecoveryPolicyAction[],
    )
  } else if (field === 'switchModelOn') {
    next = buildSetRoutePolicyField(
      getGlobalConfig(),
      routeId,
      'switchModelOn',
      parseCsv(value) as ModelSwitchReason[],
    )
  } else if (field === 'recoveryProfile') {
    next = buildSetRoutePolicyField(
      getGlobalConfig(),
      routeId,
      'recoveryProfile',
      value,
    )
  } else {
    return {
      handled: true,
      message:
        'Usage: /model route policy <route-id> allowActions|switchModelOn|recoveryProfile <value>',
    }
  }

  saveGlobalConfig(() => next)
  return {
    handled: true,
    message: `Set route ${routeId} ${field} to ${value}`,
    activeModel: getRoutePrimary(next, routeId),
  }
}

function handleUseSubcommand(parts: string[]): ModelRouteCommandResult {
  const modelId = parts.join(' ').trim()
  if (!modelId) {
    return {
      handled: true,
      message: 'Usage: /model use <model-id>',
    }
  }
  const current = getGlobalConfig()
  const routeId = normalizeModelRoutingConfig(current).model?.defaultRoute ??
    DEFAULT_ROUTE_ID
  const next = buildSetRoutePrimary(current, routeId, modelId)
  saveGlobalConfig(() => next)
  return {
    handled: true,
    message: `Set route ${routeId} primary to ${modelId}`,
    activeModel: modelId,
  }
}

function handleDefaultSubcommand(parts: string[]): ModelRouteCommandResult {
  const routeId = parts[0]
  if (!routeId) {
    return {
      handled: true,
      message: 'Usage: /model default <route-id>',
    }
  }
  const next = buildSetDefaultRoute(getGlobalConfig(), routeId)
  saveGlobalConfig(() => next)
  return {
    handled: true,
    message: `Set default model route to ${routeId}`,
    activeModel: getRoutePrimary(next, routeId),
  }
}

function handleFallbackSubcommand(parts: string[]): ModelRouteCommandResult {
  const op = parts[0] ?? 'list'
  const current = getGlobalConfig()
  const normalized = normalizeModelRoutingConfig(current)
  const routeId = normalized.model?.defaultRoute ?? DEFAULT_ROUTE_ID

  if (op === 'list' || op === 'ls') {
    const route = normalized.model?.routes?.[routeId]
    if (!route) {
      return {
        handled: true,
        message: `Route ${routeId} is not defined.`,
      }
    }
    const chain = resolveModelChainFromRoute({
      primary: route.primary,
      fallbackChain: route.fallbackChain,
    })
    return {
      handled: true,
      message: `Route ${routeId} chain:\n${chain.map((model, index) => `  ${index}. ${model}`).join('\n')}`,
    }
  }

  const modelId = parts.slice(1).join(' ').trim()
  if (!modelId || (op !== 'add' && op !== 'remove' && op !== 'rm')) {
    return {
      handled: true,
      message:
        'Usage: /model fallback list | /model fallback add <model-id> | /model fallback remove <model-id>',
    }
  }

  const next =
    op === 'add'
      ? buildAddRouteFallback(current, routeId, modelId)
      : buildRemoveRouteFallback(current, routeId, modelId)
  saveGlobalConfig(() => next)
  return {
    handled: true,
    message:
      op === 'add'
        ? `Added ${modelId} to route ${routeId} fallback chain`
        : `Removed ${modelId} from route ${routeId} fallback chain`,
    activeModel: getRoutePrimary(next, routeId),
  }
}

function handleAuxSubcommand(parts: string[]): ModelRouteCommandResult {
  const op = parts[0] ?? 'list'
  const current = getGlobalConfig()
  const normalized = normalizeModelRoutingConfig(current)

  if (op === 'list' || op === 'ls') {
    const auxiliary = normalized.auxiliary ?? {}
    const lines = Object.entries(auxiliary)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([task, policy]) => {
        const chain = resolveModelChainFromRoute({
          primary: policy.primary,
          fallbackChain: policy.fallbackChain,
        })
        return `  ${task}: ${chain.join(' -> ')}`
      })
    return {
      handled: true,
      message: lines.length
        ? `Auxiliary model routes:\n${lines.join('\n')}`
        : 'No auxiliary routes configured.',
    }
  }

  if (op === 'show') {
    const task = parts[1]
    if (!task) {
      return {
        handled: true,
        message: 'Usage: /model aux show <task>',
      }
    }
    return {
      handled: true,
      message: renderAuxiliaryTask(current, task),
    }
  }

  if (op === 'fallback') {
    return handleAuxFallbackSubcommand(parts.slice(1))
  }

  if (op === 'policy') {
    return handleAuxPolicySubcommand(parts.slice(1))
  }

  if (op !== 'set') {
    return {
      handled: true,
      message:
        'Usage: /model aux list | /model aux show <task> | /model aux set <task> <model-id> | /model aux fallback ... | /model aux policy ...',
    }
  }

  const task = parts[1] as AuxiliaryTaskId | undefined
  const modelId = parts.slice(2).join(' ').trim()
  if (!task || !modelId) {
    return {
      handled: true,
      message: 'Usage: /model aux set <task> <model-id>',
    }
  }
  const next = buildSetAuxiliaryPrimary(current, task, modelId)
  saveGlobalConfig(() => next)
  return {
    handled: true,
    message: `Set auxiliary ${task} primary to ${modelId}`,
  }
}

function handleAuxFallbackSubcommand(
  parts: string[],
): ModelRouteCommandResult {
  const op = parts[0] ?? 'list'
  const task = parts[1] as AuxiliaryTaskId | undefined
  if (!task) {
    return {
      handled: true,
      message:
        'Usage: /model aux fallback list <task> | /model aux fallback add <task> <model-id> | /model aux fallback remove <task> <model-id>',
    }
  }

  if (op === 'list' || op === 'ls') {
    return {
      handled: true,
      message: renderAuxiliaryTask(getGlobalConfig(), task),
    }
  }

  const modelId = parts.slice(2).join(' ').trim()
  if (!modelId || (op !== 'add' && op !== 'remove' && op !== 'rm')) {
    return {
      handled: true,
      message:
        'Usage: /model aux fallback list <task> | /model aux fallback add <task> <model-id> | /model aux fallback remove <task> <model-id>',
    }
  }

  const next =
    op === 'add'
      ? buildAddAuxiliaryFallback(getGlobalConfig(), task, modelId)
      : buildRemoveAuxiliaryFallback(getGlobalConfig(), task, modelId)
  saveGlobalConfig(() => next)
  return {
    handled: true,
    message:
      op === 'add'
        ? `Added ${modelId} to auxiliary ${task} fallback chain`
        : `Removed ${modelId} from auxiliary ${task} fallback chain`,
  }
}

function handleAuxPolicySubcommand(
  parts: string[],
): ModelRouteCommandResult {
  const task = parts[0] as AuxiliaryTaskId | undefined
  const field = parts[1]
  const rawValue = parts.slice(2).join(' ').trim()
  if (!task || !field || !rawValue) {
    return {
      handled: true,
      message:
        'Usage: /model aux policy <task> failure|timeoutMs|allowActions|switchModelOn|recoveryProfile <value>',
    }
  }

  let next: GlobalConfig
  if (field === 'allowActions') {
    next = buildSetAuxiliaryPolicyField(
      getGlobalConfig(),
      task,
      'allowActions',
      parseCsv(rawValue) as ModelRecoveryPolicyAction[],
    )
  } else if (field === 'switchModelOn') {
    next = buildSetAuxiliaryPolicyField(
      getGlobalConfig(),
      task,
      'switchModelOn',
      parseCsv(rawValue) as ModelSwitchReason[],
    )
  } else if (field === 'recoveryProfile') {
    next = buildSetAuxiliaryPolicyField(
      getGlobalConfig(),
      task,
      'recoveryProfile',
      rawValue,
    )
  } else if (field === 'failure') {
    next = buildSetAuxiliaryPolicyField(
      getGlobalConfig(),
      task,
      'failure',
      rawValue as AuxiliaryFailureDisposition,
    )
  } else if (field === 'timeoutMs') {
    const timeoutMs = Number(rawValue)
    if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 0) {
      return {
        handled: true,
        message: 'timeoutMs must be a non-negative integer.',
      }
    }
    next = buildSetAuxiliaryPolicyField(
      getGlobalConfig(),
      task,
      'timeoutMs',
      timeoutMs,
    )
  } else {
    return {
      handled: true,
      message:
        'Usage: /model aux policy <task> failure|timeoutMs|allowActions|switchModelOn|recoveryProfile <value>',
    }
  }

  saveGlobalConfig(() => next)
  return {
    handled: true,
    message: `Set auxiliary ${task} ${field} to ${rawValue}`,
  }
}

function renderRoutes(config: GlobalConfig): string {
  const normalized = normalizeModelRoutingConfig(config)
  const defaultRoute = normalized.model?.defaultRoute ?? DEFAULT_ROUTE_ID
  const routes = normalized.model?.routes ?? {}
  const routeBlocks = Object.entries(routes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([routeId, route]) => {
      const marker = routeId === defaultRoute ? '*' : ' '
      const chain = resolveModelChainFromRoute({
        primary: route.primary,
        fallbackChain: route.fallbackChain,
      })
      const chainLines = chain.map((model, index) => {
        const prefix = index === 0 ? 'primary' : `fallback ${index}`
        return `    ${prefix}: ${model}`
      })
      return [`${marker} ${routeId}`, ...chainLines].join('\n')
    })

  return routeBlocks.length
    ? `Model routes (* = default):\n\n${routeBlocks.join('\n\n')}`
    : 'No model routes configured.'
}

function renderRoute(config: GlobalConfig, routeId: string): string {
  const normalized = normalizeModelRoutingConfig(config)
  const route = normalized.model?.routes?.[routeId]
  if (!route) {
    return `Route ${routeId} is not defined.`
  }
  const chain = resolveModelChainFromRoute({
    primary: route.primary,
    fallbackChain: route.fallbackChain,
  })
  return [
    `Route ${routeId}:`,
    `  chain: ${chain.join(' -> ')}`,
    `  recoveryProfile: ${route.recoveryProfile ?? 'main-agent'}`,
    `  allowActions: ${(route.allowActions ?? []).join(', ')}`,
    `  switchModelOn: ${(route.switchModelOn ?? []).join(', ')}`,
  ].join('\n')
}

function renderAuxiliaryTask(config: GlobalConfig, task: string): string {
  const normalized = normalizeModelRoutingConfig(config)
  const policy = normalized.auxiliary?.[task]
  if (!policy) {
    return `Auxiliary task ${task} is not defined.`
  }
  const chain = resolveModelChainFromRoute({
    primary: policy.primary,
    fallbackChain: policy.fallbackChain,
  })
  return [
    `Auxiliary ${task}:`,
    `  chain: ${chain.join(' -> ')}`,
    `  recoveryProfile: ${policy.recoveryProfile ?? 'auxiliary-fast'}`,
    `  failure: ${policy.failure ?? 'return_null'}`,
    `  timeoutMs: ${policy.timeoutMs ?? '(default)'}`,
    `  allowActions: ${(policy.allowActions ?? []).join(', ')}`,
    `  switchModelOn: ${(policy.switchModelOn ?? []).join(', ')}`,
  ].join('\n')
}

function getRoutePrimary(config: GlobalConfig, routeId: string): string | null {
  const normalized = normalizeModelRoutingConfig(config)
  return normalized.model?.routes?.[routeId]?.primary ?? null
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}
