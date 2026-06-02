# Template System

This document describes axiomate's three-layer template DSL — the system
that translates a model's neutral `thinking: { enabled, effort?, budget? }`
declaration into the wire-body fragment a specific API endpoint expects.

It exists because the wire shape a model needs is fragmented along three
independent axes that single-layer vendor templates couldn't cleanly
disentangle:

- **protocol** — wire envelope (which SDK / endpoint).
  `anthropic` / `openai-chat` / `openai-responses`.

- **vendor** — gateway-specific quirks layered on top of a protocol.
  aliyun's `enable_thinking` + `reasoning_effort: xhigh`, SiliconFlow's
  `enable_thinking`, OpenAI's `reasoning_effort` vs `reasoning.effort`,
  DeepSeek's `thinking.type` switch, etc.

- **model** — quirks that follow the *model itself* across gateways.
  DeepSeek V4+ needs prior reasoning/thinking round-tripped on tool calls.
  The current OpenAI Chat adapter supports the official/default
  `reasoning_content` replay shape only. Runtime applies a model template
  only when the model entry explicitly sets `modelTemplate`; the wizard uses
  matcher fields to recommend one.

## Resolution

When axiomate prepares a request for a model, it builds the wire body
through `resolveStack`, which deep-merges three layers in order:

```
            protocol patches  →  vendor patches  →  model patches
```

Merge follows **RFC 7396 JSON Merge Patch** semantics:

- Plain objects merge field-by-field (recursive).
- Arrays replace wholesale (no element merge).
- **`null` deletes the inherited key** at any depth.
- Primitives in the child layer overwrite the parent.

This lets a vendor null out tiers it doesn't accept (`valueMap: { low: null }`),
and lets a model template add its own quirks on top of any vendor without
the vendor knowing.

## Field map

### Protocol layer (built-in only)

Holds anything the protocol itself defines — fields that any vendor
implementing this wire envelope must use. Users cannot register custom
protocols; the three are fixed.

| Protocol | What lives here |
|---|---|
| `anthropic` | `output_config.effort` patch + `low/medium/high` valueMap + `thinking.budget_tokens` patch + `anthropicThinkingField` (SDK-side default) |
| `openai-chat` | `reasoning_effort` patch + OpenAI's standard 4-tier valueMap (`low→minimal, medium→low, high→medium, max→high`) |
| `openai-responses` | `reasoning.effort` patch + same 4-tier valueMap + `reasoning.summary: 'auto'` enabledPatch |

### Vendor layer

Owns gateway-specific deviations from the protocol's standard. Built-in:

| Vendor | Protocol | Quirks |
|---|---|---|
| `openai-chat-deepseek-official` | `openai-chat` | `thinking.type` switch + valueMap deletes low/medium |
| `openai-chat-aliyun` | `openai-chat` | `enable_thinking` + `thinking_budget` + valueMap deletes low/medium + remaps max → xhigh |
| `openai-chat-siliconflow` | `openai-chat` | `enable_thinking` + `thinking_budget` + valueMap deletes low/medium |

User-defined vendors live under `~/.axiomate.json`'s top-level `templates`
field. `protocol` is **optional** at this layer: a vendor template that
doesn't declare a protocol won't get protocol-layer patches merged in
(it stands alone), and won't be filtered out of the wizard's vendor
list — it appears for every protocol. This accommodates API quirks
that don't fit any single protocol cleanly. Vendors that DO declare a
protocol get that protocol's patches merged on top, and are filtered
to compatible model entries.

`VendorTemplate` schema:

```ts
{
  protocol?: 'anthropic' | 'openai-chat' | 'openai-responses'
  extends?: string                     // parent template name

  // Optional auto-match against the model entry's baseUrl. inferVendor
  // picks the first vendor whose regex hits when the user didn't pin
  // `vendor:` explicitly. Custom vendors win over built-ins.
  matchBaseUrlRegex?: string

  enabledPatch?: dict | null           // when thinking.enabled=true
  disabledPatch?: dict | null          // when thinking.enabled=false (or effort=='none')
  effort?: {
    patch?: dict | null                // contains '<value>' placeholder
    valueMap?: {                       // each tier: string wire value, or null to delete
      low?:    string | null
      medium?: string | null
      high?:   string | null
      max?:    string | null
    }
  } | null
  budget?: { patch?: dict | null } | null   // contains '<budget>' placeholder
  anthropicThinkingField?: { defaultBudgetTokens: number } | null
  autoRoundTripReasoningContent?: boolean | null
  reasoningRoundTripFormat?: 'reasoning_content' | null
}
```

