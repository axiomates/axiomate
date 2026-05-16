/**
 * Pure state-machine for the onboarding provider-setup sub-wizard.
 *
 * Split from OnboardingProviderStep.tsx so tests can exercise the reducer
 * without pulling in the LLM / provider registry / ink render chain.
 */

export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic'

export type Stage =
  | 'protocol'
  | 'baseUrl'
  | 'apiKey'
  | 'modelId'
  | 'contextWindow'
  | 'supportsImages'
  | 'thinking'
  | 'userAgent'
  | 'verifying'
  | 'verifyFailed'

/** Wizard's neutral thinking choice. Maps to ThinkingDecl in buildModelConfig. */
export type ThinkingChoice = 'off' | 'low' | 'medium' | 'high' | 'max'

export type OnboardingProviderState = {
  stage: Stage
  protocol: Protocol
  baseUrl: string
  apiKey: string
  modelId: string
  contextWindow: number
  /** Whether this model accepts image input. Default: true. */
  supportsImages: boolean
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
  | { type: 'submitSupportsImages'; value: boolean }
  | { type: 'submitThinking'; value: ThinkingChoice }
  | { type: 'submitUserAgent'; value: string }
  | { type: 'verifyFail'; error: string }
  | { type: 'retryFromApiKey' }
  | { type: 'back' }

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
        stage: 'thinking',
        supportsImages: action.value,
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
      return { ...state, stage: previousStage(state.stage), error: undefined }
  }
}

function previousStage(stage: Stage): Stage {
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
    case 'thinking':
      return 'supportsImages'
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
  return {
    model: state.modelId,
    name: state.modelId,
    protocol: state.protocol,
    baseUrl: state.baseUrl,
    apiKey: state.apiKey,
    contextWindow: state.contextWindow,
    ...(state.supportsImages ? {} : { supportsImages: false }),
    ...(thinking ? { thinking } : {}),
    ...(ua ? { userAgent: ua } : {}),
  }
}
