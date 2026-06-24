import { getInitialSettings } from './settings/settings.js'
import { getModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import { getGlobalConfig } from './config.js'
import {
  inferVendor,
  resolveStack,
  resolveTemplate,
} from '../services/api/vendorTemplates.js'

/**
 * The runtime effort level. Notes on each value:
 *
 *   'none'   Runtime off-switch. Reachable ONLY via ModelPicker left/right
 *            cycling — first-config UIs (onboarding wizard, EffortCallout)
 *            intentionally do not offer it because "set up thinking, then
 *            default it to off" is reserved for advanced hand-editing.
 *            Filtered out by toPersistableEffort() so it never lands in
 *            settings.effortByModel; it's session-only.
 *
 *   'low' | 'medium' | 'high' | 'max'   Standard tiers. Vendor templates
 *            decide via partial valueMaps which subset is cyclable per
 *            model — see getCyclableEffortLevels.
 *
 * For wizard's parallel type (uses 'off' instead of 'none' with different
 * semantics), see OnboardingProviderStep.reducer.ts ThinkingChoice.
 */
export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max'

export const EFFORT_LEVELS = [
  'none',
  'low',
  'medium',
  'high',
  'max',
] as const satisfies readonly EffortLevel[]

/**
 * EffortValue widens EffortLevel with `number` to accommodate the
 * AXIOMATE_CODE_EFFORT_LEVEL env override accepting numeric values.
 * Numeric inputs are coerced to 'high' by convertEffortValueToLevel,
 * so the runtime never produces a numeric value through the UI.
 */
export type EffortValue = EffortLevel | number

export function getConfiguredModelEffort(
  model: string,
): EffortLevel | undefined {
  const configuredEffort = getGlobalConfig().models?.[model]?.thinking?.effort
  if (!configuredEffort) {
    return undefined
  }
  return isEffortLevel(configuredEffort) ? configuredEffort : undefined
}

export function modelSupportsEffort(model: string): boolean {
  if (getConfiguredModelEffort(model) !== undefined) {
    return true
  }
  if (isEnvTruthy(process.env.AXIOMATE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  return getModelCapabilityOverride(model, 'effort') ?? false
}

export function modelSupportsMaxEffort(model: string): boolean {
  // 'max' is cyclable iff the resolved vendor template's effort.valueMap
  // includes a 'max' key. capability_override is a fallback for models
  // that aren't in the thinking/effort system at all.
  if (modelSupportsEffort(model)) {
    return getCyclableEffortLevels(model).includes('max')
  }
  return getModelCapabilityOverride(model, 'max_effort') ?? false
}

const ALL_EFFORT_TIERS: ReadonlyArray<Exclude<EffortLevel, 'none'>> = [
  'low',
  'medium',
  'high',
  'max',
]

/**
 * Returns the effort levels ModelPicker should let the user cycle through
 * for this model — derived from the resolved vendor template's
 * effort.valueMap. 'none' is always first (runtime off-switch, independent
 * of valueMap). Returns [] when the model isn't in the effort system at all.
 *
 * When the resolved template's effort.valueMap is omitted, treats it as
 * identity over all 4 tiers (back-compat for templates pre-dating partial
 * valueMap). When effort itself is omitted, only 'none' is cyclable.
 *
 * Note: this reads `getGlobalConfig().templates` directly rather than
 * accepting templates as a parameter (unlike applyThinkingTemplate). That
 * is intentional — this is a UI-side helper called on every focus change
 * in ModelPicker; resolving templates inline matches "what's on disk right
 * now" without forcing every caller to thread templates through.
 * applyThinkingTemplate is a pure function on the wire path; it takes
 * templates as input so the caller (provider adapter) can resolve once
 * per request and pass the result down.
 */
export function getCyclableEffortLevels(model: string): EffortLevel[] {
  if (!modelSupportsEffort(model)) return []

  const config = getGlobalConfig().models?.[model]
  // No ModelProviderConfig — only reachable via AXIOMATE_MODEL_CAPABILITY_OVERRIDES
  // env injection (the model isn't in config.models but env marks it
  // effort-capable). Picker never hits this branch because getModelOptions
  // only lists config.models entries; remaining callers are CLI-side
  // (--effort validation, print.ts) where the legacy 4-or-5 tier set is fine.
  // TODO: unify with the vendor template path (resolveStack) once env
  // override gains real users — needs a model-name → protocol inference helper
  // similar to the hardcoding that ac688d0e removed.
  if (!config) {
    return getModelCapabilityOverride(model, 'max_effort')
      ? ['none', 'low', 'medium', 'high', 'max']
      : ['none', 'low', 'medium', 'high']
  }

  const customVendors = getGlobalConfig().templates
  const customModels = getGlobalConfig().modelTemplates
  let template
  try {
    // Use the full 3-layer resolver — protocol-level valueMap (set on
    // anthropic / openai-chat / openai-responses) is what defines the
    // baseline cyclable set; vendor partials override or null out tiers
    // the gateway doesn't accept; model templates can further override.
    template = resolveStack({
      protocol: config.protocol,
      vendor: config.vendor,
      modelTemplate: config.modelTemplate,
      model: config.model,
      baseUrl: config.baseUrl,
      customVendors,
      customModels,
    })
  } catch {
    return ['none', 'low', 'medium', 'high', 'max']
  }

  if (!template.effort) return ['none']

  const valueMap = template.effort.valueMap
  if (!valueMap) {
    return ['none', 'low', 'medium', 'high', 'max']
  }
  // RFC 7396: a `null` valueMap entry means "this tier was deleted by an
  // overlay layer" — treat it as not-cyclable just like a missing key.
  return [
    'none',
    ...ALL_EFFORT_TIERS.filter(
      t => t in valueMap && (valueMap as Record<string, unknown>)[t] !== null,
    ),
  ]
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped (not persisted).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
/**
 * Filter an effort value to the subset persisted in settings.json.
 *
 * Settings stores `'low' | 'medium' | 'high' | 'max'`. 'none' is excluded
 * because it's a runtime-only override — a user wanting thinking
 * permanently off should use the wizard's 'off' option (which removes the
 * thinking field entirely) rather than persisting 'none' as a session
 * default. Numeric (budget-style) effort values also don't round-trip
 * through string-typed settings.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): 'low' | 'medium' | 'high' | 'max' | undefined {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max'
  ) {
    return value
  }
  return undefined
}

export function getInitialEffortSettingForModel(
  model: string,
):
  | 'low'
  | 'medium'
  | 'high'
  | 'max'
  | undefined {
  // toPersistableEffort filters 'none' on read so a manually edited
  // settings.json doesn't leak the runtime-only override into a fresh session.
  return toPersistableEffort(getInitialSettings().effortByModel?.[model])
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortByModel?.[selectedModel]),
 * NOT merged settings (project/policy layers would leak into the user's
 * global settings.json) and NOT AppState.effortValueByModel (includes
 * session-scoped sources that deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.AXIOMATE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env AXIOMATE_CODE_EFFORT_LEVEL → appState.effortValueByModel[model] → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  effortValueByModel: Record<string, EffortValue> | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const sessionEffort = effortValueByModel?.[model]
  const resolved =
    envOverride ?? sessionEffort ?? getDefaultEffortForModel(model)
  // Downgrade max when the selected model has not opted into it.
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  return resolved
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar effort display (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  effortValueByModel: Record<string, EffortValue> | undefined,
): EffortLevel {
  const resolved =
    resolveAppliedEffort(model, effortValueByModel) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for unsupported models).
 */
export function getEffortSuffix(
  model: string,
  effortValueByModel: Record<string, EffortValue> | undefined,
): string {
  const sessionEffort = effortValueByModel?.[model]
  if (sessionEffort === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValueByModel)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (config) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  return 'high'
}

export type DefaultEffortCalloutConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const DEFAULT_EFFORT_CALLOUT_CONFIG: DefaultEffortCalloutConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort',
  dialogDescription:
    'Effort determines how long Axiomate thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getDefaultEffortCalloutConfig(): DefaultEffortCalloutConfig {
  return { ...DEFAULT_EFFORT_CALLOUT_CONFIG }
}

export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  const configuredEffort = getConfiguredModelEffort(model)
  if (configuredEffort !== undefined) {
    return configuredEffort
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}
