/**
 * Three-layer template system for translating axiomate's neutral thinking
 * declaration into vendor-specific wire body fragments.
 *
 * The wire shape a model needs is fragmented along three independent axes:
 *
 *   protocol  — wire envelope (which SDK / endpoint).
 *               anthropic / openai-chat / openai-responses.
 *
 *   vendor    — gateway-specific quirks layered on top of a protocol.
 *               aliyun's enable_thinking + reasoning_effort: 'xhigh',
 *               SiliconFlow's identical-but-not-quite enable_thinking,
 *               OpenAI's reasoning_effort vs reasoning.effort, etc.
 *
 *   model     — quirks that follow the *model itself* across gateways.
 *               deepseek-v4 needs reasoning_content round-tripped in tool
 *               calls regardless of whether you reach it via the official
 *               API, SiliconFlow, OpenRouter, or any other relay.
 *
 * Three layers compose with RFC 7396 JSON Merge Patch semantics: deep
 * merge, arrays replaced, `null` deletes the inherited key. resolveStack
 * walks protocol → vendor → model, merging each in order, and emits the
 * final ResolvedTemplate consumed by applyThinkingTemplate. Built-in
 * templates ship for the common combinations; users can register custom
 * templates at any layer in `~/.axiomate.json` and reference them via
 * `vendor:` / `modelTemplate:` on a model entry.
 *
 * The deprecated single-layer `vendor:` field on a model entry still
 * resolves to the matching layered stack — built-in vendors are now thin
 * adapters that extend the appropriate protocol.
 */

import type { ModelProviderConfig, ThinkingDecl } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'

/** Effort levels the user can declare (axiomate-neutral). */
export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max'

/** Wire protocols a vendor/model template's patches can target. */
export type Protocol = 'anthropic' | 'openai-chat' | 'openai-responses'

export const PROTOCOLS: readonly Protocol[] = [
  'anthropic',
  'openai-chat',
  'openai-responses',
] as const

// ---------------------------------------------------------------------------
// Template shape
// ---------------------------------------------------------------------------

/**
 * Patch fields shared by all three layers. Each layer can declare any
 * subset; resolveStack merges them in protocol → vendor → model order
 * with RFC 7396 semantics (deep-merge dicts, replace arrays, `null`
 * deletes the inherited key).
 *
 * Placeholder strings substituted at apply time:
 *   '<value>'  → ThinkingDecl.effort (after optional valueMap remap)
 *   '<budget>' → ThinkingDecl.budget (number)
 */
export type TemplatePatches = {
  /** Merged into the wire body when thinking.enabled === true. */
  enabledPatch?: Record<string, unknown> | null

  /** Merged into the wire body when thinking.enabled === false. */
  disabledPatch?: Record<string, unknown> | null

  /** Translate thinking.effort. */
  effort?: {
    /**
     * Patch object containing '<value>' placeholders.
     * E.g. { reasoning_effort: '<value>' }
     *      { reasoning: { effort: '<value>' } }
     */
    patch?: Record<string, unknown> | null
    /**
     * Per-tier remap applied before substitution. Partial dict — keys
     * present mark cyclable tiers; keys explicitly set to `null` delete
     * an inherited tier.
     */
    valueMap?: Partial<Record<EffortLevel, string | null>>
  } | null

  /** Translate thinking.budget. */
  budget?: {
    /** Patch object containing '<budget>' placeholders. */
    patch?: Record<string, unknown> | null
  } | null

  /**
   * Anthropic-only flag. When set, callers should construct the SDK's
   * top-level `thinking` field with this default budget if the user
   * didn't supply one. Other vendors leave this unset.
   */
  anthropicThinkingField?: { defaultBudgetTokens: number } | null
}