`autoRoundTripReasoningContent` and `reasoningRoundTripFormat` are accepted
on both vendor templates and model templates. The recommended split is:
use model templates for model-specific replay behavior. Gateway-wide replay
defaults can still live in vendor templates, but model templates are merged
after vendor templates, so the model layer wins if both set the same field.

### Model layer

Owns quirks specific to a model that travel with it across gateways.
Built-in:

| Model template | Protocol gate | Recommendation match | Quirks |
|---|---|---|---|
| `openai-chat-deepseek-v4p` | `openai-chat` | `\bdeepseek[\s\-_]*v?[\s\-_]*\d+` (with version >= 4) | `autoRoundTripReasoningContent: true`, `reasoningRoundTripFormat: reasoning_content` |

User-defined model templates live under `~/.axiomate.json`'s top-level
`modelTemplates` field.

`ModelTemplate` schema:

```ts
{
  // REQUIRED. Used by the wizard to recommend templates and by resolveStack
  // to validate explicit models[*].modelTemplate pins.
  matchModelRegex: string

  // Optional gate. When set, the resolved vendor name must also match.
  // Lets a quirk scope to "this model AND on this specific vendor" —
  // e.g. GLM-5.1 only-on-SiliconFlow workarounds.
  matchVendorRegex?: string

  // Optional baseUrl gate for recommendations / compatibility validation.
  matchBaseUrlRegex?: string

  // Optional protocol filter. When set, explicit modelTemplate pins must
  // use this same protocol.
  protocol?: 'anthropic' | 'openai-chat' | 'openai-responses'

  enabledPatch?: dict | null
  disabledPatch?: dict | null
  effort?: { patch?, valueMap? } | null
  budget?: { patch? } | null
  anthropicThinkingField?: ... | null
  autoRoundTripReasoningContent?: boolean | null
  reasoningRoundTripFormat?: 'reasoning_content' | null
}
```

All filters (`matchModelRegex` + optional `matchVendorRegex` +
`matchBaseUrlRegex` + `protocol`) combine via AND. During wizard
recommendation, non-matching templates are skipped. During runtime
resolution, an explicit `modelTemplate` whose gates do not match throws a
configuration error.

Note: ModelTemplate has **no `extends`**. Model overlays don't form
inheritance chains — they apply one at a time, on top of whatever
vendor was resolved.

### Model entry (`~/.axiomate.json` `models[id]`)

The user's per-model configuration:

```ts
{
  // Identity
  model: string                  // provider-native ID, e.g. "deepseek-v4-pro"
  name?: string                  // UI label
  description?: string

  // Network layer
  protocol: 'anthropic' | 'openai-chat' | 'openai-responses'
  baseUrl: string
  apiKey: string

  // Template selection
  vendor?: string                // pin vendor template; otherwise inferred from baseUrl
  modelTemplate?: string         // explicit model overlay; omitted = none

  // Capacity / capability
  contextWindow?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  stallTimeoutMs?: number

  // Runtime preference (translated by templates into wire fields)
  thinking?: {
    enabled: boolean
    effort?: 'none' | 'low' | 'medium' | 'high' | 'max'
    budget?: number
  }

  // Misc
  repairToolCalls?: boolean      // auto-fix malformed tool call JSON
  extraParams?: dict             // pass-through arbitrary fields to wire body
  usageMapping?: ...             // map vendor-custom usage fields
  userAgent?: string
}
```

### Top-level config (`~/.axiomate.json` root)

```ts
{
  models?: Record<string, ModelProviderConfig>
  templates?: Record<string, VendorTemplate>
  modelTemplates?: Record<string, ModelTemplate>
  model?: {
    defaultRoute?: string
    routes?: Record<string, ModelRouteConfig>
  }
  auxiliary?: Record<string, AuxiliaryTaskConfig>
  // ... UI / state fields unrelated to templates: theme, tipsHistory, etc.
}
```

`models` is only the concrete provider resource map. Main-agent routing lives
under `model.defaultRoute` / `model.routes`, and background or side-task routing
lives under `auxiliary.<task>`. Template examples should use only this route
and task-policy shape for model selection.

