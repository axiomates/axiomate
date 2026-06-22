/**
 * Provider registry: selects the appropriate LLMProvider for a model
 * by looking up the model in ~/.axiomate.json's "models" configuration.
 *
 * No fallback — every model must be explicitly configured.
 */
import type { LLMProvider } from './provider.js'
import { getGlobalConfig, type ModelProviderConfig } from '../../utils/config.js'
import { validateModelProviderConfig } from '../../utils/modelConfigSchema.js'
import {
  getBuiltinModelTemplates,
  getBuiltinTemplates,
  isBuiltinModelTemplate,
  isBuiltinVendor,
  PROTOCOLS,
  resolveStack,
  resolveTemplate,
} from './vendorTemplates.js'
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
const builtinVendorList = [
  ...PROTOCOLS,
  ...Object.keys(getBuiltinTemplates()),
].map(name => `'${name}'`).join(', ')
const builtinModelTemplateList = Object.keys(getBuiltinModelTemplates())
  .map(name => `'${name}'`)
  .join(', ')

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
      `  "model": {\n` +
      `    "defaultRoute": "default",\n` +
      `    "routes": { "default": { "primary": "${model}" } }\n` +
      `  }`,
    )
  }

  const cacheKey = `${model}\0${JSON.stringify(modelConfig)}`
  if (!validatedKeys.has(cacheKey)) {
    validateModelProviderConfig(model, modelConfig)
    // 'auto' (infer by baseUrl) and 'none' (bare protocol layer) are reserved
    // sentinels, not template names — resolveStack interprets them natively, so
    // skip the name-existence guard for them (mirrors modelEditorValidation).
    if (
      modelConfig.vendor &&
      modelConfig.vendor !== 'auto' &&
      modelConfig.vendor !== 'none' &&
      !isBuiltinVendor(modelConfig.vendor)
    ) {
      const customTemplate = config.templates?.[modelConfig.vendor]
      if (!customTemplate) {
        throw new Error(
          `Model '${model}' references vendor '${modelConfig.vendor}', which is neither a built-in template nor defined in config.templates. ` +
          `Built-in templates: ${builtinVendorList}. ` +
          `For vanilla protocols use 'none', or use the protocol name itself: 'openai-chat', 'openai-responses', 'anthropic'.`,
        )
      }
    }
    // When the resolved vendor template declares a protocol, cross-check
    // it matches the model entry. Vendors that omit protocol are allowed
    // to be paired with any protocol — useful for API quirks that exceed
    // the standard wire shape of any single protocol. Mismatched combos
    // (anthropic-shaped vendor under openai-chat) emit wire bodies the
    // server rejects, so we refuse at config-load time when the vendor
    // gave us enough info to know.
    if (
      modelConfig.vendor &&
      modelConfig.vendor !== 'auto' &&
      modelConfig.vendor !== 'none'
    ) {
      try {
        const tpl = resolveTemplate(modelConfig.vendor, config.templates)
        if (
          tpl.protocol !== undefined &&
          tpl.protocol !== modelConfig.protocol
        ) {
          throw new Error(
            `Model '${model}' uses vendor template '${modelConfig.vendor}' with protocol '${modelConfig.protocol}', but that template targets protocol '${tpl.protocol}'. ` +
              `Either change the model's protocol, or pick a vendor template compatible with '${modelConfig.protocol}'.`,
          )
        }
      } catch (err) {
        // resolveTemplate may throw "Unknown template" — surface those
        // with the model's name attached for clarity.
        if (err instanceof Error && err.message.startsWith('Model ')) throw err
        throw new Error(
          `Model '${model}': ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    // 'auto' (smart-match) and 'none' (no model layer) are reserved sentinels,
    // not template names — skip the name-existence guard for them. resolveStack
    // handles both natively and auto matches never throw.
    if (
      modelConfig.modelTemplate &&
      modelConfig.modelTemplate !== 'auto' &&
      modelConfig.modelTemplate !== 'none'
    ) {
      if (
        !isBuiltinModelTemplate(modelConfig.modelTemplate) &&
        !config.modelTemplates?.[modelConfig.modelTemplate]
      ) {
        throw new Error(
          `Model '${model}' references modelTemplate '${modelConfig.modelTemplate}', which is neither a built-in template nor defined in config.modelTemplates. ` +
          `Built-in model templates: ${builtinModelTemplateList || '(none)'}. ` +
          `Use 'auto' to smart-match or 'none' to apply no model-layer template.`,
        )
      }
      try {
        resolveStack({
          protocol: modelConfig.protocol,
          vendor: modelConfig.vendor,
          modelTemplate: modelConfig.modelTemplate,
          model: modelConfig.model,
          baseUrl: modelConfig.baseUrl,
          customVendors: config.templates,
          customModels: config.modelTemplates,
        })
      } catch (err) {
        throw new Error(
          `Model '${model}': ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    validatedKeys.add(cacheKey)
  }

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
          ...(config.userAgent
            ? { defaultHeaders: { 'User-Agent': config.userAgent } }
            : {}),
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