/**
 * A vendor template extends a protocol and overlays gateway-specific patches.
 *
 * Built-in vendors specify their `protocol` directly. Custom vendors can
 * either specify `protocol` (independent template) or `extends`
 * (inherits another vendor's full chain). Cycles and missing parents are
 * caught at resolveStack time.
 *
 * NOTE: `autoRoundTripReasoningContent` is intentionally NOT part of this
 * shape — it's a model-class quirk (DeepSeek V4+ requires reasoning_content
 * round-trip on tool calls regardless of which gateway hosts the model),
 * not a gateway behavior. Declare it on ModelTemplate instead.
 */
export type VendorTemplate = TemplatePatches & {
  /**
   * The wire protocol this vendor adapts to. Required at the chain leaf.
   * Inherited from `extends` when omitted.
   */
  protocol?: Protocol

  /** Inherit fields from another vendor template. */
  extends?: string
}

/**
 * A model template overlays model-specific quirks on top of a vendor.
 * Selected per ModelProviderConfig either via explicit `modelTemplate:`
 * or auto-matched by the model name regex.
 *
 * Owns `autoRoundTripReasoningContent` — that flag follows the model
 * across gateways (e.g. DeepSeek V4 needs it whether reached via the
 * official API, SiliconFlow, OpenRouter, or a private relay), so it
 * naturally lives at the model layer rather than vendor.
 */
export type ModelTemplate = TemplatePatches & {
  /**
   * Optional regex (as a string) auto-matched against the model name when
   * the user didn't write `modelTemplate:` on the model entry. Matched
   * model templates compose on top of whatever vendor was resolved —
   * gateway/protocol agnostic.
   */
  matchModelRegex?: string

  /**
   * Echo reasoning_content back in the assistant message history on
   * subsequent tool calls. Required by some reasoning models (DeepSeek
   * V4+) to maintain reasoning context across tool-use turns.
   *
   * Lives only on the model layer — it's a property of the model itself
   * that travels with it across gateways, not a vendor/protocol concern.
   */
  autoRoundTripReasoningContent?: boolean | null
}

/**
 * The protocol layer is a thin record of patches keyed by the three wire
 * protocols. Every resolveStack call starts here, then applies vendor,
 * then model.
 */
export type ProtocolTemplate = TemplatePatches

/**
 * Final shape consumed by applyThinkingTemplate after the three-layer merge.
 * Includes ModelTemplate fields (autoRoundTripReasoningContent) since the
 * model layer participates in the merge.
 */
export type ResolvedTemplate = TemplatePatches & {
  /** Protocol the resolved patches target — used for runtime routing. */
  protocol: Protocol
  /** Inherited from the model layer if any model template matched. */
  autoRoundTripReasoningContent?: boolean
}

// Backwards-compat alias for the rare callers that imported the old name.
export type VendorTemplateName = string

// ---------------------------------------------------------------------------
// Built-in protocol templates
// ---------------------------------------------------------------------------

/**
 * Protocol-level patches every vendor of that protocol inherits.
 *
 * Holds anything the protocol itself defines — fields that any vendor
 * implementing this wire envelope must use. Vendors override or extend
 * via `null` (RFC 7396 deletion) or by setting their own values.
 *
 *   anthropic — Anthropic Messages API.
 *     output_config.effort, thinking.budget_tokens, the SDK-side
 *     thinking field — all defined by Anthropic for this protocol.
 *
 *   openai-chat — OpenAI Chat Completions API (with reasoning extension).
 *     reasoning_effort field name + OpenAI's defined values
 *     (minimal/low/medium/high) come from OpenAI. Third-party gateways
 *     (aliyun, SiliconFlow, DeepSeek) override the valueMap with `null`
 *     entries to delete tiers they don't accept.
 *
 *   openai-responses — OpenAI Responses API.
 *     reasoning.effort, reasoning.summary all defined by OpenAI for
 *     this protocol.
 */