Auxiliary task policies share route fields (`primary`, `fallbackChain`,
`recoveryProfile`, `allowActions`, `switchModelOn`) and add task-only controls:
`failure`, `timeoutMs`, `maxOutputTokens`, and the reserved `extraBody`. Use
`auxiliary.<task>.maxOutputTokens` when a task should ask for shorter output
than the model resource normally allows.

## The `thinking` field

`thinking` is the user's runtime preference for thinking on a model.
It is **not** a wire field — `applyThinkingTemplate` consumes the
declaration and produces vendor-specific wire fields based on the
resolved three-layer template.

```ts
type ThinkingDecl = {
  enabled: boolean              // master switch — on/off
  effort?: 'none' | 'low' | 'medium' | 'high' | 'max'  // default tier
  budget?: number               // thinking-token budget (e.g. 8192)
}
```

### Concrete example (your GLM-5.1 entry)

```jsonc
{
  "model": "Pro/zai-org/GLM-5.1",
  "protocol": "openai-chat",
  "vendor": "openai-chat-siliconflow",
  "thinking": { "enabled": true, "effort": "high", "budget": 8192 }
}
```

End-to-end verified wire body:

```json
{
  "enable_thinking": true,
  "reasoning_effort": "high",
  "thinking_budget": 8192
}
```

Field-by-field translation:

| You write | Three-layer DSL path | Wire field |
|---|---|---|
| `enabled: true` | vendor `openai-chat-siliconflow.enabledPatch: { enable_thinking: true }` | `enable_thinking: true` |
| `effort: "high"` | protocol `openai-chat.effort.patch: { reasoning_effort: "<value>" }` + vendor `valueMap.high: "high"` | `reasoning_effort: "high"` |
| `budget: 8192` | vendor `openai-chat-siliconflow.budget.patch: { thinking_budget: "<budget>" }` | `thinking_budget: 8192` |

The same neutral `thinking` declaration produces a **different wire body**
for each vendor — that's the whole point. Switching this entry's
`vendor` to `openai-chat-aliyun` makes `effort: "high"` map to
`xhigh`, and to `openai-chat-deepseek-official` adds a `thinking.type`
switch instead of `enable_thinking`.

### `enabled: boolean` — master switch

| Value | Wire-body effect |
|---|---|
| `true` | applies vendor `enabledPatch` + applies `effort` + applies `budget` |
| `false` | applies vendor `disabledPatch`; **`effort` and `budget` are silently ignored** with a debug warning |

Examples (varying vendor):

- `enabled: true` on SiliconFlow → wire has `enable_thinking: true`
- `enabled: false` on SiliconFlow → wire has `enable_thinking: false`,
  no `reasoning_effort`, no `thinking_budget`
- `enabled: false` on `openai-chat-deepseek-official` → wire has
  `thinking: { type: "disabled" }`
- `enabled: false` on `openai-chat` (no `disabledPatch`) →
  wire has **no thinking-related fields at all**

### `effort: 'none' | 'low' | 'medium' | 'high' | 'max'` — default tier

The model's **starting** effort tier — not the absolute final value. The
runtime resolves the actual effort sent on each request through this
priority chain:

```
env  AXIOMATE_CODE_EFFORT_LEVEL              (highest)
↓ otherwise
session AppState.effortValueByModel[model]   (per-model picker memory,
                                              persists across sessions
                                              via settings.effortByModel)
↓ otherwise
~/.axiomate.json models[id].thinking.effort  ← THE FIELD YOU SET
↓ otherwise
'high'                                       (hardcoded fallback)
```

Important consequence: **the picker never overwrites `thinking.effort`**
in `~/.axiomate.json`. That field stays as the model's "factory default."
Picker selections live in `~/.axiomate/settings.json` under
`effortByModel`, which takes priority on subsequent loads.

### `budget: number` — thinking-token budget

Only takes effect when the resolved template has a `budget.patch`.
Built-in coverage:

| Vendor / Protocol | budget patch | Wire field |
|---|---|---|
| `openai-chat-siliconflow` | ✅ | `thinking_budget: <budget>` |
| `openai-chat-aliyun` | ✅ | `thinking_budget: <budget>` |
| `anthropic` (protocol) | ✅ | `thinking.budget_tokens: <budget>` |
| `openai-chat` | ❌ — silently ignored + debug warning |  |
| `openai-chat-deepseek-official` | ❌ — same |  |
| `openai-responses` | ❌ — same |  |

