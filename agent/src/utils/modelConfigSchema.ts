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

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const

export const ThinkingDeclSchema = z
  .object({
    enabled: z.boolean(),
    effort: z.enum(EFFORT_LEVELS).optional(),
    budget: z.number().int().positive().optional(),
  })
  .strict()

const PatchObjectSchema = z.record(z.unknown())

export const VendorTemplateSchema = z
  .object({
    extends: z.string().optional(),
    enabledPatch: PatchObjectSchema.optional(),
    disabledPatch: PatchObjectSchema.optional(),
    effort: z
      .object({
        patch: PatchObjectSchema,
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
