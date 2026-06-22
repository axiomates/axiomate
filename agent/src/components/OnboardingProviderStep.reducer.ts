/**
 * Pure state-machine for the onboarding provider-setup sub-wizard.
 *
 * Split from OnboardingProviderStep.tsx so tests can exercise the reducer
 * without pulling in the LLM / provider registry / ink render chain.
 */

import {
  getMatchingModelTemplates,
  getBuiltinTemplates,
  inferVendor,
  resolveStack,
  resolveTemplate,
  type ModelTemplate,
  type Protocol,
  type VendorTemplate,
} from '../services/api/vendorTemplates.js'
import type { GlobalConfig } from '../utils/config.js'
import { fuzzyMatchContextWindow } from '../utils/model/contextWindowFuzzy.js'
import {
  buildAddRouteFallback,
  buildSinglePrimaryMainRoute,
} from '../utils/model/modelRoutePersistence.js'
import { fuzzyMatchMaxOutputTokens } from '../utils/model/maxOutputTokensFuzzy.js'

export type { Protocol }

// Protocol is re-exported above from vendorTemplates.js for the wizard to
// use; both layers must agree on the same string union.

export type Stage =
  | 'protocol'
  | 'baseUrl'
  | 'apiKey'
  | 'modelId'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'supportsImages'
  | 'vendor'
  | 'modelTemplate'
  | 'createTemplate'
  | 'thinking'
  | 'userAgent'
  | 'routeUsage'
  | 'verifying'
  | 'verifyFailed'

/**
 * Wizard's neutral thinking choice. Maps to ThinkingDecl in buildModelConfig.
 *
 * Note the asymmetry vs runtime EffortLevel ('none' | 'low' | ... | 'max'):
 *
 *   wizard 'off'     → buildModelConfig writes `thinking: undefined`,
 *                      i.e. the field is OMITTED from the model entry.
 *                      Result: modelSupportsEffort()=false, ModelPicker
 *                      hides the effort row entirely. The model is
 *                      outside the effort/thinking system altogether.
 *
 *   runtime 'none'   → ModelPicker selects this when effort is in the
 *                      cyclable set; applyThinkingTemplate emits
 *                      disabledPatch (e.g. enable_thinking: false). The
 *                      model IS in the effort system but thinking is
 *                      disabled for this turn.
 *
 * Both result in "no thinking" but via different mechanisms. We do NOT
 * expose 'none' in the wizard because "set up a thinking-capable model
 * but default it to off" is reachable only by hand-editing the config,
 * and is reserved for advanced use (the use case is "this model can
 * think but I want token-savings by default; let me cycle on when I need it").
 */
export type ThinkingChoice = 'off' | 'low' | 'medium' | 'high' | 'max'
export type RouteUsageChoice = 'main_primary' | 'main_fallback' | 'models_only'
export type OnboardingRouteUsageResult =
  | { type: 'main_primary'; modelId: string; routeId: string }
  | { type: 'main_fallback'; modelId: string; routeId: string }
  | { type: 'models_only'; modelId: string }

export type OnboardingProviderConfigUpdate = {
  config: GlobalConfig
  result: OnboardingRouteUsageResult
}

/**
 * Returns the thinking choices the wizard should offer for a given vendor.
 * 'off' is always present (it means "don't write any thinking field").
 * The other tiers are filtered by the resolved vendor template's
 * effort.valueMap — vendors that only accept high/max won't expose low/medium.
 *
 * Falls back to all 5 choices if the vendor name can't be resolved (e.g.
 * 'auto' before inferVendor runs, or an unknown custom template).
 */
export function getThinkingChoicesForVendor(
  vendor: string | undefined,
  customTemplates?: Record<string, VendorTemplate>,
): ThinkingChoice[] {
  if (!vendor || vendor === 'auto' || vendor === 'none') {
    // 'auto'/undefined: vendor not yet resolved → offer all tiers (the stack
    // pass refines later). 'none': bare protocol layer, which for our two
    // openai protocols still carries the full effort domain.
    return ['off', 'low', 'medium', 'high', 'max']
  }
  let template: VendorTemplate
  try {
    template = resolveTemplate(vendor, customTemplates)
  } catch {
    return ['off', 'low', 'medium', 'high', 'max']
  }
  if (!template.effort) return ['off']
  const valueMap = template.effort.valueMap
  if (!valueMap) return ['off', 'low', 'medium', 'high', 'max']
  // RFC 7396: a `null` valueMap entry means "this tier was deleted by an
  // overlay layer" — treat it as not-cyclable just like a missing key.
  const tiers: ThinkingChoice[] = (
    ['low', 'medium', 'high', 'max'] as const
  ).filter(
    t => t in valueMap && (valueMap as Record<string, unknown>)[t] !== null,
  )
  return ['off', ...tiers]
}

