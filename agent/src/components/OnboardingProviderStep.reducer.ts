/**
 * Pure state-machine for the onboarding provider-setup sub-wizard.
 *
 * Split from OnboardingProviderStep.tsx so tests can exercise the reducer
 * without pulling in the LLM / provider registry / ink render chain.
 */

import {
  getBuiltinTemplates,
  resolveTemplate,
  type Protocol,
  type VendorTemplate,
} from '../services/api/vendorTemplates.js'

export type { Protocol }

// Protocol is re-exported above from vendorTemplates.js for the wizard to
// use; both layers must agree on the same string union.

export type Stage =
  | 'protocol'
  | 'baseUrl'
  | 'apiKey'
  | 'modelId'
  | 'contextWindow'
  | 'supportsImages'
  | 'vendor'
  | 'createTemplate'
  | 'thinking'
  | 'userAgent'
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
  if (!vendor || vendor === 'auto') {
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
  const tiers: ThinkingChoice[] = (
    ['low', 'medium', 'high', 'max'] as const
  ).filter(t => t in valueMap)
  return ['off', ...tiers]
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
 * Vendor templates whose `protocols` array includes the given protocol —
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
      return resolveTemplate(name, customTemplates).protocols.includes(protocol)
    } catch {
      return false
    }
  })
}

/**
 * Whether to skip the vendor stage in onboarding for this protocol.
 * Skips when there's exactly one matching vendor (so picking it adds no
 * information). Computed dynamically from the current template registry,
 * so adding a custom template later un-skips the stage automatically.
 */
export function shouldSkipVendorStage(
  protocol: Protocol,
  customTemplates?: Record<string, VendorTemplate>,
): boolean {
  return getVendorChoicesForProtocol(protocol, customTemplates).length === 1
}


export type OnboardingProviderState = {
  stage: Stage
  protocol: Protocol
  baseUrl: string
  apiKey: string
  modelId: string
  contextWindow: number
  /** Whether this model accepts image input. Default: true. */
  supportsImages: boolean
  /**
   * Vendor template name. 'auto' = let inferVendor decide (don't write the
   * field). Otherwise writes `vendor: <name>` into the model entry.
   */
  vendor: string
  /** Thinking preference for this model. 'off' = field is omitted from config. */
  thinking: ThinkingChoice
  /**
   * Override for the HTTP User-Agent header sent by the OpenAI SDK.
   * Empty string means "do not write the field" — keep the SDK default UA.
   */
  userAgent: string
  /** Present only when stage === 'verifyFailed' or contextWindow parse failed */
  error?: string
}

export type OnboardingProviderAction =
  | { type: 'pickProtocol'; protocol: Protocol }
  | { type: 'submitBaseUrl'; value: string }
  | { type: 'submitApiKey'; value: string }
  | { type: 'submitModelId'; value: string }
  | { type: 'submitContextWindow'; value: string }
  | { type: 'submitSupportsImages'; value: boolean; nextStage: 'vendor' | 'thinking' }
  | { type: 'submitVendor'; value: string; nextThinking: ThinkingChoice }
  | { type: 'startCreateTemplate' }
  | { type: 'finishCreateTemplate'; templateName: string; nextThinking: ThinkingChoice }
  | { type: 'cancelCreateTemplate' }
  | { type: 'submitThinking'; value: ThinkingChoice }
  | { type: 'submitUserAgent'; value: string }
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
  "Model's context window in tokens (e.g., 200000 for 200K, 1000000 for 1M). Defaults to 32000 if empty."

export const USER_AGENT_HINT =
  "Override HTTP User-Agent. Leave empty to keep the SDK default — only set this if your provider blocks the OpenAI SDK's UA (some Responses gateways do). Example: codex_cli_rs/0.50.0"

export const THINKING_HINT =
  "Reasoning depth for this model. 'Off' is safe for any model. Pick a level for reasoning models (o-series, Claude extended thinking, DeepSeek V4, Qwen3 thinking). axiomate translates to the right wire param via the vendor template."

export const DEFAULT_CONTEXT_WINDOW_VALUE = 32_000
const MIN_CONTEXT_WINDOW = 1024

export const initialOnboardingProviderState: OnboardingProviderState = {
  stage: 'protocol',
  protocol: 'openai-chat',
  baseUrl: '',
  apiKey: '',
  modelId: '',
  contextWindow: DEFAULT_CONTEXT_WINDOW_VALUE,
  supportsImages: true,
  vendor: 'auto',
  thinking: 'off',
  userAgent: '',
}

/**
 * Parse the user's context-window input. Empty string → default.
 * Returns null if the value is non-numeric or below the sane floor.
 */
export function parseContextWindowInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return DEFAULT_CONTEXT_WINDOW_VALUE
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null
  if (parsed < MIN_CONTEXT_WINDOW) return null
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
        baseUrl: state.baseUrl || DEFAULT_BASE_URLS[action.protocol],
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
        stage: 'supportsImages',
        contextWindow: parsed,
        error: undefined,
      }
    }
    case 'submitSupportsImages':
      return {
        ...state,
        stage: action.nextStage,
        supportsImages: action.value,
        // When the dispatcher told us to skip vendor (only one vendor fits
        // the protocol), 'auto' is the right placeholder — inferVendor at
        // request time will resolve to the same single candidate anyway.
        ...(action.nextStage === 'thinking' ? { vendor: 'auto' } : {}),
        error: undefined,
      }
    case 'submitVendor':
      return {
        ...state,
        stage: 'thinking',
        vendor: action.value,
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
        stage: 'thinking',
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
        stage: 'verifying',
        userAgent: action.value.trim(),
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
    case 'supportsImages':
      return 'contextWindow'
    case 'vendor':
      return 'supportsImages'
    case 'createTemplate':
      return 'vendor'
    case 'thinking':
      // When the vendor stage was skipped (single matching vendor for the
      // current protocol), back from thinking jumps straight to supportsImages.
      return skipVendor ? 'supportsImages' : 'vendor'
    case 'userAgent':
      return 'thinking'
    case 'verifying':
    case 'verifyFailed':
      return 'userAgent'
  }
}

/** Shape of the `models[modelId]` entry persisted to ~/.axiomate.json. */
export function buildModelConfig(state: OnboardingProviderState) {
  // Only emit non-default fields so the persisted JSON stays minimal.
  const ua = state.userAgent.trim()
  const thinking =
    state.thinking === 'off'
      ? undefined
      : { enabled: true, effort: state.thinking }
  const vendorField =
    state.vendor && state.vendor !== 'auto' ? { vendor: state.vendor } : {}
  return {
    model: state.modelId,
    name: state.modelId,
    protocol: state.protocol,
    baseUrl: state.baseUrl,
    apiKey: state.apiKey,
    contextWindow: state.contextWindow,
    ...(state.supportsImages ? {} : { supportsImages: false }),
    ...vendorField,
    ...(thinking ? { thinking } : {}),
    ...(ua ? { userAgent: ua } : {}),
  }
}
