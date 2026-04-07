/**
 * Provider registry: selects the appropriate LLMProvider for a model
 * by looking up the model in ~/.axiomate.json's "models" configuration.
 *
 * No fallback — every model must be explicitly configured.
 */
import type { LLMProvider } from './provider.js'
import { getGlobalConfig, type ModelProviderConfig } from '../../utils/config.js'
import { AnthropicProvider } from './providers/anthropicProvider.js'
import { getAnthropicClient } from './client.js'
import { calculateUSDCost } from '../../utils/modelCost.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'

// ---------------------------------------------------------------------------
// Provider cache — keyed by protocol:baseUrl to reuse instances
// ---------------------------------------------------------------------------

const providerCache = new Map<string, LLMProvider>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the LLMProvider for the given model.
 *
 * Looks up the model in getGlobalConfig().models. If not found, throws
 * with a clear message telling the user to add it to ~/.axiomate.json.
 */
export function getProviderForModel(model: string): LLMProvider {
  const modelConfig = getGlobalConfig().models?.[model]
  if (!modelConfig) {
    throw new Error(
      `Model '${model}' is not configured. Add it to the "models" section in ~/.axiomate.json.`,
    )
  }

  const cacheKey = `${modelConfig.protocol}:${modelConfig.baseUrl}`
  let provider = providerCache.get(cacheKey)
  if (!provider) {
    provider = createProviderFromConfig(modelConfig)
    providerCache.set(cacheKey, provider)
  }
  return provider
}

/**
 * Clear the provider cache. Used in tests.
 */
export function clearProviderCache(): void {
  providerCache.clear()
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

function createProviderFromConfig(config: ModelProviderConfig): LLMProvider {
  switch (config.protocol) {
    case 'anthropic':
      return new AnthropicProvider({
        getClient: (opts) =>
          getAnthropicClient(
            opts as Parameters<typeof getAnthropicClient>[0],
          ),
        calculateUSDCost: (m, usage) =>
          calculateUSDCost(m, usage as NonNullableUsage),
      })

    case 'openai':
      // OpenAIProvider will be added in Phase 3
      throw new Error(
        `OpenAI protocol support is not yet implemented. Model: ${config.model}`,
      )

    default:
      throw new Error(
        `Unsupported protocol '${(config as { protocol: string }).protocol}' for model '${config.model}'. Supported: 'anthropic', 'openai'.`,
      )
  }
}
