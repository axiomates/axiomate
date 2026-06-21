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
 *               deepseek-v4 needs prior reasoning/thinking replayed across
 *               tool calls. Today the OpenAI Chat adapter only supports the
 *               official/default `reasoning_content` replay shape; pin a
 *               modelTemplate when that model-level history behavior is
 *               actually needed.
 *
 * Three layers compose with RFC 7396 JSON Merge Patch semantics: deep
 * merge, arrays replaced, `null` deletes the inherited key. resolveStack
 * walks protocol → vendor → explicitly configured model template, merging
 * each in order, and emits the final ResolvedTemplate consumed by
 * applyThinkingTemplate. Built-in
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

/**
 * How an OpenAI Chat-compatible gateway expects assistant thinking to be
 * replayed in message history once a model-level template enables replay.
 */
export type ReasoningRoundTripFormat =
  | 'reasoning_content'

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

  /**
   * Echo reasoning_content back in the assistant message history on
   * subsequent tool calls. Required by some reasoning models (DeepSeek
   * V4+) to maintain reasoning context across tool-use turns.
   *
   * Recommended home: model templates, because this usually follows the
   * model across gateways. Kept in the shared patch shape as an escape hatch
   * for gateways that need to force or disable replay broadly.
   */
  autoRoundTripReasoningContent?: boolean | null

  /**
   * Message-history shape for replaying reasoning after
   * `autoRoundTripReasoningContent` opts in. Official DeepSeek uses top-level
   * `reasoning_content`.
   *
   * Recommended home: vendor templates, because this usually follows the
   * gateway wire schema. Model templates may override it for narrow quirks.
   */
  reasoningRoundTripFormat?: ReasoningRoundTripFormat | null
}

/**
 * A vendor template extends a protocol and overlays gateway-specific patches.
 *
 * Built-in vendors specify their `protocol` directly. Custom vendors can
 * either specify `protocol` (independent template) or `extends`
 * (inherits another vendor's full chain). Cycles and missing parents are
 * caught at resolveStack time.
 */
export type VendorTemplate = TemplatePatches & {
  /**
   * The wire protocol this vendor adapts to. Required at the chain leaf.
   * Inherited from `extends` when omitted.
   */
  protocol?: Protocol

  /** Inherit fields from another vendor template. */
  extends?: string

  /**
   * Optional auto-match. When the user didn't pin a vendor on their
   * model entry, inferVendor scans every vendor (custom + built-in)
   * for a matchBaseUrlRegex hit against the model entry's baseUrl.
   * Custom vendors win over built-ins on tie.
   *
   * Built-ins use this field to declare the host patterns their
   * gateways own (api.deepseek.com, siliconflow.cn, dashscope.aliyun*).
   * Custom vendors can opt in for the same auto-match behavior, or
   * leave it unset and rely on the user writing `vendor: 'my-name'`
   * explicitly on each model entry.
   */
  matchBaseUrlRegex?: string
}

/**
 * A model template overlays model-specific quirks on top of a vendor.
 * Selected per ModelProviderConfig via explicit `modelTemplate:`.
 * The matcher fields below are still used by onboarding and diagnostics to
 * recommend a template, but runtime resolution never applies one implicitly.
 *
 * `autoRoundTripReasoningContent` usually belongs here because it follows
 * the model across gateways (e.g. DeepSeek V4 needs it whether reached via
 * the official API, SiliconFlow, OpenRouter, or a private relay). Vendor
 * templates can still set it as an escape hatch.
 */
export type ModelTemplate = TemplatePatches & {
  /**
   * Required regex matched against the model name for wizard recommendations
   * and compatibility validation of explicit modelTemplate pins.
   *
   * Combined with matchVendorRegex / protocol below: ALL gates must
   * match (or be unset) for the template to apply. Mismatches are
   * silent during recommendation. For explicit pins, resolveStack rejects
   * incompatible template/model/vendor/protocol combinations with a clear
   * config error.
   */
  matchModelRegex: string

  /**
   * Optional regex matched against the resolved vendor template name. Lets
   * a model template scope itself to "this model AND on this vendor" — e.g.
   * a quirk that only manifests when GLM-5.1 is reached via SiliconFlow but
   * not when reached via aliyun.
   *
   * Combined with matchModelRegex via AND. When the field is omitted
   * (today's default), the model template matches on any vendor.
   */
  matchVendorRegex?: string

  /**
   * Optional protocol filter. When set, the template is recommended only for
   * that protocol, and explicit pins must use the same protocol.
   *
   * Set this when the template's patches or replay flags are meaningful only
   * for one wire shape. For example, the built-in DeepSeek V4+ replay
   * template targets OpenAI Chat history, so it declares `openai-chat`.
   * Leave it unset only for genuinely protocol-neutral overlays.
   */
  protocol?: Protocol

  /**
   * Optional baseUrl gate used for wizard recommendations. Runtime still
   * requires an explicit `modelTemplate` field; this only helps choose the
   * best default in onboarding when two model templates match the same model
   * name (for example a future gateway-specific DeepSeek overlay).
   */
  matchBaseUrlRegex?: string
}

