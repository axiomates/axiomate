/**
 * Zod schemas for ModelProviderConfig + VendorTemplate.
 *
 * Validation runs on demand, when axiomate first reads a model entry —
 * see `getModelProviderConfig` in config.ts. Strict (.strict()) so unknown
 * fields surface as errors instead of being silently ignored, which would
 * mask user typos like `thingking: { ... }`.
 *
 * Note: this file does NOT impose Zod on the rest of GlobalConfig — it
 * only validates the parts we just refactored. Wider Zod adoption is out
 * of scope for this refactor.
 */

import { z } from 'zod'

/**
 * EFFORT_LEVELS includes 'none' because `models[*].thinking.effort` in
 * ~/.axiomate.json IS allowed to default a model to "thinking off" while
 * still leaving the picker live (so the user can cycle to a higher tier
 * when they want). This is distinct from the settings.effortByModel schema
 * (settings/types.ts) which deliberately omits 'none' — that field stores
 * the user's most-recent picker choice and 'none' is filtered out via
 * toPersistableEffort, since the off-switch is a runtime override that
 * shouldn't survive across sessions.
 *
 *   ~/.axiomate.json     models[id].thinking.effort:  none|low|medium|high|max
 *   settings.json        effortByModel[id]:           low|medium|high|max
 *
 * Both layers are intentional; do not "unify" them.
 */
const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'max'] as const

export const ThinkingDeclSchema = z
  .object({
    enabled: z.boolean(),
    effort: z.enum(EFFORT_LEVELS).optional(),
    budget: z.number().int().positive().optional(),
  })
  .strict()

const PatchObjectSchema = z.record(z.unknown())

const PROTOCOL_LITERALS = ['anthropic', 'openai-chat', 'openai-responses'] as const

export const VendorTemplateSchema = z
  .object({
    // Optional in the schema because a template using `extends` may omit
    // `protocols` and inherit from its parent. resolveTemplate enforces
    // non-empty after the extends chain merges (vendorTemplates.ts).
    protocols: z.array(z.enum(PROTOCOL_LITERALS)).nonempty().optional(),
    extends: z.string().optional(),
    enabledPatch: PatchObjectSchema.optional(),
    disabledPatch: PatchObjectSchema.optional(),
    effort: z
      .object({
        patch: PatchObjectSchema,
        // valueMap maps the user-facing effort levels (low|medium|high|max)
        // to vendor-specific wire strings. 'none' is intentionally NOT a
        // key here: it's the runtime off-switch used by ModelPicker to
        // emit `disabledPatch`, not an effort tier to remap. The .strict()
        // below rejects `valueMap: { none: '...' }` configs at parse time.
        // applyThinkingTemplate() handles 'none' by branching to
        // disabledPatch BEFORE valueMap lookup happens.
        //
        // valueMap is *partial*: the keys present here are exactly the
        // tiers ModelPicker exposes in its left/right cycling for this
        // vendor. Omitting a tier means "this vendor does not support
        // that level" — see getCyclableEffortLevels in effort.ts.
        valueMap: z
          .object({
            low: z.string().optional(),
            medium: z.string().optional(),
            high: z.string().optional(),
            max: z.string().optional(),
          })
          .strict()
          .partial()
          .optional(),
      })
      .strict()
      .optional(),
    budget: z
      .object({
        patch: PatchObjectSchema,
      })
      .strict()
      .optional(),
    anthropicThinkingField: z
      .object({
        defaultBudgetTokens: z.number().int().positive(),
      })
      .strict()
      .optional(),
    autoRoundTripReasoningContent: z.boolean().optional(),
  })
  .strict()

const UsageMappingSchema = z
  .object({
    cacheReadTokens: z.union([z.string(), z.array(z.string())]).optional(),
    cacheMissTokens: z.union([z.string(), z.array(z.string())]).optional(),
    cacheWriteTokens: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict()
  .partial()

export const ModelProviderConfigSchema = z
  .object({
    model: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic']),
    vendor: z.string().optional(),
    baseUrl: z.string().min(1),
    apiKey: z.string().min(1),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    supportsImages: z.boolean().optional(),
    thinking: ThinkingDeclSchema.optional(),
    repairToolCalls: z.boolean().optional(),
    extraParams: z.record(z.unknown()).optional(),
    usageMapping: UsageMappingSchema.optional(),
    stallTimeoutMs: z.number().int().min(0).optional(),
    userAgent: z.string().optional(),
  })
  .strict()

/**
 * Throw a friendly error if a model entry has invalid shape.
 *
 * Unlike `safeParse`, this raises immediately so the user sees the
 * validation failure at startup rather than silently running with a
 * misconfigured model.
 */
export function validateModelProviderConfig(
  modelKey: string,
  raw: unknown,
): void {
  const result = ModelProviderConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  • models.${modelKey}.${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Invalid model configuration for '${modelKey}' in ~/.axiomate.json:\n${issues}\n\nDid you migrate from the legacy schema? See README → "Configuration".`,
    )
  }
}

export function validateVendorTemplate(name: string, raw: unknown): void {
  const result = VendorTemplateSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  • templates.${name}.${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Invalid vendor template '${name}' in ~/.axiomate.json:\n${issues}`,
    )
  }
}