If you write `budget: 8192` on a vendor without a `budget.patch`, the
field is dropped at request time with this debug message:

```
[vendor-template] thinking.budget=8192 ignored — the resolved template has no budget patch
```

### Field interactions

| Configuration | Effect |
|---|---|
| `{ enabled: true, effort: 'high', budget: 8192 }` | thinking on, effort 'high', budget 8192 (your GLM-5.1) |
| `{ enabled: true, effort: 'high' }` | thinking on, effort 'high', no budget |
| `{ enabled: true }` | thinking on, no explicit effort/budget — picker shows the effort row, session starts at the hardcoded fallback `'high'` |
| `{ enabled: false }` | thinking off; picker hides the effort row entirely (`modelSupportsEffort=false`) |
| `{ enabled: false, effort: 'high' }` | thinking off — `effort` silently ignored + debug warning. Self-contradictory; pick one |
| `{ enabled: true, effort: 'none' }` | **Special case**: picker shows the effort row with `'none'` as default. Session starts on `disabledPatch`; left/right cycles to a tier and runtime switches to `enabledPatch + effort.patch`. Covers the "thinking-on-with-token-saving-default" use case |

### Two common confusions

**Confusion 1: `enabled: false` vs `enabled: true, effort: 'none'`**

| | `enabled: false` | `enabled: true, effort: 'none'` |
|---|---|---|
| Picker shows effort row | ❌ no (`modelSupportsEffort=false`) | ✅ yes, default `'none'` |
| Session-start patch | `disabledPatch` | `disabledPatch` |
| Cycle to `'high'` then run | not possible (no row to cycle) | wire body = `enabledPatch + effort.patch` |

Use `enabled: false` when the model **never** thinks. Use
`enabled: true, effort: 'none'` when the model **could** think but you
want it off by default and reachable via the picker.

**Confusion 2: model entry effort vs settings effortByModel**

```
~/.axiomate.json  models[m].thinking.effort   ← that model's factory default
~/.axiomate/settings.json  effortByModel[m]   ← user's most recent picker pick
```

The settings value wins on startup if present. If the user has never
toggled the picker for model `m`, `settings.effortByModel[m]` is unset
and the runtime falls back to `~/.axiomate.json`'s value.

### Why this design

The neutral `thinking` declaration decouples **what the user wants**
from **how each vendor expresses it on the wire**. Switching `vendor`
on the same model entry changes the wire body shape automatically; the
user's `thinking` field stays the same.

This is the core value proposition of the three-layer DSL: write
preferences once, let the templates handle the wire-protocol
fragmentation.

## Where to write each kind of quirk

| Quirk class | Layer | Example |
|---|---|---|
| **Protocol-defined field** | protocol (built-in only) | `output_config.effort` for anthropic |
| **API gateway extension** | vendor template | aliyun's `enable_thinking`, deepseek's `thinking.type` |
| **Model quirk** | model template | DeepSeek V4+ reasoning replay via `reasoning_content` |
| **Runtime preference** | model entry `thinking` field | `enabled: true, effort: 'high'` |
| **Wire-protocol settings** | model entry top level | `baseUrl`, `apiKey`, `supportsImages`, `contextWindow` |

Most users only write the last two categories. Vendor templates are
auto-resolved only when they declare `matchBaseUrlRegex`; model templates
are explicit runtime pins, with matcher fields used by the wizard to
recommend a value.

## Auto-inference

When the user omits `vendor` on a model entry, axiomate auto-resolves
it. Model templates are not auto-applied at runtime.

### Vendor inference (`inferVendor`)

Gateway-only; ignores model name:

1. `protocol === 'anthropic'` → `anthropic`
2. `protocol === 'openai-responses'` → `openai-responses`
3. `protocol === 'openai-chat'`:
   - Walk vendor templates (custom > built-in) and pick the first whose
     `matchBaseUrlRegex` matches the model entry's baseUrl. Built-ins
     ship with patterns for known safe gateway-wide schemas
     (`api.deepseek.com`, `siliconflow.cn`, `dashscope.aliyun*.com`).
     Custom vendors that set `matchBaseUrlRegex` join the auto-match pool
     — those without the field require `vendor: 'name'` on the model
     entry.
   - Fallback: no vendor layer; the protocol layer handles vanilla
     `openai-chat`.

