/**
 * Provider registry: selects the appropriate LLMProvider for a model
 * by looking up the model in ~/.axiomate.json's "models" configuration.
 *
 * No fallback — every model must be explicitly configured.
 */
import type { LLMProvider } from './provider.js'
import { getGlobalConfig, type ModelProviderConfig } from '../../utils/config.js'
import { validateModelProviderConfig } from '../../utils/modelConfigSchema.js'
import { isBuiltinVendor, resolveTemplate } from './vendorTemplates.js'
import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from './providers/anthropicProvider.js'
import { OpenAIProvider } from './providers/openaiProvider.js'
import { OpenAIResponsesProvider } from './providers/openaiResponsesProvider.js'
import { calculateUSDCost } from '../../utils/modelCost.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'

// ---------------------------------------------------------------------------
// Provider cache — keyed by protocol:baseUrl to reuse instances
// ---------------------------------------------------------------------------

const providerCache = new Map<string, LLMProvider>()
const validatedKeys = new Set<string>()

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
  const config = getGlobalConfig()
  const modelConfig = config.models?.[model]
  if (!modelConfig) {
    throw new Error(
      `Model '${model}' is not configured.\n\n` +
      `Add it to ~/.axiomate.json:\n\n` +
      `  "models": {\n` +
      `    "${model}": {\n` +
      `      "model": "${model}",\n` +
      `      "protocol": "openai-chat",\n` +
      `      "baseUrl": "https://your-api-provider.com/v1",\n` +
      `      "apiKey": "sk-..."\n` +
      `    }\n` +
      `  },\n` +
      `  "currentModel": "${model}"`,
    )
  }

  if (!validatedKeys.has(model)) {
    validateModelProviderConfig(model, modelConfig)
    if (modelConfig.vendor && !isBuiltinVendor(modelConfig.vendor)) {
      const customTemplate = config.templates?.[modelConfig.vendor]
      if (!customTemplate) {
        throw new Error(
          `Model '${model}' references vendor '${modelConfig.vendor}', which is neither a built-in template nor defined in config.templates. ` +
          `Built-in templates: 'openai-default', 'openai-responses', 'anthropic', 'deepseek-reasoning', 'openai-ali-thinking', 'openai-siliconflow-thinking'.`,
        )
      }
    }
    // Cross-check that the resolved vendor template's `protocols` array
    // includes this model's protocol. Mismatched combos (e.g. anthropic
    // vendor template under openai-chat protocol) emit wire bodies the
    // server rejects with 400. Refuse at config-load time so the user sees
    // the cause clearly instead of a confusing vendor-side error.
    if (modelConfig.vendor) {
      try {
        const tpl = resolveTemplate(modelConfig.vendor, config.templates)
        if (!tpl.protocols.includes(modelConfig.protocol)) {
          throw new Error(
            `Model '${model}' uses vendor template '${modelConfig.vendor}' with protocol '${modelConfig.protocol}', but that template only fits these protocols: [${tpl.protocols.join(', ')}]. ` +
            `Either change the model's protocol, or pick a vendor template that supports '${modelConfig.protocol}'.`,
          )
        }
      } catch (err) {
        // resolveTemplate may throw "Unknown template" / "missing protocols" —
        // surface those with the model's name attached for clarity.
        if (err instanceof Error && err.message.startsWith('Model ')) throw err
        throw new Error(
          `Model '${model}': ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    validatedKeys.add(model)
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
  validatedKeys.clear()
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

    case 'openai-chat':
      return new OpenAIProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        modelConfig: config,
      })

    case 'openai-responses':
      return new OpenAIResponsesProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        modelConfig: config,
      })

    default:
      throw new Error(
        `Unsupported protocol '${(config as { protocol: string }).protocol}' for model '${config.model}'. Supported: 'anthropic', 'openai-chat', 'openai-responses'.`,
      )
  }
}