export function getThinkingChoicesForStack(
  input: {
    protocol: Protocol
    baseUrl: string
    modelId: string
    vendor: string
    modelTemplate: string
  },
  customVendors?: Record<string, VendorTemplate>,
  customModels?: Record<string, ModelTemplate>,
): ThinkingChoice[] {
  // Pass the wizard's raw trichotomy values straight through — resolveStack
  // interprets 'auto'/'none'/<name> for both fields natively.
  try {
    const template = resolveStack({
      protocol: input.protocol,
      vendor: input.vendor,
      modelTemplate: input.modelTemplate,
      model: input.modelId,
      baseUrl: input.baseUrl,
      customVendors,
      customModels,
    })
    if (!template.effort) return ['off']
    const valueMap = template.effort.valueMap
    if (!valueMap) return ['off', 'low', 'medium', 'high', 'max']
    const tiers: ThinkingChoice[] = (
      ['low', 'medium', 'high', 'max'] as const
    ).filter(
      t => t in valueMap && (valueMap as Record<string, unknown>)[t] !== null,
    )
    return ['off', ...tiers]
  } catch {
    return getThinkingChoicesForVendor(input.vendor, customVendors)
  }
}

/** Returns true iff the wizard's thinking choice is offerable for this vendor. */
export function isThinkingChoiceSupported(
  choice: ThinkingChoice,
  vendor: string | undefined,
  customTemplates?: Record<string, VendorTemplate>,
): boolean {
  return getThinkingChoicesForVendor(vendor, customTemplates).includes(choice)
}

/**
 * Vendor templates whose resolved `protocol` matches the given protocol —
 * the candidates the wizard would show on the vendor stage. Considers both
 * built-ins and user-defined custom templates so the count adapts as the
 * user adds custom templates over time.
 */
export function getVendorChoicesForProtocol(
  protocol: Protocol,
  customTemplates?: Record<string, VendorTemplate>,
): string[] {
  const allNames = [
    ...Object.keys(getBuiltinTemplates()),
    ...Object.keys(customTemplates ?? {}),
  ]
  return allNames.filter(name => {
    try {
      const tpl = resolveTemplate(name, customTemplates)
      if (tpl.protocol === undefined) return true
      return tpl.protocol === protocol
    } catch {
      return false
    }
  })
}

/**
 * Whether to skip the vendor stage in onboarding for this protocol.
 * Skips when there are no real vendors to pick from — for vanilla
 * protocols (anthropic, openai-responses) without any custom templates
 * yet, leaving vendor unset (i.e. 'auto' → protocol layer alone) is
 * the only meaningful answer.
 */
export function shouldSkipVendorStage(
  protocol: Protocol,
  customTemplates?: Record<string, VendorTemplate>,
): boolean {
  return getVendorChoicesForProtocol(protocol, customTemplates).length === 0
}

export function getRecommendedModelTemplate(
  input: {
    protocol: Protocol
    baseUrl: string
    modelId: string
    vendor: string
  },
  customVendors?: Record<string, VendorTemplate>,
  customModels?: Parameters<typeof getMatchingModelTemplates>[3],
): string | undefined {
  const vendorName =
    input.vendor && input.vendor !== 'auto'
      ? input.vendor
      : inferVendor(
          {
            protocol: input.protocol,
            model: input.modelId,
            baseUrl: input.baseUrl,
          },
          customVendors,
        )
  return getMatchingModelTemplates(
    input.modelId,
    vendorName,
    input.protocol,
    customModels,
    input.baseUrl,
  )[0]
}


