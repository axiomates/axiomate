/**
 * Beta headers — axiomate does not send any Anthropic beta headers by default.
 * Users can opt-in via the ANTHROPIC_BETAS environment variable.
 *
 * Model capability checks (ISP, context management, etc.) are kept for
 * feature gating in other parts of the codebase.
 */
import memoize from 'lodash-es/memoize.js'
import { getSdkBetas } from '../bootstrap/state.js'
import { BEDROCK_EXTRA_PARAMS_HEADERS } from '../constants/betas.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getAPIProvider } from './model/providers.js'

export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  // Pass through all SDK betas — no allowlist filtering
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }
  return sdkBetas
}

export function modelSupportsISP(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'interleaved_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  return !canonical.includes('claude-3-')
}

export function modelSupportsContextManagement(model: string): boolean {
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('claude-haiku-4')
  )
}

export function modelSupportsStructuredOutputs(model: string): boolean {
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-opus-4-1') ||
    canonical.includes('claude-opus-4-5') ||
    canonical.includes('claude-opus-4-6') ||
    canonical.includes('claude-haiku-4-5')
  )
}

export function modelSupportsAutoMode(_model: string): boolean {
  return false
}

export function getToolSearchBetaHeader(): string {
  return ''
}

export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return false
}

export function shouldUseGlobalCacheScope(): boolean {
  return false
}

/**
 * Returns beta headers for a model. Only includes user-specified betas
 * from ANTHROPIC_BETAS env var — no automatic Anthropic beta headers.
 */
export const getAllModelBetas = memoize((_model: string): string[] => {
  const betaHeaders: string[] = []
  if (process.env.ANTHROPIC_BETAS) {
    betaHeaders.push(
      ...process.env.ANTHROPIC_BETAS.split(',')
        .map(_ => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
})

export const getModelBetas = memoize((model: string): string[] => {
  const modelBetas = getAllModelBetas(model)
  if (getAPIProvider() === 'bedrock') {
    return modelBetas.filter(b => !BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  }
  return modelBetas
})

export const getBedrockExtraBodyParamsBetas = memoize(
  (model: string): string[] => {
    const modelBetas = getAllModelBetas(model)
    return modelBetas.filter(b => BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  },
)

export function getMergedBetas(
  model: string,
  _options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]
  const sdkBetas = getSdkBetas()
  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
  getBedrockExtraBodyParamsBetas.cache?.clear?.()
}
