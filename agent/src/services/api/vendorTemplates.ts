/**
 * Vendor template system for translating axiomate's neutral thinking
 * declaration into vendor-specific wire body fragments.
 *
 * Each model entry in ~/.axiomate.json declares thinking preference in a
 * neutral form: { enabled, effort?, budget? }. Vendor templates describe
 * how that translates to the wire-body shape the actual API endpoint
 * expects (reasoning_effort vs reasoning.effort vs enable_thinking, etc).
 *
 * Built-in templates cover the five common cases: openai-default,
 * openai-responses, anthropic, deepseek-reasoning, openai-ali-thinking.
 * Users can register additional templates under config's top-level
 * `templates` field, optionally extending built-ins via `extends`.
 */

import type { ModelProviderConfig, ThinkingDecl } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'

export type VendorTemplateName =
  | 'openai-default'
  | 'openai-responses'
  | 'anthropic'
  | 'deepseek-reasoning'
  | 'openai-ali-thinking'
  | 'openai-siliconflow-thinking'

/** Effort levels the user can declare (axiomate-neutral). */
export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max'

/** Wire protocols this template's patches can produce a valid body for. */
export type Protocol = 'anthropic' | 'openai-chat' | 'openai-responses'

export const PROTOCOLS: readonly Protocol[] = [
  'anthropic',
  'openai-chat',
  'openai-responses',
] as const

/**
 * A vendor template describes how to translate a ThinkingDecl into a wire
 * body fragment. Patches use placeholder strings that get substituted with
 * the actual user-provided value at apply time:
 *   '<value>'   → ThinkingDecl.effort (after optional valueMap remap)
 *   '<budget>'  → ThinkingDecl.budget (number)
 */