The vendor wire schema is determined by the gateway, not by which model
the gateway hosts — DeepSeek-V4 reached via SiliconFlow uses SiliconFlow's
schema, not DeepSeek's official schema.

### Model template recommendations (`inferModelTemplate`)

Walks the `modelTemplates` registry (custom first, then built-in) to
recommend a template in the add-model wizard. A template is recommended when
**all** of:

- `matchModelRegex` matches the model name (required).
- `matchVendorRegex` matches the resolved vendor name, if the field is
  set (otherwise wildcard).
- `matchBaseUrlRegex` matches the model entry's baseUrl, if the field is
  set (otherwise wildcard).
- The template's `protocol` equals the entry's protocol, if the field
  is set (otherwise wildcard).

All filters combine via AND; any failure silently skips the template in the
recommendation path. Runtime resolution does **not** call this helper.
Runtime applies a model template only when the model entry explicitly sets
`modelTemplate`, and then the same matcher fields become compatibility
guards. A mismatch throws a config error.

`openai-chat-deepseek-v4p` additionally enforces a numeric `>=4` threshold
on the captured DeepSeek version digit to avoid matching DeepSeek v3.

## Conflict and edge-case semantics

When the user's `model entry` config doesn't match the vendor's expected
shape, **axiomate prefers the user's literal value** rather than silently
correcting. This is by design — a config field the user wrote is always
treated as a fact, not a suggestion. Inconsistencies emit a
`logForDebugging` warning so the cause is recoverable post-hoc.

### A. `effort` value the vendor's valueMap doesn't accept

Example: `vendor: 'openai-chat-siliconflow'` (deletes low/medium tiers)
+ `thinking: { effort: 'low' }`.

- **ModelPicker**: cyclable set is `[none, high, max]`; left/right keys
  skip `low` entirely.
- **Display**: when an inherited default falls outside the cyclable
  set, `displayEffort` clamps to a nearby legal tier for visual purposes.
- **Wire**: `applyThinkingTemplate` looks up `valueMap['low']`. The entry
  is `null` (explicitly deleted by the vendor). Fallback emits the
  literal `'low'` to the wire body, **plus** a `logForDebugging` warning:
  ```
  [vendor-template] effort 'low' is not a key in valueMap; transmitting
  as-is — the vendor may reject it
  ```
- **Server response**: SiliconFlow rejects with HTTP 400.

The user-visible failure mode is a vendor 400 error. The debug log
explains why.

### B. `thinking.budget` set but the resolved template has no `budget.patch`

Example: vanilla `openai-chat` (no budget patch in the OpenAI chat
protocol) + `thinking: { budget: 4096 }`.

- **Wire**: budget is silently dropped — there's nowhere to put it.
- **Warning**: `logForDebugging` emits:
  ```
  [vendor-template] thinking.budget=4096 ignored — the resolved
  template has no budget patch
  ```

### C. `thinking.enabled: false` together with a non-`'none'` `effort`

Example: `thinking: { enabled: false, effort: 'high' }`.

- **Wire**: routes through `disabledPatch` only. The `effort: 'high'`
  is ignored.
- **Warning**:
  ```
  [vendor-template] thinking.effort='high' ignored —
  thinking.enabled=false routes through disabledPatch (use effort:'none'
  or remove enabled:false to send effort)
  ```

To temporarily disable thinking while keeping the picker live, prefer
`effort: 'none'` (a runtime override that sends `disabledPatch`) over
`enabled: false` (which prevents the picker from working).

## Worked examples

### Example 1: DeepSeek V4 on the official API

`~/.axiomate.json`:

```jsonc
{
  "models": {
    "deepseek-v4-pro": {
      "model": "deepseek-v4-pro",
      "protocol": "openai-chat",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "modelTemplate": "openai-chat-deepseek-v4p",
      "thinking": { "enabled": true, "effort": "high" }
    }
  }
}
```

Resolution:

1. Protocol layer: `openai-chat` → `reasoning_effort` patch + standard valueMap
2. Vendor layer (auto): `inferVendor` matches `api.deepseek.com` →
   `openai-chat-deepseek-official` → adds `thinking.type` switch and
   nulls out low/medium in valueMap
