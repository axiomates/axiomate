import { clearCACertsCache } from './caCerts.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'

function withoutSSHTunnelVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return env || {}
}

/**
 * When the host owns inference routing (sets
 * AXIOMATE_CODE_PROVIDER_MANAGED_BY_HOST in spawn env), strip
 * provider-selection vars from settings-sourced env so a
 * user's ~/.axiomate/settings.json can't redirect requests away from the
 * host-configured provider.
 */
function withoutHostManagedProviderVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {}
  if (!isEnvTruthy(process.env.AXIOMATE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    return env
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) {
      out[key] = value
    }
  }
  return out
}

/**
 * Compose the strip filters applied to every settings-sourced env object.
 */
function filterSettingsEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return withoutHostManagedProviderVars(withoutSSHTunnelVars(env))
}

/**
 * Trusted setting sources whose env vars can be applied before the trust dialog.
 *
 * - userSettings (~/.axiomate/settings.json): controlled by the user, not project-specific
 * - flagSettings (--settings CLI flag or SDK inline settings): explicitly passed by the user
 * - policySettings (managed settings from enterprise API or local managed-settings.json):
 *   controlled by IT/admin (highest priority, cannot be overridden)
 *
 * Project-scoped sources (projectSettings, localSettings) are excluded because they live
 * inside the project directory and could be committed by a malicious actor to redirect
 * traffic (e.g., AXIOMATE_BASE_URL) to an attacker-controlled server.
 */
const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

/**
 * Apply environment variables from trusted sources to process.env.
 * Called before the trust dialog so that user/enterprise env vars like
 * AXIOMATE_BASE_URL take effect during first-run/onboarding.
 *
 * For trusted sources (user settings, managed settings, CLI flags), ALL env vars
 * are applied — including ones like AXIOMATE_BASE_URL that would be dangerous
 * from project-scoped settings.
 *
 * For project-scoped sources (projectSettings, localSettings), only safe env vars
 * from the SAFE_ENV_VARS allowlist are applied. These are applied after trust is
 * fully established via applyConfigEnvironmentVariables().
 */
export function applySafeConfigEnvironmentVariables(): void {
  // Global config (~/.axiomate.json) is user-controlled.
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  // Apply ALL env vars from trusted setting sources.
  // Gate on isSettingSourceEnabled so SDK settingSources: [] (isolation mode)
  // doesn't get clobbered by ~/.axiomate/settings.json env (gh#217). policy/flag
  // sources are always enabled, so this only ever filters userSettings.
  for (const source of TRUSTED_SETTING_SOURCES) {
    if (!isSettingSourceEnabled(source)) continue
    Object.assign(
      process.env,
      filterSettingsEnv(getSettingsForSource(source)?.env),
    )
  }

  // Apply only safe env vars from the fully-merged settings (which includes
  // project-scoped sources). For safe vars that also exist in trusted sources,
  // the merged value (which may come from a higher-priority project source)
  // will overwrite the trusted value — this is acceptable since these vars are
  // in the safe allowlist. Only policySettings values are guaranteed to survive
  // unchanged (it has the highest merge priority in both loops) — except
  // provider-routing vars, which filterSettingsEnv strips from every source
  // when AXIOMATE_CODE_PROVIDER_MANAGED_BY_HOST is set.
  const settingsEnv = filterSettingsEnv(getSettings_DEPRECATED()?.env)
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      process.env[key] = value
    }
  }
}

/**
 * Apply environment variables from settings to process.env.
 * This applies ALL environment variables (except provider-routing vars when
 * AXIOMATE_CODE_PROVIDER_MANAGED_BY_HOST is set — see filterSettingsEnv) and
 * should only be called after trust is established. This applies potentially
 * dangerous environment variables such as LD_PRELOAD, PATH, etc.
 */
export function applyConfigEnvironmentVariables(): void {
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  Object.assign(process.env, filterSettingsEnv(getSettings_DEPRECATED()?.env))

  // Clear caches so agents are rebuilt with the new env vars
  clearCACertsCache()
  clearMTLSCache()
  clearProxyCache()

  // Reconfigure proxy/mTLS agents to pick up any proxy env vars from settings
  configureGlobalAgents()
}