export type OnboardingProviderState = {
  stage: Stage
  protocol: Protocol
  baseUrl: string
  apiKey: string
  modelId: string
  contextWindow?: number
  maxOutputTokens?: number
  /** Whether this model accepts image input. Default: false. */
  supportsImages: boolean
  /**
   * Vendor template, three-valued: 'auto' (default — inferVendor by baseUrl,
   * field omitted from config), 'none' (bare protocol layer), or an explicit
   * name. 'auto' is omitted on persist; 'none'/<name> are written.
   */
  vendor: string
  /**
   * Model template, three-valued: 'auto' (default — smart match by model name
   * + vendor, field omitted from config), 'none' (no model layer), or an
   * explicit name. 'auto' is omitted on persist; 'none'/<name> are written.
   */
  modelTemplate: string
  /** Thinking preference for this model. 'off' = field is omitted from config. */
  thinking: ThinkingChoice
  /**
   * Override for the HTTP User-Agent header sent by the OpenAI SDK.
   * Empty string means "do not write the field" — keep the SDK default UA.
   */
  userAgent: string
  routeUsage: RouteUsageChoice
  /** Present only when stage === 'verifyFailed' or contextWindow parse failed */
  error?: string
}

export type OnboardingProviderAction =
  | { type: 'pickProtocol'; protocol: Protocol }
  | { type: 'submitBaseUrl'; value: string }
  | { type: 'submitApiKey'; value: string }
  | { type: 'submitModelId'; value: string }
  | { type: 'submitContextWindow'; value: string }
  | { type: 'submitMaxOutputTokens'; value: string }
  | { type: 'submitSupportsImages'; value: boolean; nextStage: 'vendor' | 'modelTemplate' }
  | { type: 'submitVendor'; value: string; nextThinking: ThinkingChoice }
  | { type: 'submitModelTemplate'; value: string; nextThinking: ThinkingChoice }
  | { type: 'startCreateTemplate' }
  | { type: 'finishCreateTemplate'; templateName: string; nextThinking: ThinkingChoice }
  | { type: 'cancelCreateTemplate' }
  | { type: 'submitThinking'; value: ThinkingChoice }
  | {
      type: 'submitUserAgent'
      value: string
      nextStage?: 'routeUsage' | 'verifying'
      routeUsage?: RouteUsageChoice
    }
  | { type: 'submitRouteUsage'; value: RouteUsageChoice }
  | { type: 'verifyFail'; error: string }
  | { type: 'retryFromApiKey' }
  | { type: 'back'; skipVendor?: boolean }

export const DEFAULT_BASE_URLS: Record<Protocol, string> = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
}

export const MODEL_ID_HINT: Record<Protocol, string> = {
  'openai-chat':
    'e.g., gpt-4o  or  qwen/qwen3-235b (OpenRouter)  or  Qwen/Qwen3-235B (SiliconFlow)',
  'openai-responses':
    'e.g., gpt-5, o4-mini, o3 (OpenAI Responses API — preferred for reasoning models)',
  anthropic: 'e.g., Qwen/Qwen3.6-Plus',
}

export const CONTEXT_WINDOW_HINT =
  "Model's context window in tokens (e.g., 200000 for 200K, 1000000 for 1M). A recognized model ID is prefilled; empty leaves the config unset."

export const MAX_OUTPUT_TOKENS_HINT =
  "Maximum tokens the model may generate in one response. A recognized model ID is prefilled; empty leaves the config unset."

export const USER_AGENT_HINT =
  "Override HTTP User-Agent. Leave empty to keep the SDK default — only set this if your provider blocks the OpenAI SDK's UA (some Responses gateways do). Example: codex_cli_rs/0.50.0"

export const THINKING_HINT =
  "Reasoning depth for this model. 'Off' is safe for any model. Pick a level for reasoning models (o-series, Claude extended thinking, DeepSeek V4, Qwen3 thinking). axiomate translates to the right wire param via the vendor template."

export const MODEL_TEMPLATE_HINT =
  'Model-specific overlay. Auto smart-matches by model name + vendor (recommended). Pick an explicit template to pin one, or None to apply only protocol/vendor rules.'

export const ROUTE_USAGE_HINT =
  'Choose where this model is used. Recovery decisions still come from the API recovery engine; route policy only supplies model candidates.'

const MIN_CONTEXT_WINDOW = 1024
const MIN_MAX_OUTPUT_TOKENS = 1

export const initialOnboardingProviderState: OnboardingProviderState = {
  stage: 'protocol',
  protocol: 'openai-chat',
  baseUrl: '',
  apiKey: '',
  modelId: '',
  contextWindow: undefined,
  maxOutputTokens: undefined,
  supportsImages: false,
  vendor: 'auto',
  modelTemplate: 'auto',
  thinking: 'off',
  userAgent: '',
  routeUsage: 'main_primary',
}