3. Model layer (explicit): `modelTemplate: openai-chat-deepseek-v4p` adds
   `autoRoundTripReasoningContent: true` and
   `reasoningRoundTripFormat: reasoning_content`

Wire body:
```json
{ "thinking": { "type": "enabled" }, "reasoning_effort": "high" }
```
Plus the openaiProvider sets `roundTripReasoningContent: true` on the
request, so subsequent tool calls echo `reasoning_content`.

### Example 2: DeepSeek V4 reached via SiliconFlow

```jsonc
{
  "model": "deepseek-ai/DeepSeek-V4-Flash",
  "protocol": "openai-chat",
  "baseUrl": "https://api.siliconflow.cn/v1",
  "apiKey": "sk-...",
  "modelTemplate": "openai-chat-deepseek-v4p",
  "thinking": { "enabled": true, "effort": "max" }
}
```

Resolution:

1. Protocol: `openai-chat` (same as above)
2. Vendor (auto): `inferVendor` matches `siliconflow.cn` →
   `openai-chat-siliconflow` → adds `enable_thinking` and
   `thinking_budget`, nulls out low/medium
3. Model (explicit): `modelTemplate: openai-chat-deepseek-v4p` adds
   `autoRoundTripReasoningContent: true`

Wire body:
```json
{ "enable_thinking": true, "reasoning_effort": "max" }
```
**Plus** the model-layer `autoRoundTripReasoningContent: true` still
applies, so the SiliconFlow gateway sees the same round-trip behavior
DeepSeek's V4 needs. Cross-gateway portability of the model quirk is
the whole point of separating the model layer from the vendor layer.

### Example 3: OpenAI o-series via the Responses API

```jsonc
{
  "model": "gpt-5.4",
  "protocol": "openai-responses",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "thinking": { "enabled": true, "effort": "max" }
}
```

Resolution:

1. Protocol: `openai-responses` → `reasoning.effort` patch + 4-tier
   valueMap + `reasoning.summary: 'auto'` enabledPatch
2. Vendor: no gateway-specific template; protocol layer only
3. Model: no `modelTemplate`; nothing applied

Wire body:
```json
{ "reasoning": { "effort": "high", "summary": "auto" } }
```

(`max → high` per the standard valueMap remap.)

### Example 4: Custom vendor for a third-party gateway

The user runs DeepSeek V4 through a private relay that uses a non-
standard wire field:

```jsonc
{
  "models": {
    "my-relay-deepseek": {
      "model": "deepseek-v4-pro",
      "protocol": "openai-chat",
      "vendor": "my-private-relay",
      "modelTemplate": "openai-chat-deepseek-v4p",
      "baseUrl": "https://relay.internal.example/v1",
      "apiKey": "..."
    }
  },
  "templates": {
    "my-private-relay": {
      "extends": "openai-chat-deepseek-official",
      "enabledPatch": { "x_custom_thinking": "enabled" },
      "effort": {
        "valueMap": { "high": "premium", "max": null }
      }
    }
  }
}
```

`extends: 'openai-chat-deepseek-official'` inherits the deepseek vendor's
`thinking.type` switch and valueMap deletion of low/medium. Then:

- `enabledPatch.x_custom_thinking: 'enabled'` adds the relay's custom
  field on top.