const builtinProtocolTemplates: Record<Protocol, ProtocolTemplate> = {
  anthropic: {
    anthropicThinkingField: { defaultBudgetTokens: 16000 },
    effort: {
      patch: { output_config: { effort: '<value>' } },
      // Anthropic accepts low/medium/high. 'max' is intentionally absent so
      // ModelPicker doesn't expose it for anthropic models.
      valueMap: { low: 'low', medium: 'medium', high: 'high' },
    },
    budget: { patch: { thinking: { budget_tokens: '<budget>' } } },
  },
  'openai-chat': {
    effort: {
      patch: { reasoning_effort: '<value>' },
      // OpenAI Chat Completions reasoning extension accepts
      // 'minimal'|'low'|'medium'|'high'. Map axiomate's 4 tiers onto
      // OpenAI's 4 tiers so each ModelPicker level sends a distinct wire
      // value rather than collapsing onto 'high'. Third-party gateways
      // override with null entries to delete tiers they don't accept.
      valueMap: {
        low: 'minimal',
        medium: 'low',
        high: 'medium',
        max: 'high',
      },
    },
  },
  'openai-responses': {
    enabledPatch: { reasoning: { summary: 'auto' } },
    effort: {
      patch: { reasoning: { effort: '<value>' } },
      valueMap: {
        low: 'minimal',
        medium: 'low',
        high: 'medium',
        max: 'high',
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Built-in vendor templates
// ---------------------------------------------------------------------------

const builtinVendorTemplates: Record<string, VendorTemplate> = {
  // ── openai-chat protocol family ─────────────────────────────────────────
  // The openai-chat protocol layer carries reasoning_effort + OpenAI's
  // standard valueMap (minimal/low/medium/high). Third-party gateways
  // here override or null out tiers they don't accept.
  'openai-chat-default': {
    protocol: 'openai-chat',
    // Pure OpenAI Chat Completions semantics — everything inherited from
    // the protocol layer. No gateway-specific overrides.
  },
  'openai-chat-deepseek-official': {
    // The official api.deepseek.com vendor. DeepSeek V4+ family quirks
    // (autoRoundTripReasoningContent) live in the openai-chat-deepseek-v4p
    // model template — this vendor template only handles the gateway shape.
    //
    // DeepSeek requires a `thinking` switch alongside reasoning_effort and
    // rejects low/medium (only accepts high/max).
    protocol: 'openai-chat',
    enabledPatch: { thinking: { type: 'enabled' } },
    disabledPatch: { thinking: { type: 'disabled' } },
    effort: {
      // Override the protocol's OpenAI-standard remap with identity for
      // the supported tiers and null out the unsupported ones (RFC 7396
      // delete-key semantics).
      valueMap: {
        low: null,
        medium: null,
        high: 'high',
        max: 'max',
      },
    },
  },
  'openai-chat-aliyun': {
    // aliyun DashScope OpenAI-compatible thinking gateway. Wire fields:
    //   enable_thinking: bool             ← thinking switch
    //   thinking_budget: number           ← max reasoning tokens
    //   reasoning_effort: 'high' | 'xhigh' ← top two tiers ('max' is
    //                                       rejected as invalid; remap to xhigh)
    protocol: 'openai-chat',
    enabledPatch: { enable_thinking: true },
    disabledPatch: { enable_thinking: false },
    effort: {
      valueMap: {
        low: null,
        medium: null,
        high: 'high',
        max: 'xhigh',
      },
    },
    budget: { patch: { thinking_budget: '<budget>' } },
  },
  'openai-chat-siliconflow': {
    // SiliconFlow OpenAI-compatible thinking gateway. Same trio as aliyun
    // but accepts 'max' literally (no xhigh remap). Wire fields:
    //   enable_thinking: bool             ← thinking switch
    //   thinking_budget: number           ← max reasoning tokens
    //   reasoning_effort: 'high' | 'max'  ← only the top two tiers
    protocol: 'openai-chat',
    enabledPatch: { enable_thinking: true },
    disabledPatch: { enable_thinking: false },
    effort: {
      valueMap: {
        low: null,
        medium: null,
        high: 'high',
        max: 'max',
      },
    },
    budget: { patch: { thinking_budget: '<budget>' } },
  },

  // ── anthropic protocol family ───────────────────────────────────────────
  // Anthropic's wire fields (output_config.effort, thinking.budget_tokens,
  // SDK-side thinking field) all live in the protocol layer. The vendor
  // here just declares which protocol it targets — no gateway-specific
  // overrides today.
  anthropic: {
    protocol: 'anthropic',
  },

  // ── openai-responses protocol family ────────────────────────────────────
  // OpenAI Responses fields (reasoning.effort, reasoning.summary, valueMap)
  // also live in the protocol layer.
  'openai-responses': {
    protocol: 'openai-responses',
  },
}

// ---------------------------------------------------------------------------
// Built-in model templates
// ---------------------------------------------------------------------------

/**
 * Model-level overlays. Live independently of the vendor / gateway: when
 * openai-chat-deepseek-v4p matches by name (or the user sets
 * `modelTemplate:` on a model entry), its patches apply on top of
 * whatever vendor stack resolved — so DeepSeek-V4-via-SiliconFlow gets
 * BOTH SiliconFlow's enable_thinking and the V4 family's
 * reasoning_content round-trip.
 *
 * The protocol-family prefix in the name (openai-chat-) hints which
 * vendors this overlay is compatible with. We don't enforce it
 * mechanically because a model template only writes patches that
 * remain valid across any vendor in that protocol family.
 */
const builtinModelTemplates: Record<string, ModelTemplate> = {
  'openai-chat-deepseek-v4p': {
    // Match v4 and up. See DEEPSEEK_REASONING_RE for shape rationale.
    matchModelRegex: '\\bdeepseek[\\s\\-_]*v?[\\s\\-_]*(\\d+)',
    // The actual >=4 numeric threshold is enforced inside inferModelTemplate
    // since regex alone can't express it.
    autoRoundTripReasoningContent: true,
  },
}

export function getBuiltinProtocolTemplates(): Readonly<
  Record<Protocol, ProtocolTemplate>
> {
  return builtinProtocolTemplates
}

export function getBuiltinVendorTemplates(): Readonly<
  Record<string, VendorTemplate>
> {
  return builtinVendorTemplates
}

export function getBuiltinModelTemplates(): Readonly<
  Record<string, ModelTemplate>
> {
  return builtinModelTemplates
}

// Legacy shim — some callers still import the old name. Returns the
// flat vendor registry; protocol/model layers are accessed separately.
export function getBuiltinTemplates(): Readonly<
  Record<string, VendorTemplate>
> {
  return builtinVendorTemplates
}

export function isBuiltinVendor(name: string): boolean {
  return name in builtinVendorTemplates
}

export function isBuiltinModelTemplate(name: string): boolean {
  return name in builtinModelTemplates
}

// ---------------------------------------------------------------------------
// resolveStack — three-layer resolver
// ---------------------------------------------------------------------------

const RESOLVE_DEPTH_LIMIT = 8

type ResolveInput = {
  protocol: Protocol
  vendor?: string
  modelTemplate?: string
  model: string
  baseUrl?: string
  customVendors?: Record<string, VendorTemplate>
  customModels?: Record<string, ModelTemplate>
}

/**
 * Build the protocol → vendor → model patch stack and merge it down.
 *
 * Resolution order:
 *   1. Pick protocolPatches from builtinProtocolTemplates[protocol].
 *   2. Pick the vendor template (custom > built-in). If `vendor` is
 *      omitted, runs inferVendor with the same inputs to derive one.
 *      The vendor's own extends chain resolves recursively.
 *   3. Pick the model template (custom > built-in). If `modelTemplate`
 *      is omitted, runs inferModelTemplate (regex match) with the model
 *      name. Returns no overlay if nothing matches.
 *   4. deepMerge the three layers using RFC 7396 semantics (`null` keys
 *      delete inherited fields).
 *
 * Throws on cycles, unknown vendors, or protocol mismatch (vendor's
 * declared protocol must equal the model entry's protocol).
 */
export function resolveStack(input: ResolveInput): ResolvedTemplate {
  const protocolPatches =
    builtinProtocolTemplates[input.protocol] ?? {}

  const vendorName = input.vendor ?? inferVendor(input)
  const vendorTemplate = resolveVendorChain(vendorName, input.customVendors)
  const vendorProtocol = vendorTemplate.protocol
  if (vendorProtocol && vendorProtocol !== input.protocol) {
    throw new Error(
      `Vendor template '${vendorName}' targets protocol '${vendorProtocol}' but model is configured with protocol '${input.protocol}'.`,
    )
  }

  const modelTemplateName =
    input.modelTemplate ?? inferModelTemplate(input.model, input.customModels)
  const modelTemplate = modelTemplateName
    ? resolveModelTemplate(modelTemplateName, input.customModels)
    : undefined

  const merged: TemplatePatches & { protocol?: Protocol } = {}
  deepMerge(merged as Record<string, unknown>, structuredClone(protocolPatches as Record<string, unknown>))
  deepMerge(merged as Record<string, unknown>, structuredClone(vendorTemplate as Record<string, unknown>))
  if (modelTemplate) {
    deepMerge(merged as Record<string, unknown>, structuredClone(modelTemplate as Record<string, unknown>))
  }
  // Strip resolution-only fields the caller doesn't need.
  delete (merged as Record<string, unknown>).extends
  delete (merged as Record<string, unknown>).matchModelRegex
  // Force-protocol — it's a required runtime hint for downstream callers.
  merged.protocol = input.protocol
  return merged as ResolvedTemplate
}

/**
 * Resolve a vendor template through its `extends` chain (custom wins
 * over built-in, child wins on conflict, deepMerge with RFC 7396).
 */
function resolveVendorChain(
  name: string,
  custom?: Record<string, VendorTemplate>,
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
    const tpl = custom?.[current] ?? builtinVendorTemplates[current]
    if (!tpl) {
      throw new Error(
        `Unknown vendor template: '${current}'. Built-in vendors: ${Object.keys(builtinVendorTemplates).join(', ')}`,
      )
    }
    chain.push(tpl)
    current = tpl.extends
  }
  const merged: VendorTemplate = {}
  for (let i = chain.length - 1; i >= 0; i--) {
    deepMerge(merged as Record<string, unknown>, structuredClone(chain[i] as Record<string, unknown>))
  }
  delete merged.extends
  return merged
}

function resolveModelTemplate(
  name: string,
  custom?: Record<string, ModelTemplate>,
): ModelTemplate | undefined {
  const tpl = custom?.[name] ?? builtinModelTemplates[name]
  if (!tpl) {
    throw new Error(
      `Unknown model template: '${name}'. Built-in: ${Object.keys(builtinModelTemplates).join(', ')}`,
    )
  }
  return tpl
}

/**
 * Backward-compat wrapper for callers that still use the single-vendor
 * resolution path. Returns the protocol-merged vendor template — i.e. the
 * vendor chain plus its protocol's patches deep-merged on top, so callers
 * see the same effective shape applyThinkingTemplate would. Does NOT
 * apply model-layer patches; use resolveStack for full 3-layer resolution.
 */
export function resolveTemplate(
  name: string,
  customTemplates?: Record<string, VendorTemplate>,
): VendorTemplate & { protocols: Protocol[] } {
  const vendor = resolveVendorChain(name, customTemplates)
  if (!vendor.protocol) {
    throw new Error(
      `Vendor template '${name}' is missing 'protocol' — declare which wire protocol it targets, or extend a built-in template that already declares it.`,
    )
  }
  const protocolPatches = builtinProtocolTemplates[vendor.protocol] ?? {}
  // Apply protocol patches first, then vendor on top (RFC 7396).
  const merged: VendorTemplate = {}
  deepMerge(merged as Record<string, unknown>, structuredClone(protocolPatches as Record<string, unknown>))
  deepMerge(merged as Record<string, unknown>, structuredClone(vendor as Record<string, unknown>))
  delete merged.extends
  // Older callers expected a `protocols: Protocol[]` array (pre-3-layer
  // refactor). Synthesize it from the single `protocol` field so existing
  // call sites (getCyclableEffortLevels, OnboardingProviderStep VendorStep,
  // providerRegistry cross-check) keep working without rewrite.
  return { ...merged, protocol: vendor.protocol, protocols: [vendor.protocol] }
}

// ---------------------------------------------------------------------------
// inferVendor / inferModelTemplate
// ---------------------------------------------------------------------------

/**
 * Match DeepSeek model names with a version >= 4 (the reasoning family).
 *
 * Matches: deepseek-v4, DeepSeek-V4, deepseek 4, deepseek-4.1, deepseek_v10
 * Rejects: deepseek-r1, deepseek-coder-7b, deepseek-chat (no version digit
 *          adjacent to the deepseek prefix; the optional 'v' and only
 *          space/dash/underscore separators keep us from matching unrelated
 *          model lines that happen to contain "deepseek" plus a digit later).
 *
 * Captures the leading integer of the version (`v4.1` → `4`); callers
 * compare against the >=4 threshold.
 */
const DEEPSEEK_REASONING_RE = /\bdeepseek[\s\-_]*v?[\s\-_]*(\d+)/i

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
 * Resolution order (gateway > model name — gateway wire schema applies
 * regardless of which model name is chosen):
 *   1. protocol === 'anthropic'         → 'anthropic'
 *   2. protocol === 'openai-responses'  → 'openai-responses'
 *   3. protocol === 'openai-chat':
 *      a. baseUrl is api.deepseek.com           → 'openai-chat-deepseek-official'
 *      b. baseUrl is SiliconFlow                → 'openai-chat-siliconflow'
 *      c. baseUrl is aliyun DashScope           → 'openai-chat-aliyun'
 *      d. fallback                              → 'openai-chat-default'
 *
 * NOTE: model-name-based vendor inference (e.g. "deepseek-v4 → vendor X")
 * was removed in the three-layer refactor. Model quirks now live in the
 * model template layer (openai-chat-deepseek-v4p), independent of which
 * gateway the user picked. The vendor still defaults to whatever the
 * gateway needs.
 */
export function inferVendor(
  config: Pick<ModelProviderConfig, 'protocol' | 'model'> & { baseUrl?: string },
): string {
  if (config.protocol === 'anthropic') return 'anthropic'
  if (config.protocol === 'openai-responses') return 'openai-responses'

  const url = config.baseUrl ?? ''
  if (DEEPSEEK_HOST_RE.test(url)) return 'openai-chat-deepseek-official'
  if (SILICONFLOW_HOST_RE.test(url)) return 'openai-chat-siliconflow'
  if (ALIYUN_HOST_RE.test(url)) return 'openai-chat-aliyun'

  return 'openai-chat-default'
}

/**
 * Find the model template that matches `model` by regex (built-in +
 * custom registry). Returns the template name, or undefined when nothing
 * matches. Custom templates win on regex collision.
 *
 * Built-in `deepseek-v4-plus` additionally enforces the >=4 numeric
 * threshold; lower versions don't apply the V4 family quirks.
 */
export function inferModelTemplate(
  model: string,
  custom?: Record<string, ModelTemplate>,
): string | undefined {
  // Custom first.
  for (const [name, tpl] of Object.entries(custom ?? {})) {
    if (matchesModel(tpl, model, name)) return name
  }
  for (const [name, tpl] of Object.entries(builtinModelTemplates)) {
    if (matchesModel(tpl, model, name)) return name
  }
  return undefined
}

function matchesModel(
  tpl: ModelTemplate,
  model: string,
  name: string,
): boolean {
  if (!tpl.matchModelRegex) return false
  let re: RegExp
  try {
    re = new RegExp(tpl.matchModelRegex, 'i')
  } catch {
    logForDebugging(
      `[model-template] '${name}' has invalid matchModelRegex; ignoring.`,
    )
    return false
  }
  const m = re.exec(model)
  if (!m) return false
  // Special case for the DeepSeek family: enforce the >=4 numeric threshold
  // built into DEEPSEEK_REASONING_RE so v3 / v3.5 don't get the V4 overlay.
  if (name === 'openai-chat-deepseek-v4p') {
    const ver = Number.parseInt(m[1] ?? '0', 10)
    if (ver < 4) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// applyThinkingTemplate
// ---------------------------------------------------------------------------

/**
 * Translate a ThinkingDecl to a wire-body fragment using the resolved
 * three-layer template. The result should be merged into the request
 * body via Object.assign or deep-merge, depending on the caller.
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
  template: TemplatePatches,
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
      deepMerge(out, structuredClone(template.disabledPatch as Record<string, unknown>))
    }
    return out
  }

  if (thinking.enabled) {
    if (template.enabledPatch) {
      deepMerge(out, structuredClone(template.enabledPatch as Record<string, unknown>))
    }

    if (thinking.effort !== undefined && template.effort && template.effort.patch) {
      const valueMap = template.effort.valueMap
      const mappedRaw = valueMap?.[thinking.effort]
      // RFC 7396 null in valueMap means "this tier was deleted by an
      // overlay layer" — surface as missing-key, not as wire literal 'null'.
      const mapped = mappedRaw === null
        ? thinking.effort
        : (mappedRaw ?? thinking.effort)
      // If the user wrote an effort value the resolved template doesn't
      // list in its valueMap (e.g. anthropic config with effort: 'max'),
      // we let the literal pass through. Most vendors will reject it —
      // log a warning so users can see why their request 400'd.
      if (
        valueMap &&
        (!(thinking.effort in valueMap) || mappedRaw === null)
      ) {
        logForDebugging(
          `[vendor-template] effort '${thinking.effort}' is not a key in valueMap; transmitting as-is — the vendor may reject it`,
        )
      }
      const patch = substitutePlaceholder(
        structuredClone(template.effort.patch as Record<string, unknown>),
        '<value>',
        mapped,
      )
      deepMerge(out, patch)
    }

    if (thinking.budget !== undefined && template.budget && template.budget.patch) {
      const patch = substitutePlaceholder(
        structuredClone(template.budget.patch as Record<string, unknown>),
        '<budget>',
        thinking.budget,
      )
      deepMerge(out, patch)
    } else if (thinking.budget !== undefined && (!template.budget || !template.budget.patch)) {
      // User configured a budget on a template with no budget.patch.
      // The budget would silently disappear otherwise — log so the user
      // can see why their token cap isn't taking effect.
      logForDebugging(
        `[vendor-template] thinking.budget=${thinking.budget} ignored — the resolved template has no budget patch`,
      )
    }
  } else {
    if (template.disabledPatch) {
      deepMerge(out, structuredClone(template.disabledPatch as Record<string, unknown>))
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
 * Recursive object merge following RFC 7396 JSON Merge Patch semantics:
 *
 *   - Plain objects merge field-by-field (recursive).
 *   - Arrays are replaced wholesale (no element-level merge).
 *   - Primitives in `src` overwrite `dst`.
 *   - **`null` in `src` deletes the key from `dst`** (RFC 7396 §2).
 *
 * The null-delete rule enables three-layer template inheritance where a
 * child layer can explicitly remove a field inherited from a parent:
 *
 *   protocol:  { enabledPatch: { reasoning: { summary: 'auto' } } }
 *   vendor:    { enabledPatch: { reasoning: { summary: null } } }
 *   → merged:  { enabledPatch: { reasoning: {} } }
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
    // RFC 7396: null means "delete this key from the target".
    if (sv === null) {
      delete dst[k]
      continue
    }
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