export type VendorTemplate = {
  /**
   * Wire protocols this template's patches can produce a valid body for.
   * For example, a template emitting `output_config.effort` only fits an
   * anthropic-protocol body — sending it through openai-chat would 400.
   * This is a technical constraint on the patch fields, not a vendor
   * identity: the same vendor (e.g. OpenAI) may have several templates
   * for different protocols (openai-default for openai-chat,
   * openai-responses for openai-responses).
   *
   * Required at the leaf of the extends chain (built-ins always set it,
   * VendorTemplateSchema demands it for raw user templates that don't
   * extend). Optional on intermediate nodes that inherit from a parent.
   * resolveTemplate guarantees the merged output has a non-empty array.
   */
  protocols?: Protocol[]

  /** Inherit fields from another template; the child's fields win on conflict. */
  extends?: VendorTemplateName | string

  /** Merged into the wire body when thinking.enabled === true. */
  enabledPatch?: Record<string, unknown>

  /** Merged into the wire body when thinking.enabled === false. */
  disabledPatch?: Record<string, unknown>

  /** Translate thinking.effort. */
  effort?: {
    /**
     * Patch object containing '<value>' placeholders.
     * E.g. { reasoning_effort: '<value>' }
     *      { reasoning: { effort: '<value>' } }
     */
    patch: Record<string, unknown>
    /**
     * Optional remap applied before substitution: e.g. DeepSeek collapses
     * low/medium → high.
     */
    valueMap?: Partial<Record<EffortLevel, string>>
  }

  /** Translate thinking.budget. */
  budget?: {
    /** Patch object containing '<budget>' placeholders. */
    patch: Record<string, unknown>
  }

  /**
   * Anthropic-only flag. When set, callers should construct the SDK's
   * top-level `thinking` field with this default budget if the user
   * didn't supply one. Other vendors leave this unset.
   */
  anthropicThinkingField?: {
    defaultBudgetTokens: number
  }

  /**
   * DeepSeek-only flag. When true, openaiRequestAdapter echoes
   * reasoning_content back in the assistant message history (required
   * by DeepSeek V4 Pro for multi-turn tool calls).
   */
  autoRoundTripReasoningContent?: boolean
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

const builtinTemplates: Record<VendorTemplateName, VendorTemplate> = {
  'openai-default': {
    protocols: ['openai-chat'],
    effort: {
      patch: { reasoning_effort: '<value>' },
      // OpenAI Chat Completions accepts 'minimal'|'low'|'medium'|'high'.
      // Map axiomate's 4 levels to OpenAI's 4 levels so each ModelPicker
      // tier sends a distinct wire value rather than collapsing onto 'high'.
      valueMap: {
        low: 'minimal',
        medium: 'low',
        high: 'medium',
        max: 'high',
      },
    },
  },
  'openai-responses': {
    protocols: ['openai-responses'],
    enabledPatch: { reasoning: { summary: 'auto' } },
    effort: {
      patch: { reasoning: { effort: '<value>' } },
      // OpenAI Responses API accepts the same 4 levels as Chat Completions.
      // Same axiomate→OpenAI mapping as openai-default.
      valueMap: {
        low: 'minimal',
        medium: 'low',
        high: 'medium',
        max: 'high',
      },
    },
  },
  anthropic: {
    protocols: ['anthropic'],
    anthropicThinkingField: { defaultBudgetTokens: 16000 },
    effort: {
      patch: { output_config: { effort: '<value>' } },
      // Anthropic accepts low/medium/high. 'max' is intentionally absent
      // from valueMap so ModelPicker doesn't expose it for anthropic models.
      valueMap: { low: 'low', medium: 'medium', high: 'high' },
    },
    budget: { patch: { thinking: { budget_tokens: '<budget>' } } },
  },
  'deepseek-reasoning': {
    protocols: ['openai-chat'],
    // DeepSeek V4+ official API requires both fields per their docs:
    //   thinking: { type: 'enabled' }     ← Anthropic-style thinking switch
    //   reasoning_effort: 'high' | 'max'  ← only these two tiers accepted
    // Disabled state requires thinking.type === 'disabled' explicitly —
    // omitting the field falls back to whatever the gateway defaults to.
    enabledPatch: { thinking: { type: 'enabled' } },
    disabledPatch: { thinking: { type: 'disabled' } },
    effort: {
      patch: { reasoning_effort: '<value>' },
      // DeepSeek V4+ docs only accept 'high' or 'max'. low/medium are
      // intentionally absent so ModelPicker doesn't expose them.
      valueMap: {
        high: 'high',
        max: 'max',
      },
    },
    autoRoundTripReasoningContent: true,
  },
  'openai-ali-thinking': {
    protocols: ['openai-chat'],
    // aliyun DashScope OpenAI-compatible thinking gateway. Wire fields:
    //   enable_thinking: bool             ← thinking switch
    //   thinking_budget: number           ← max reasoning tokens
    //   reasoning_effort: 'high' | 'xhigh' ← top two tiers ('max' is
    //                                       rejected as invalid; remap to xhigh)
    enabledPatch: { enable_thinking: true },
    disabledPatch: { enable_thinking: false },
    effort: {
      patch: { reasoning_effort: '<value>' },
      // aliyun docs only accept 'high' or 'xhigh'. low/medium are
      // intentionally absent. 'max' is remapped to 'xhigh' (gateway's top
      // tier — 'max' would be rejected as invalid).
      valueMap: {
        high: 'high',
        max: 'xhigh',
      },
    },
    budget: { patch: { thinking_budget: '<budget>' } },
  },
  'openai-siliconflow-thinking': {
    protocols: ['openai-chat'],
    // SiliconFlow OpenAI-compatible thinking gateway. Same trio as aliyun.
    // Wire fields:
    //   enable_thinking: bool             ← thinking switch
    //   thinking_budget: number           ← max reasoning tokens
    //   reasoning_effort: 'high' | 'max'  ← only the top two tiers
    enabledPatch: { enable_thinking: true },
    disabledPatch: { enable_thinking: false },
    effort: {
      patch: { reasoning_effort: '<value>' },
      // SiliconFlow accepts only high/max per their docs.
      valueMap: {
        high: 'high',
        max: 'max',
      },
    },
    budget: { patch: { thinking_budget: '<budget>' } },
  },
}

export function getBuiltinTemplates(): Readonly<
  Record<VendorTemplateName, VendorTemplate>
> {
  return builtinTemplates
}

export function isBuiltinVendor(name: string): name is VendorTemplateName {
  return name in builtinTemplates
}

// ---------------------------------------------------------------------------
// resolveTemplate
// ---------------------------------------------------------------------------

const RESOLVE_DEPTH_LIMIT = 8

/**
 * Resolve a template by name, following the `extends` chain. Custom
 * templates win over built-ins when names collide. Throws on unknown
 * vendor or extends cycle.
 */
export function resolveTemplate(
  name: string,
  customTemplates?: Record<string, VendorTemplate>,
): VendorTemplate {
  const seen = new Set<string>()
  const chain: VendorTemplate[] = []
  let current: string | undefined = name

  while (current) {
    if (seen.has(current)) {
      throw new Error(
        `Vendor template '${name}' has a cyclic extends chain at '${current}'`,
      )
    }
    seen.add(current)
    if (chain.length >= RESOLVE_DEPTH_LIMIT) {
      throw new Error(
        `Vendor template '${name}' extends chain exceeds depth ${RESOLVE_DEPTH_LIMIT}`,
      )
    }

    const tpl = customTemplates?.[current] ?? builtinTemplates[current as VendorTemplateName]
    if (!tpl) {
      throw new Error(
        `Unknown vendor template: '${current}'. Built-in templates: ${Object.keys(builtinTemplates).join(', ')}`,
      )
    }
    chain.push(tpl)
    current = tpl.extends
  }

  // Merge from base (last) → derived (first). Derived wins on conflicts —
  // but `protocols` is special: a child that omits it should inherit, not
  // erase. Object.assign with an undefined source key would clobber, so
  // skip undefined `protocols` during the merge.
  const merged: VendorTemplate = { protocols: [] }
  for (let i = chain.length - 1; i >= 0; i--) {
    const link = chain[i]!
    const { protocols, ...rest } = link
    Object.assign(merged, rest)
    if (protocols !== undefined) {
      merged.protocols = protocols
    }
  }
  // Final extends key has no semantic value on the resolved template.
  delete merged.extends
  if (!merged.protocols || merged.protocols.length === 0) {
    throw new Error(
      `Vendor template '${name}' is missing 'protocols' — declare which wire protocols it produces valid bodies for, e.g. ["openai-chat"], or extend a built-in template that already declares them.`,
    )
  }
  return merged
}

// ---------------------------------------------------------------------------
// inferVendor
// ---------------------------------------------------------------------------

const DEEPSEEK_REASONING_RE = /deepseek.*v(\d+)/i

/** Match the official DeepSeek API host. */
const DEEPSEEK_HOST_RE = /(^|\/\/)api\.deepseek\.com(\/|$)/i

/** Match SiliconFlow host. */
const SILICONFLOW_HOST_RE = /siliconflow\.cn/i

/** Match aliyun DashScope hosts (incl. compatible-mode endpoint). */
const ALIYUN_HOST_RE = /dashscope\.aliyun(cs)?\.com/i

/**
 * Pick a sensible vendor template when the user didn't specify one
 * via the `vendor` config field.
 *
 * Resolution order:
 *   1. protocol === 'anthropic'         → 'anthropic'
 *   2. protocol === 'openai-responses'  → 'openai-responses'
 *   3. protocol === 'openai-chat':
 *      a. baseUrl is api.deepseek.com   → 'deepseek-reasoning'
 *      b. baseUrl is SiliconFlow / aliyun DashScope → 'openai-ali-thinking'
 *         (gateway-level decision; covers Qwen, GLM, Kimi, MiniMax,
 *         DeepSeek-via-gateway — same wire schema across all models)
 *      c. model name matches DeepSeek V4+    → 'deepseek-reasoning'
 *      d. fallback                            → 'openai-default'
 *
 * Gateway hosts are checked before model names because the gateway's
 * wire schema is the same regardless of model — e.g. SiliconFlow's
 * thinking schema applies even when the model is DeepSeek.
 */
export function inferVendor(
  config: Pick<ModelProviderConfig, 'protocol' | 'model'> & { baseUrl?: string },
): VendorTemplateName {
  if (config.protocol === 'anthropic') return 'anthropic'
  if (config.protocol === 'openai-responses') return 'openai-responses'

  const url = config.baseUrl ?? ''
  if (DEEPSEEK_HOST_RE.test(url)) return 'deepseek-reasoning'
  if (SILICONFLOW_HOST_RE.test(url)) return 'openai-siliconflow-thinking'
  if (ALIYUN_HOST_RE.test(url)) return 'openai-ali-thinking'

  // Model-name fallback for unknown gateways. DeepSeek V4+ is the family
  // that takes thinking + reasoning_effort; V3 and earlier are not
  // reasoning-capable and should use the generic openai-default template.
  const deepseekMatch = DEEPSEEK_REASONING_RE.exec(config.model)
  if (deepseekMatch && Number.parseInt(deepseekMatch[1] ?? '0', 10) >= 4) {
    return 'deepseek-reasoning'
  }
  return 'openai-default'
}

// ---------------------------------------------------------------------------
// applyThinkingTemplate
// ---------------------------------------------------------------------------

/**
 * Translate a ThinkingDecl to a wire-body fragment using the resolved
 * template. The result should be merged into the request body via
 * Object.assign or deep-merge, depending on the caller.
 *
 * Returns an empty object when:
 *   - thinking is undefined (user didn't declare any preference)
 *   - thinking.enabled === false and the template has no disabledPatch
 *
 * Anthropic SDK's top-level `thinking` field is NOT produced here —
 * callers handle that separately via template.anthropicThinkingField.
 * This function only emits the patches that should be merged into the
 * wire body alongside (or as an override of) the SDK-built thinking field.
 */
export function applyThinkingTemplate(
  thinking: ThinkingDecl | undefined,
  template: VendorTemplate,
): Record<string, unknown> {
  if (!thinking) return {}

  const out: Record<string, unknown> = {}

  // 'none' is a runtime-only override: regardless of thinking.enabled, it
  // sends the disabledPatch and skips enabledPatch / effort.patch / budget.
  // This branch runs BEFORE valueMap lookup, so 'none' could never collide
  // with a remap target anyway — and modelConfigSchema's strict valueMap
  // shape already forbids `none` as a key (it's the off-switch, not a tier).
  if (thinking.effort === 'none') {
    if (template.disabledPatch) {
      deepMerge(out, structuredClone(template.disabledPatch))
    }
    return out
  }

  if (thinking.enabled) {
    if (template.enabledPatch) {
      deepMerge(out, structuredClone(template.enabledPatch))
    }

    if (thinking.effort !== undefined && template.effort) {
      const valueMap = template.effort.valueMap
      const mapped = valueMap?.[thinking.effort] ?? thinking.effort
      // If the user wrote an effort value the vendor template doesn't list
      // in its valueMap (e.g. anthropic config with effort: 'max'), we let
      // the literal pass through. Most vendors will reject it — log a
      // warning so users can see why their request 400'd.
      if (valueMap && !(thinking.effort in valueMap)) {
        logForDebugging(
          `[vendor-template] effort '${thinking.effort}' is not a key in valueMap; transmitting as-is — the vendor may reject it`,
        )
      }
      const patch = substitutePlaceholder(
        structuredClone(template.effort.patch),
        '<value>',
        mapped,
      )
      deepMerge(out, patch)
    }

    if (thinking.budget !== undefined && template.budget) {
      const patch = substitutePlaceholder(
        structuredClone(template.budget.patch),
        '<budget>',
        thinking.budget,
      )
      deepMerge(out, patch)
    } else if (thinking.budget !== undefined && !template.budget) {
      // User configured a budget on a vendor whose template has no
      // budget.patch (openai-default, openai-responses, deepseek-reasoning
      // at the time of writing). The budget would silently disappear
      // otherwise — log so the user can see why their token cap isn't
      // taking effect.
      logForDebugging(
        `[vendor-template] thinking.budget=${thinking.budget} ignored — the resolved vendor template has no budget patch`,
      )
    }
  } else {
    if (template.disabledPatch) {
      deepMerge(out, structuredClone(template.disabledPatch))
    }
    if (thinking.effort !== undefined) {
      // User configured `thinking.enabled: false` together with a non-'none'
      // effort (the 'none' case was handled by the early-return at the top
      // of this function). The else-branch above sends only disabledPatch,
      // so the effort field is silently dropped. Warn so the user understands
      // why their high-effort config isn't taking effect — and consider using
      // `effort: 'none'` (runtime override) or omitting `enabled: false`.
      logForDebugging(
        `[vendor-template] thinking.effort='${thinking.effort}' ignored — thinking.enabled=false routes through disabledPatch (use effort:'none' or remove enabled:false to send effort)`,
      )
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Recursively replace any string === placeholder with `value` in arrays
 * and plain objects. Mutates `obj` in place.
 */
function substitutePlaceholder<T>(obj: T, placeholder: string, value: unknown): T {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (obj[i] === placeholder) {
        ;(obj as unknown[])[i] = value
      } else if (obj[i] && typeof obj[i] === 'object') {
        substitutePlaceholder(obj[i], placeholder, value)
      }
    }
    return obj
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    for (const k of Object.keys(o)) {
      if (o[k] === placeholder) {
        o[k] = value
      } else if (o[k] && typeof o[k] === 'object') {
        substitutePlaceholder(o[k], placeholder, value)
      }
    }
  }
  return obj
}

/**
 * Recursive object merge. Arrays are replaced wholesale; plain objects
 * merge field-by-field; primitives in `src` overwrite `dst`.
 *
 * Exported because providers need to merge a vendor template's output
 * into a request body that may already contain nested objects (e.g.
 * Anthropic's `thinking` field built by the SDK before our patch lands).
 */
export function deepMerge(
  dst: Record<string, unknown>,
  src: Record<string, unknown>,
): void {
  for (const k of Object.keys(src)) {
    const sv = src[k]
    const dv = dst[k]
    if (
      sv &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      dv &&
      typeof dv === 'object' &&
      !Array.isArray(dv)
    ) {
      deepMerge(dv as Record<string, unknown>, sv as Record<string, unknown>)
    } else {
      dst[k] = sv
    }
  }
}
