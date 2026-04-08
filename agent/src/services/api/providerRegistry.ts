/**
 * Provider registry: selects the appropriate LLMProvider for a model
 * by looking up the model in ~/.axiomate.json's "models" configuration.
 *
 * No fallback — every model must be explicitly configured.
 */
import type { LLMProvider } from './provider.js'
import { getGlobalConfig, type ModelProviderConfig } from '../../utils/config.js'
import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from './providers/anthropicProvider.js'
import { OpenAIProvider } from './providers/openaiProvider.js'
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
      `Model '${model}' is not configured.\n\n` +
      `Add it to ~/.axiomate.json:\n\n` +
      `  "models": {\n` +
      `    "${model}": {\n` +
      `      "model": "${model}",\n` +
      `      "protocol": "openai",\n` +
      `      "baseUrl": "https://your-api-provider.com/v1",\n` +
      `      "apiKey": "sk-..."\n` +
      `    }\n` +
      `  },\n` +
      `  "currentModel": "${model}"`,
    )
  }

  const cacheKey = `${modelConfig.protocol}:${modelConfig.baseUrl}:${modelConfig.apiKey}`
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
    case 'anthropic': {
      // Anthropic SDK appends /v1/messages to baseURL automatically,
      // so strip trailing /v1 if present (OpenAI SDK needs it, Anthropic doesn't)
      const anthropicBaseURL = config.baseUrl.replace(/\/v1\/?$/, '')
      return new AnthropicProvider({
        getClient: async (opts) => new Anthropic({
          apiKey: config.apiKey,
          baseURL: anthropicBaseURL,
          maxRetries: opts.maxRetries,
        }),
        calculateUSDCost: (m, usage) =>
          calculateUSDCost(m, usage as NonNullableUsage),
        modelConfig: config,
      })
    }

    case 'openai':
      return new OpenAIProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        modelConfig: config,
      })

    default:
      throw new Error(
        `Unsupported protocol '${(config as { protocol: string }).protocol}' for model '${config.model}'. Supported: 'anthropic', 'openai'.`,
      )
  }
}
