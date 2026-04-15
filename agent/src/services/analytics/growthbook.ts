/**
 * GrowthBook feature flag stub.
 *
 * Axiomate has no Anthropic SDK key, so remote feature evaluation always
 * returned defaults. This module preserves every exported signature but
 * returns default values immediately -- no SDK, no HTTP calls, no polling.
 */

import type { GitHubActionsMetadata } from '../../utils/user.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GrowthBookUserAttributes = {
  id: string
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  organizationUUID?: string
  accountUUID?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}

// ---------------------------------------------------------------------------
// Feature value getters -- all return the caller-supplied default
// ---------------------------------------------------------------------------

export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  _feature: string,
  defaultValue: T,
): T {
  return defaultValue
}

export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  _feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return defaultValue
}

export async function getFeatureValue_DEPRECATED<T>(
  _feature: string,
  defaultValue: T,
): Promise<T> {
  return defaultValue
}

export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  _gate: string,
): boolean {
  return false
}

export async function checkSecurityRestrictionGate(
  _gate: string,
): Promise<boolean> {
  return false
}

export async function checkGate_CACHED_OR_BLOCKING(
  _gate: string,
): Promise<boolean> {
  return false
}

// ---------------------------------------------------------------------------
// Dynamic config getters
// ---------------------------------------------------------------------------

export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  _configName: string,
  defaultValue: T,
): Promise<T> {
  return defaultValue
}

export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  _configName: string,
  defaultValue: T,
): T {
  return defaultValue
}

// ---------------------------------------------------------------------------
// Lifecycle -- all no-ops
// ---------------------------------------------------------------------------

export async function initializeGrowthBook(): Promise<null> {
  return null
}

export function resetGrowthBook(): void {}

export function refreshGrowthBookAfterAuthChange(): void {}

export async function refreshGrowthBookFeatures(): Promise<void> {}

export function setupPeriodicGrowthBookRefresh(): void {}

export function stopPeriodicGrowthBookRefresh(): void {}

// ---------------------------------------------------------------------------
// Refresh subscription
// ---------------------------------------------------------------------------

export function onGrowthBookRefresh(
  _listener: () => void | Promise<void>,
): () => void {
  // Return a no-op unsubscribe
  return () => {}
}

// ---------------------------------------------------------------------------
// Env / config overrides
// ---------------------------------------------------------------------------

export function hasGrowthBookEnvOverride(_feature: string): boolean {
  return false
}

export function getAllGrowthBookFeatures(): Record<string, unknown> {
  return {}
}

export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return {}
}

export function setGrowthBookConfigOverride(
  _feature: string,
  _value: unknown,
): void {}

export function clearGrowthBookConfigOverrides(): void {}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export function getApiBaseUrlHost(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).host
    if (host === 'the API endpoint') return undefined
    return host
  } catch {
    return undefined
  }
}