- `valueMap.high: 'premium'` overrides the inherited `'high'` mapping.
- `valueMap.max: null` deletes the `max` tier (relay doesn't support it).

The model layer applies because the model entry explicitly sets
`modelTemplate: "openai-chat-deepseek-v4p"`.

### Example 5: Custom model template for a hypothetical future quirk

If some new model needs a wire-level workaround on every gateway:

```jsonc
{
  "modelTemplates": {
    "future-model-quirk": {
      "matchModelRegex": "future-model-(plus|max)",
      "enabledPatch": { "custom_field": true }
    }
  }
}
```

The wizard can recommend this template for model names matching the regex.
Runtime applies it only when the model entry sets
`modelTemplate: "future-model-quirk"`. To narrow the recommendation and
compatibility scope, refine the regex or add `matchVendorRegex`,
`matchBaseUrlRegex`, or `protocol`.

### Example 6: Vendor with `matchBaseUrlRegex` for auto-match

A private DeepSeek relay. Setting `matchBaseUrlRegex` lets the user
omit `vendor:` on every model entry pointed at this relay:

```jsonc
{
  "templates": {
    "my-private-deepseek": {
      "extends": "openai-chat-deepseek-official",
      "matchBaseUrlRegex": "deepseek-relay\\.internal\\.example",
      "enabledPatch": { "x_relay_token": "internal" }
    }
  },
  "models": {
    "private-v4": {
      "model": "deepseek-v4-pro",
      "protocol": "openai-chat",
      "baseUrl": "https://deepseek-relay.internal.example/v1",
      "apiKey": "..."
      // No `vendor:` — inferVendor walks templates, sees the regex hit
      // on this baseUrl, and selects `my-private-deepseek` automatically.
    }
  }
}
```

Custom vendors are walked before built-ins, so the relay's pattern wins
over any built-in that might also match the URL.

### Example 7: Model template scoped to a single vendor

A workaround that only manifests when GLM-5.1 is reached via SiliconFlow,
not when reached via aliyun:

```jsonc
{
  "modelTemplates": {
    "glm-5.1-on-siliconflow-quirk": {
      "matchModelRegex": "GLM-5\\.1",
      "matchVendorRegex": "openai-chat-siliconflow",
      "enabledPatch": { "siliconflow_glm_workaround": true }
    }
  }
}
```

Both conditions must hold: model name matches AND the resolved vendor
name matches. The wizard can recommend this template only for the matching
combination; runtime applies it only when the model entry explicitly sets
`modelTemplate: "glm-5.1-on-siliconflow-quirk"`.

## CLI

The `/template` slash command manages both layers from inside axiomate.
Subcommands take a layer prefix (`vendor` or `model`) followed by an
operation:

```
/template vendor list                 — built-in + custom vendor templates
/template vendor show <name>          — print resolved vendor template JSON
/template vendor new                  — create custom vendor template ($EDITOR)
/template vendor delete <name>        — delete custom vendor template

/template model list                  — built-in + custom model templates
/template model show <name>           — print model template JSON
/template model new                   — create custom model template ($EDITOR)
/template model delete <name>         — delete custom model template
```

`vendor new` walks Name → Extends (pick a built-in to inherit, or "None"
for scratch) → spawn `$EDITOR` with the prefilled JSON. The editor flow
re-validates against `VendorTemplateSchema` plus a dry-resolve pass
(catches typos in `extends`, cycles, etc.) before saving.

`model new` skips the Extends step (model templates don't inherit) and
prefills a `matchModelRegex` stub since that field is required.

Built-in templates are read-only — `delete` rejects them, `show` works.

## Best practices

- **Don't write `vendor:` unless you must.** Auto-inference covers
  built-in vendors whose host match is safe gateway-wide, plus any custom
  vendor with `matchBaseUrlRegex`. Manual `vendor:` pin is for vendors
  whose host pattern overlaps an existing vendor and you need to
  disambiguate, or for custom templates without `matchBaseUrlRegex`.

- **Model templates are explicit runtime pins.** The wizard uses
  `matchModelRegex` plus optional vendor/baseUrl/protocol filters only to
  recommend a template. Runtime applies no model-layer patches unless the
  model entry sets `modelTemplate`.

- **Prefer semantic ownership, but use the escape hatches when needed.**
  `autoRoundTripReasoningContent` usually belongs in model templates.
  `reasoningRoundTripFormat` can live in either layer: gateway-wide defaults
  fit vendor templates; model-specific replay behavior fits model templates.
  Currently the only supported replay format is `reasoning_content`; other
  relay-specific shapes need explicit adapter support before templates can
  select them. Both fields are accepted on both layers;
  model templates merge last and win if both layers set the same field.

- **Use `null` deletion liberally.** When extending a built-in template,
  null out the keys you don't want rather than restating the entire
  parent shape. RFC 7396 makes the intent explicit.

- **`thinking.effort: 'none'` is the right way to runtime-disable
  thinking** while keeping the picker live. `enabled: false` removes the
  picker entirely.

## Related

- `agent/src/services/api/vendorTemplates.ts` — registry + `resolveStack`
- `agent/src/utils/modelConfigSchema.ts` — Zod schemas
- `agent/src/services/api/providers/{openaiProvider,openaiResponsesProvider,anthropicProvider}.ts` — `getResolvedTemplate` callers
- `agent/src/utils/effort.ts` — `getCyclableEffortLevels`
- `docs/thinking-effort-vendor-audit.md` — earlier audit of the system
