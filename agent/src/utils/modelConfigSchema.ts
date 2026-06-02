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
const REASONING_ROUND_TRIP_FORMATS = ['reasoning_content', 'content_thinking'] as const
const TemplatePatchFields = {
  // Patches accept null at the top level as an RFC 7396 delete marker —
  // a child layer can null out an inherited enabledPatch / disabledPatch.
  enabledPatch: z.union([PatchObjectSchema, z.null()]).optional(),
  disabledPatch: z.union([PatchObjectSchema, z.null()]).optional(),
  effort: z
    .union([
      z
        .object({
          patch: z.union([PatchObjectSchema, z.null()]).optional(),
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
          // A tier may be set to `null` to remove an inherited entry
          // (RFC 7396 JSON Merge Patch semantics).
          valueMap: z
            .object({
              low: z.union([z.string(), z.null()]).optional(),
              medium: z.union([z.string(), z.null()]).optional(),
              high: z.union([z.string(), z.null()]).optional(),
              max: z.union([z.string(), z.null()]).optional(),
            })
            .strict()
            .partial()
            .optional(),
        })
        .strict(),
      z.null(),
    ])
    .optional(),
  budget: z
    .union([
      z
        .object({
          patch: z.union([PatchObjectSchema, z.null()]).optional(),
        })
        .strict(),
      z.null(),
    ])
    .optional(),
  anthropicThinkingField: z
    .union([
      z
        .object({
          defaultBudgetTokens: z.number().int().positive(),
        })
        .strict(),
      z.null(),
    ])
    .optional(),
  autoRoundTripReasoningContent: z
    .union([z.boolean(), z.null()])
    .optional(),
  reasoningRoundTripFormat: z
    .union([z.enum(REASONING_ROUND_TRIP_FORMATS), z.null()])
    .optional(),
}

export const VendorTemplateSchema = z
  .object({
    // Singular `protocol` since the 3-layer DSL refactor — each vendor
    // template targets exactly one protocol. Optional because a template
    // using `extends` may inherit from its parent. resolveStack/
    // resolveTemplate enforce that the resolved leaf has a protocol set.
    protocol: z.enum(PROTOCOL_LITERALS).optional(),
    extends: z.string().optional(),
    // Optional auto-match against the model entry's baseUrl. inferVendor
    // walks vendors with this field set when the user didn't pin a vendor
    // explicitly. Validated as a syntactically valid regex string.
    matchBaseUrlRegex: z
      .string()
      .optional()
      .refine(s => {
        if (s === undefined) return true
        try {
          new RegExp(s)
          return true
        } catch {
          return false
        }
      }, { message: 'matchBaseUrlRegex is not a valid regular expression' }),
    ...TemplatePatchFields,
  })
  .strict()

/**
 * Model templates overlay quirks that follow a model across gateways
 * (e.g. DeepSeek V4+ requiring prior reasoning/thinking replay across
 * tool calls regardless of whether you reach it via api.deepseek.com,
 * SiliconFlow, or any third-party relay).
 *
 * Same patch shape as VendorTemplate sans `extends`. Replay fields may be
 * declared here or on vendor templates; model templates win after merge.
 *
 * Has FOUR matching mechanisms (combined via AND for recommendations and
 * explicit-pin compatibility validation):
 *   - matchModelRegex: required; tested against model name
 *   - matchVendorRegex: optional gate; tested against the resolved vendor
 *     name. Lets a quirk scope to "this model AND on this vendor".
 *   - matchBaseUrlRegex: optional gate; tested against the model entry baseUrl
 *     so relay-specific model overlays can be recommended narrowly.
 *   - protocol: optional protocol gate. When set, explicit modelTemplate pins
 *     must use the same protocol (prevents emitting wrong-shape wire fields).
 *
 * Set protocol when a template's patches or replay flags only make sense for
 * one wire shape; leave it unset only for protocol-neutral overlays.
 */
export const ModelTemplateSchema = z
  .object({
    matchModelRegex: z
      .string()
      .min(1)
      .refine(s => {
        try {
          new RegExp(s)
          return true
        } catch {
          return false
        }
      }, { message: 'matchModelRegex is not a valid regular expression' }),
    matchVendorRegex: z
      .string()
      .optional()
      .refine(s => {
        if (s === undefined) return true
        try {
          new RegExp(s)
          return true
        } catch {
          return false
        }
      }, { message: 'matchVendorRegex is not a valid regular expression' }),
    matchBaseUrlRegex: z
      .string()
      .optional()
      .refine(s => {
        if (s === undefined) return true
        try {
          new RegExp(s)
          return true
        } catch {
          return false
        }
      }, { message: 'matchBaseUrlRegex is not a valid regular expression' }),
    protocol: z.enum(PROTOCOL_LITERALS).optional(),
    ...TemplatePatchFields,
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
    // Explicit model-layer overlay. Leaving it unset means no model template
    // participates in runtime resolution; inferModelTemplate is only used by
    // onboarding to recommend a value.
    modelTemplate: z.string().optional(),
    baseUrl: z.string().min(1),
    apiKey: z.string(),
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
      `Invalid model configuration for '${modelKey}' in ~/.axiomate.json:\n${issues}`,
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

export function validateModelTemplate(name: string, raw: unknown): void {
  const result = ModelTemplateSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  • modelTemplates.${name}.${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Invalid model template '${name}' in ~/.axiomate.json:\n${issues}`,
    )
  }
}