export function shouldAskRouteUsage(current: GlobalConfig): boolean {
  const routeId = current.model?.defaultRoute
  return !!routeId && !!current.model?.routes?.[routeId]?.primary
}

/**
 * Parse the user's context-window input. Empty string → undefined (do not
 * write contextWindow to config).
 * Returns null if the value is non-numeric or below the sane floor.
 */
export function parseContextWindowInput(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null
  if (parsed < MIN_CONTEXT_WINDOW) return null
  return parsed
}

/**
 * Parse the user's max-output input. Empty string → undefined (do not write
 * maxOutputTokens to config).
 * Returns null if the value is non-numeric or below the sane floor.
 */
export function parseMaxOutputTokensInput(
  raw: string,
): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null
  if (parsed < MIN_MAX_OUTPUT_TOKENS) return null
  return parsed
}

export function onboardingProviderReducer(
  state: OnboardingProviderState,
  action: OnboardingProviderAction,
): OnboardingProviderState {
  switch (action.type) {
    case 'pickProtocol':
      return {
        ...state,
        stage: 'baseUrl',
        protocol: action.protocol,
        baseUrl: state.baseUrl,
      }
    case 'submitBaseUrl':
      return { ...state, stage: 'apiKey', baseUrl: action.value.trim() }
    case 'submitApiKey':
      return {
        ...state,
        stage: 'modelId',
        apiKey: action.value,
        error: undefined,
      }
    case 'submitModelId':
      return {
        ...state,
        stage: 'contextWindow',
        modelId: action.value.trim(),
        contextWindow: fuzzyMatchContextWindow(action.value.trim()),
        maxOutputTokens: fuzzyMatchMaxOutputTokens(action.value.trim()),
        error: undefined,
      }
    case 'submitContextWindow': {
      const parsed = parseContextWindowInput(action.value)
      if (parsed === null) {
        return {
          ...state,
          error: `Expected positive integer >= ${MIN_CONTEXT_WINDOW}`,
        }
      }
      return {
        ...state,
        stage: 'maxOutputTokens',
        contextWindow: parsed,
        error: undefined,
      }
    }
    case 'submitMaxOutputTokens': {
      const parsed = parseMaxOutputTokensInput(action.value)
      if (parsed === null) {
        return {
          ...state,
          error: `Expected positive integer >= ${MIN_MAX_OUTPUT_TOKENS}`,
        }
      }
      return {
        ...state,
        stage: 'supportsImages',
        maxOutputTokens: parsed,
        error: undefined,
      }
    }
    case 'submitSupportsImages':
      return {
        ...state,
        stage: action.nextStage,
        supportsImages: action.value,
        // When the dispatcher told us to skip vendor (only one vendor fits
        // the protocol), 'auto' is the right placeholder. It leaves runtime
        // vendor resolution to protocol/baseUrl inference.
        ...(action.nextStage === 'modelTemplate' ? { vendor: 'auto' } : {}),
        error: undefined,
      }
    case 'submitVendor':
      return {
        ...state,
        stage: 'modelTemplate',
        vendor: action.value,
        thinking: action.nextThinking,
        error: undefined,
      }
    case 'submitModelTemplate':
      return {
        ...state,
        stage: 'thinking',
        modelTemplate: action.value,
        thinking: action.nextThinking,
        error: undefined,
      }
    case 'startCreateTemplate':
      return {
        ...state,
        stage: 'createTemplate',
        error: undefined,
      }
    case 'finishCreateTemplate':
      return {
        ...state,
        stage: 'modelTemplate',
        vendor: action.templateName,
        thinking: action.nextThinking,
        error: undefined,
      }
    case 'cancelCreateTemplate':
      return {
        ...state,
        stage: 'vendor',
        error: undefined,
      }
    case 'submitThinking':
      return {
        ...state,
        stage: 'userAgent',
        thinking: action.value,
        error: undefined,
      }
    case 'submitUserAgent':
      return {
        ...state,
        stage: action.nextStage ?? 'verifying',
        userAgent: action.value.trim(),
        routeUsage: action.routeUsage ?? state.routeUsage,
        error: undefined,
      }
    case 'submitRouteUsage':
      return {
        ...state,
        stage: 'verifying',
        routeUsage: action.value,
        error: undefined,
      }
    case 'verifyFail':
      return { ...state, stage: 'verifyFailed', error: action.error }
    case 'retryFromApiKey':
      return { ...state, stage: 'apiKey', error: undefined }
    case 'back':
      return {
        ...state,
        stage: previousStage(state.stage, action.skipVendor),
        error: undefined,
      }
  }
}