/**
 * The protocol layer is a thin record of patches keyed by the three wire
 * protocols. Every resolveStack call starts here, then applies vendor,
 * then model.
 */
export type ProtocolTemplate = TemplatePatches

/**
 * Final shape consumed by applyThinkingTemplate after the three-layer merge.
 * Includes replay fields since every layer participates in the merge.
 */
export type ResolvedTemplate = TemplatePatches & {
  /** Protocol the resolved patches target — used for runtime routing. */
  protocol: Protocol
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
      // OpenAI's reasoning_effort domain grew to the same modern set as the
      // Responses API: none/minimal/low/medium/high/xhigh, model-dependent.
      // axiomate's picker is a fixed 4 tiers, so we map them onto the modern
      // GPT-5.x domain — names aligned for low/medium/high, 'max' reaching the
      // real top tier 'xhigh'. 'minimal' is intentionally dropped (it 400s on
      // models that don't support it). Models that predate 'xhigh'
      // (o1/o3/o4-mini) pin the openai-chat-oseries model template, which caps
      // 'max' back to 'high'. Third-party gateways (deepseek/aliyun/
      // siliconflow) override this valueMap with null entries to delete tiers
      // they don't accept.
      valueMap: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        max: 'xhigh',
      },
    },
  },
  'openai-responses': {
    enabledPatch: { reasoning: { summary: 'auto' } },
    effort: {
      patch: { reasoning: { effort: '<value>' } },
      // OpenAI's Responses API effort domain grew past the original four. It
      // now accepts none/minimal/low/medium/high/xhigh, but support is
      // model-dependent: o-series accepts only low/medium/high, GPT-5.x adds
      // the high-end 'xhigh', and (per OpenAI docs) GPT-5.4 omits 'minimal'.
      // axiomate's picker is a fixed 4 tiers, so we map them onto the *modern*
      // GPT-5.x domain — names aligned for the middle, with 'max' reaching the
      // real top tier 'xhigh'. We intentionally drop 'minimal': it 400s on the
      // models that don't support it, and 'low' is the more universally
      // accepted floor. Models that predate 'xhigh' (o1/o3/o4-mini) pin the
      // openai-responses-oseries model template, which caps 'max' back to
      // 'high' — see builtinModelTemplates below.
      valueMap: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        max: 'xhigh',
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
  // standard valueMap (minimal/low/medium/high). Vendors here exist only
  // for third-party gateways that override or null out tiers they don't
  // accept — the vanilla "OpenAI Chat Completions" case has no vendor
  // entry; resolveStack returns the protocol layer alone.
  'openai-chat-deepseek-official': {
    // The official api.deepseek.com vendor. DeepSeek V4+ family quirks
    // (autoRoundTripReasoningContent) live in the openai-chat-deepseek-v4p
    // model template — this vendor template only handles the gateway shape.
    //
    // DeepSeek requires a `thinking` switch alongside reasoning_effort and
    // rejects low/medium (only accepts high/max).
    protocol: 'openai-chat',
    matchBaseUrlRegex: '(^|//)api\\.deepseek\\.com(/|$)',
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
    matchBaseUrlRegex: 'dashscope\\.aliyun(cs)?\\.com',
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
    matchBaseUrlRegex: 'siliconflow\\.cn',
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
}

// ---------------------------------------------------------------------------
// Built-in model templates
// ---------------------------------------------------------------------------

/**
 * Model-level overlays. Runtime applies one only when a model entry sets
 * `modelTemplate:` explicitly. The matcher fields remain here so onboarding
 * can recommend a default while still allowing users to leave the model
 * layer unset.
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
    protocol: 'openai-chat',
    // The actual >=4 numeric threshold is enforced inside matchesModel
    // since regex alone can't express it.
    //
    // Keep this template to the official/default DeepSeek V4+ behavior:
    // replay prior thinking with OpenAI-compatible `reasoning_content`.
    // Other relay replay shapes are intentionally not modeled here until
    // their behavior is confirmed and the adapter grows explicit support.
    autoRoundTripReasoningContent: true,
    reasoningRoundTripFormat: 'reasoning_content',
  },
  'openai-responses-oseries': {
    // OpenAI's o-series reasoning models (o1 / o3 / o4-mini, etc.) on the
    // Responses API. Their effort domain is the original low/medium/high —
    // they predate 'xhigh', which the protocol layer now maps 'max' onto for
    // GPT-5.x. Pin this template to cap 'max' back to 'high' so the picker's
    // top tier stays valid instead of 400ing on an unsupported 'xhigh'.
    //
    // Regex: an 'o' followed by a single version digit, anchored at the start
    // or after a separator (handles bare `o3-mini` and prefixed
    // `openai/o4-mini`). The leading boundary keeps it from matching `gpt-4o`
    // (its trailing 'o' is not followed by a digit) or other families.
    matchModelRegex: '(?:^|[-_/:\\s])o[1-9](?:-|$)',
    protocol: 'openai-responses',
    effort: {
      // Remap (not delete) so ModelPicker still shows the 'max' tier; it just
      // resolves to 'high' on the wire. low/medium/high inherit from the
      // protocol layer unchanged.
      valueMap: { max: 'high' },
    },
  },
  'openai-chat-oseries': {
    // Same o-series cap as openai-responses-oseries, but for the Chat
    // Completions wire. The openai-chat protocol layer also maps 'max' →
    // 'xhigh' now; o-series predates xhigh, so cap it back to 'high'. Kept as
    // a separate protocol-gated template (mirroring the openai-chat- /
    // openai-responses- naming convention) rather than one protocol-neutral
    // template, so it never leaks into anthropic recommendations.
    matchModelRegex: '(?:^|[-_/:\\s])o[1-9](?:-|$)',
    protocol: 'openai-chat',
    effort: {
      valueMap: { max: 'high' },
    },
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
  return name in builtinVendorTemplates || PROTOCOLS.includes(name as Protocol)
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
  /**
   * Explicit model-template pin from ModelProviderConfig.modelTemplate.
   * Omitted means no model layer is applied. inferModelTemplate is only a
   * wizard recommendation helper; it is not part of runtime resolution.
   */
  modelTemplate?: string | null
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
 *   3. Apply a model template only when the model entry explicitly sets
 *      `modelTemplate`. The template's matcher fields are then treated as
 *      compatibility guards; mismatches throw a config error instead of
 *      silently changing the wire body.
 *   4. deepMerge the three layers using RFC 7396 semantics (`null` keys
 *      delete inherited fields).
 *
 * Throws on cycles, unknown vendors, vendor↔entry protocol mismatch,
 * or invalid regexes.
 */
export function resolveStack(input: ResolveInput): ResolvedTemplate {
  const protocolPatches =
    builtinProtocolTemplates[input.protocol] ?? {}

  const vendorName =
    input.vendor ?? inferVendor(input, input.customVendors)
  const vendorTemplate = vendorName
    ? resolveVendorChain(vendorName, input.customVendors)
    : undefined
  const vendorProtocol = vendorTemplate?.protocol
  if (vendorProtocol && vendorProtocol !== input.protocol) {
    throw new Error(
      `Vendor template '${vendorName}' targets protocol '${vendorProtocol}' but model is configured with protocol '${input.protocol}'.`,
    )
  }

  const modelTemplateName = input.modelTemplate || undefined
  const modelTemplate = modelTemplateName
    ? resolveModelTemplate(modelTemplateName, input.customModels)
    : undefined
  if (
    modelTemplateName &&
    modelTemplate &&
    !matchesModel(
      modelTemplate,
      input.model,
      vendorName ?? '',
      input.protocol,
      modelTemplateName,
      input.baseUrl,
    )
  ) {
    throw new Error(
      `Model '${input.model}' explicitly references modelTemplate '${modelTemplateName}', but that template does not match this model/vendor/protocol/baseUrl combination.`,
    )
  }

  const merged: TemplatePatches & { protocol?: Protocol } = {}
  deepMerge(merged as Record<string, unknown>, structuredClone(protocolPatches as Record<string, unknown>))
  if (vendorTemplate) {
    deepMerge(merged as Record<string, unknown>, structuredClone(vendorTemplate as Record<string, unknown>))
  }
  if (modelTemplate) {
    deepMerge(merged as Record<string, unknown>, structuredClone(modelTemplate as Record<string, unknown>))
  }
  // Strip resolution-only fields the caller doesn't need.
  delete (merged as Record<string, unknown>).extends
  delete (merged as Record<string, unknown>).matchModelRegex
  delete (merged as Record<string, unknown>).matchVendorRegex
  delete (merged as Record<string, unknown>).matchBaseUrlRegex
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
    // Protocol names are valid chain terminals — they represent
    // "vanilla protocol layer" with no gateway override. Treat as a
    // synthetic vendor template that only declares the protocol. Custom
    // templates with the same name take precedence (looked up first).
    if (
      PROTOCOLS.includes(current as Protocol) &&
      !custom?.[current] &&
      !builtinVendorTemplates[current]
    ) {
      chain.push({ protocol: current as Protocol })
      break
    }
    const tpl = custom?.[current] ?? builtinVendorTemplates[current]
    if (!tpl) {
      throw new Error(
        `Unknown vendor template: '${current}'. Built-in vendors: ${[...PROTOCOLS, ...Object.keys(builtinVendorTemplates)].join(', ')}`,
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
 *
 * `name` may also be a protocol identifier ('anthropic', 'openai-chat',
 * 'openai-responses'), in which case the returned template is just the
 * protocol layer with `protocol` set — equivalent to "vanilla protocol
 * with no gateway override."
 *
 * Vendors that don't declare a protocol (and don't inherit one) are
 * allowed — those represent "API quirks that don't fit cleanly into a
 * single protocol." resolveTemplate returns the vendor patches alone in
 * that case (no protocol-layer merge).
 */
export function resolveTemplate(
  name: string,
  customTemplates?: Record<string, VendorTemplate>,
): VendorTemplate {
  // Treat protocol names as "vanilla protocol layer" — no vendor chain
  // lookup needed. Avoids the empty-shell vendor templates that used to
  // exist solely to make this path resolvable. Custom templates with
  // the same name override this (resolveVendorChain handles them).
  if (PROTOCOLS.includes(name as Protocol) && !customTemplates?.[name]) {
    const protocolPatches = builtinProtocolTemplates[name as Protocol] ?? {}
    return {
      ...structuredClone(protocolPatches),
      protocol: name as Protocol,
    }
  }
  const vendor = resolveVendorChain(name, customTemplates)
  const merged: VendorTemplate = {}
  if (vendor.protocol) {
    const protocolPatches = builtinProtocolTemplates[vendor.protocol] ?? {}
    deepMerge(merged as Record<string, unknown>, structuredClone(protocolPatches as Record<string, unknown>))
  }
  deepMerge(merged as Record<string, unknown>, structuredClone(vendor as Record<string, unknown>))
  delete merged.extends
  return merged
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

/**
 * Pick a vendor template when the user didn't pin one via `vendor:` on
 * the model entry. Returns `undefined` when no specific gateway matches —
 * resolveStack falls back to protocol-only resolution in that case (no
 * vendor layer is needed for the vanilla path).
 *
 * Walk vendor templates (custom > built-in) and pick the first whose
 * `matchBaseUrlRegex` matches the model entry's baseUrl AND whose
 * `protocol` matches the entry's protocol (or is unset). Built-ins ship
 * with patterns for known openai-chat gateways (api.deepseek.com,
 * siliconflow.cn, dashscope.aliyun*). Custom vendors can opt in by
 * setting their own regex.
 *
 * Vendors with no matchBaseUrlRegex are skipped during auto-match —
 * the user must pin them explicitly via `vendor: 'name'`.
 *
 * NOTE: model-name-based vendor inference (e.g. "deepseek-v4 → vendor X")
 * was removed in the three-layer refactor. Model quirks now live in the
 * model template layer (openai-chat-deepseek-v4p), independent of which
 * gateway the user picked.
 */
export function inferVendor(
  config: Pick<ModelProviderConfig, 'protocol' | 'model'> & { baseUrl?: string },
  customVendors?: Record<string, VendorTemplate>,
): string | undefined {
  const url = config.baseUrl ?? ''

  // Walk custom first (so users can override / pre-empt a built-in match
  // for the same host pattern), then built-ins.
  const candidates: Array<[string, VendorTemplate]> = [
    ...Object.entries(customVendors ?? {}),
    ...Object.entries(builtinVendorTemplates),
  ]
  for (const [name, tpl] of candidates) {
    if (!tpl.matchBaseUrlRegex) continue
    // Only consider vendors whose protocol matches (or is unset). A
    // deepseek-official vendor under openai-chat shouldn't match an
    // anthropic baseUrl even if the regex hits.
    if (tpl.protocol && tpl.protocol !== config.protocol) continue
    let re: RegExp
    try {
      re = new RegExp(tpl.matchBaseUrlRegex, 'i')
    } catch {
      logForDebugging(
        `[vendor-template] '${name}' has invalid matchBaseUrlRegex; ignoring.`,
      )
      continue
    }
    if (re.test(url)) return name
  }

  return undefined
}

/**
 * Recommend a model template that matches `model` by regex, additionally
 * gated by the resolved `vendorName`, `protocol`, and optional `baseUrl` of
 * the model entry. Returns the template name, or undefined when nothing
 * matches. Custom templates win on regex collision.
 *
 * This is a recommendation helper for onboarding and diagnostics only.
 * resolveStack does not call it; runtime applies a model template only when
 * the model entry explicitly sets `modelTemplate`.
 *
 * A model template applies when ALL of:
 *   - matchModelRegex matches the model name (required — model templates
 *     is the recommender signal)
 *   - matchVendorRegex matches the resolved vendor name (when set;
 *     absent = applies on any vendor)
 *   - the template's `protocol` equals the entry's protocol (when set;
 *     absent = applies on any protocol)
 *   - matchBaseUrlRegex matches the entry's baseUrl (when set;
 *     absent = applies on any baseUrl)
 *
 * All filters are silent in this recommendation path — a non-matching
 * template is simply not recommended.
 *
 * Built-in `openai-chat-deepseek-v4p` additionally enforces the >=4
 * numeric threshold from DEEPSEEK_REASONING_RE; lower versions don't
 * apply the V4 family quirks.
 */
export function inferModelTemplate(
  model: string,
  vendorName: string | undefined,
  protocol: Protocol | undefined,
  custom?: Record<string, ModelTemplate>,
  baseUrl?: string,
): string | undefined {
  return getMatchingModelTemplates(
    model,
    vendorName,
    protocol,
    custom,
    baseUrl,
  )[0]
}

export function getMatchingModelTemplates(
  model: string,
  vendorName: string | undefined,
  protocol: Protocol | undefined,
  custom?: Record<string, ModelTemplate>,
  baseUrl?: string,
): string[] {
  const customEntries = Object.entries(custom ?? {})
  const customNames = new Set(customEntries.map(([name]) => name))
  const candidates: Array<[string, ModelTemplate]> = [
    ...customEntries,
    ...Object.entries(builtinModelTemplates).filter(([name]) => !customNames.has(name)),
  ]
  return candidates
    .filter(([name, tpl]) =>
      matchesModel(tpl, model, vendorName ?? '', protocol, name, baseUrl),
    )
    .map(([name]) => name)
}

function matchesModel(
  tpl: ModelTemplate,
  model: string,
  vendorName: string,
  protocol: Protocol | undefined,
  name: string,
  baseUrl?: string,
): boolean {
  // matchModelRegex is required. Without it, a model template has no
  // way to be recommended or compatibility-checked against a model entry.
  if (!tpl.matchModelRegex) {
    logForDebugging(
      `[model-template] '${name}' has no matchModelRegex; ignoring.`,
    )
    return false
  }
  let modelRe: RegExp
  try {
    modelRe = new RegExp(tpl.matchModelRegex, 'i')
  } catch {
    logForDebugging(
      `[model-template] '${name}' has invalid matchModelRegex; ignoring.`,
    )
    return false
  }
  const m = modelRe.exec(model)
  if (!m) return false

  // Optional vendor gate.
  if (tpl.matchVendorRegex) {
    let vendorRe: RegExp
    try {
      vendorRe = new RegExp(tpl.matchVendorRegex, 'i')
    } catch {
      logForDebugging(
        `[model-template] '${name}' has invalid matchVendorRegex; ignoring.`,
      )
      return false
    }
    if (!vendorRe.test(vendorName)) return false
  }

  // Optional protocol gate. Silent filter: a model template that
  // declares protocol just doesn't get recommended when the entry's protocol
  // doesn't match. Explicit pins are validated by resolveStack, which turns
  // this false result into a clear config error.
  if (tpl.protocol && tpl.protocol !== protocol) return false

  // Optional baseUrl gate. This is primarily for recommendations when two
  // model templates target the same model family but only one is appropriate
  // for a specific relay.
  if (tpl.matchBaseUrlRegex) {
    let baseUrlRe: RegExp
    try {
      baseUrlRe = new RegExp(tpl.matchBaseUrlRegex, 'i')
    } catch {
      logForDebugging(
        `[model-template] '${name}' has invalid matchBaseUrlRegex; ignoring.`,
      )
      return false
    }
    if (!baseUrlRe.test(baseUrl ?? '')) return false
  }

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
