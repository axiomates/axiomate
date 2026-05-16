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

export type VendorTemplateName =
  | 'openai-default'
  | 'openai-responses'
  | 'anthropic'
  | 'deepseek-reasoning'
  | 'openai-ali-thinking'

/** Effort levels the user can declare (axiomate-neutral). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

/**
 * A vendor template describes how to translate a ThinkingDecl into a wire
 * body fragment. Patches use placeholder strings that get substituted with
 * the actual user-provided value at apply time:
 *   '<value>'   → ThinkingDecl.effort (after optional valueMap remap)
 *   '<budget>'  → ThinkingDecl.budget (number)
 */
export type VendorTemplate = {
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
    effort: { patch: { reasoning_effort: '<value>' } },
  },
  'openai-responses': {
    enabledPatch: { reasoning: { summary: 'auto' } },
    effort: { patch: { reasoning: { effort: '<value>' } } },
  },
  anthropic: {
    anthropicThinkingField: { defaultBudgetTokens: 16000 },
    effort: { patch: { output_config: { effort: '<value>' } } },
    budget: { patch: { thinking: { budget_tokens: '<budget>' } } },
  },
  'deepseek-reasoning': {
    // DeepSeek V4+ official API requires both fields per their docs:
    //   thinking: { type: 'enabled' }     ← Anthropic-style thinking switch
    //   reasoning_effort: 'high' | 'max'  ← OpenAI-style intensity (only
    //                                       high/max are accepted; low/medium
    //                                       are collapsed to high)
    // The naming is borrowed from both ecosystems but is DeepSeek-specific
    // (not a standard on either OpenAI or Anthropic Chat Completions).
    enabledPatch: { thinking: { type: 'enabled' } },
    effort: {
      patch: { reasoning_effort: '<value>' },
      valueMap: {
        low: 'high',
        medium: 'high',
        high: 'high',
        max: 'max',
      },
    },
    autoRoundTripReasoningContent: true,
  },
  'openai-ali-thinking': {
    // OpenAI-compatible thinking gateways that share a common wire schema:
    // aliyun DashScope, SiliconFlow, and any provider following the same
    // top-level shape. Applies to ALL thinking-capable models on these
    // gateways (Qwen, GLM, Kimi, MiniMax, DeepSeek-via-gateway, ...) —
    // model-agnostic, gateway-specific.
    //
    // Wire fields (all top-level, not extra_body — that's a Python-SDK
    // convention; Node SDK lets us send any top-level fields verbatim):
    //   enable_thinking: bool             ← thinking switch
    //   thinking_budget: number           ← max reasoning tokens
    //   reasoning_effort: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'
    //                                     ← OpenAI-standard effort set; the
    //                                       neutral 'max' maps to 'xhigh'
    //                                       (the gateway rejects 'max').
    enabledPatch: { enable_thinking: true },
    disabledPatch: { enable_thinking: false },
    effort: {
      patch: { reasoning_effort: '<value>' },
      valueMap: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        max: 'xhigh',
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

  // Merge from base (last) → derived (first). Derived wins on conflicts.
  const merged: VendorTemplate = {}
  for (let i = chain.length - 1; i >= 0; i--) {
    Object.assign(merged, chain[i])
  }
  // Final extends key has no semantic value on the resolved template.
  delete merged.extends
  return merged
}

// ---------------------------------------------------------------------------
// inferVendor
// ---------------------------------------------------------------------------

const DEEPSEEK_REASONING_RE = /deepseek.*v[4-9]/i

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
  if (SILICONFLOW_HOST_RE.test(url) || ALIYUN_HOST_RE.test(url)) {
    return 'openai-ali-thinking'
  }

  if (DEEPSEEK_REASONING_RE.test(config.model)) return 'deepseek-reasoning'
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

  if (thinking.enabled) {
    if (template.enabledPatch) {
      deepMerge(out, structuredClone(template.enabledPatch))
    }

    if (thinking.effort !== undefined && template.effort) {
      const mapped =
        template.effort.valueMap?.[thinking.effort] ?? thinking.effort
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
    }
  } else {
    if (template.disabledPatch) {
      deepMerge(out, structuredClone(template.disabledPatch))
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