function previousStage(stage: Stage, skipVendor?: boolean): Stage {
  switch (stage) {
    case 'protocol':
      return 'protocol' // Parent handles cancel-from-protocol
    case 'baseUrl':
      return 'protocol'
    case 'apiKey':
      return 'baseUrl'
    case 'modelId':
      return 'apiKey'
    case 'contextWindow':
      return 'modelId'
    case 'maxOutputTokens':
      return 'contextWindow'
    case 'supportsImages':
      return 'maxOutputTokens'
    case 'vendor':
      return 'supportsImages'
    case 'modelTemplate':
      return skipVendor ? 'supportsImages' : 'vendor'
    case 'createTemplate':
      return 'vendor'
    case 'thinking':
      return 'modelTemplate'
    case 'userAgent':
      return 'thinking'
    case 'routeUsage':
      return 'userAgent'
    case 'verifying':
    case 'verifyFailed':
      return 'userAgent'
  }
}

/** Shape of the `models[modelId]` entry persisted to ~/.axiomate.json. */
export function buildModelConfig(state: OnboardingProviderState) {
  // Omit auto-derived template fields while preserving explicit wizard choices.
  const ua = state.userAgent.trim()
  const thinking =
    state.thinking === 'off'
      ? undefined
      : { enabled: true, effort: state.thinking }
  // 'auto' is the default for both fields (undefined === auto in resolveStack),
  // so omit it to keep JSON minimal. 'none' and explicit names are written.
  const vendorField =
    state.vendor && state.vendor !== 'auto' ? { vendor: state.vendor } : {}
  const modelTemplateField =
    state.modelTemplate && state.modelTemplate !== 'auto'
      ? { modelTemplate: state.modelTemplate }
      : {}
  return {
    model: state.modelId,
    name: state.modelId,
    protocol: state.protocol,
    baseUrl: state.baseUrl,
    apiKey: state.apiKey,
    ...(state.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
    ...(state.maxOutputTokens !== undefined ? { maxOutputTokens: state.maxOutputTokens } : {}),
    supportsImages: state.supportsImages,
    ...vendorField,
    ...modelTemplateField,
    ...(thinking ? { thinking } : {}),
    ...(ua ? { userAgent: ua } : {}),
  }
}

export function buildOnboardingProviderConfigUpdate(
  current: GlobalConfig,
  state: OnboardingProviderState,
): GlobalConfig {
  return buildOnboardingProviderConfigUpdateResult(current, state).config
}

export function buildOnboardingProviderConfigUpdateResult(
  current: GlobalConfig,
  state: OnboardingProviderState,
): OnboardingProviderConfigUpdate {
  const withModel: GlobalConfig = {
    ...current,
    models: {
      ...(current.models ?? {}),
      [state.modelId]: buildModelConfig(state),
    },
  }

  switch (state.routeUsage) {
    case 'main_primary': {
      const next = buildSinglePrimaryMainRoute(withModel, state.modelId)
      return {
        config: next,
        result: {
          type: 'main_primary',
          modelId: state.modelId,
          routeId: getDefaultRouteId(next),
        },
      }
    }
    case 'main_fallback': {
      const routeId = requireDefaultRouteId(withModel)
      const next = buildAddRouteFallback(withModel, routeId, state.modelId)
      return {
        config: next,
        result: {
          type: 'main_fallback',
          modelId: state.modelId,
          routeId,
        },
      }
    }
    case 'models_only':
      requireDefaultRouteId(withModel)
      return {
        config: withModel,
        result: { type: 'models_only', modelId: state.modelId },
      }
  }
}

function getDefaultRouteId(config: GlobalConfig): string {
  return requireDefaultRouteId(config)
}

function requireDefaultRouteId(config: GlobalConfig): string {
  const routeId = config.model?.defaultRoute
  if (!routeId || !config.model?.routes?.[routeId]) {
    throw new Error(
      'Cannot add a fallback/model-only entry before a main model route exists.',
    )
  }
  return routeId
}
