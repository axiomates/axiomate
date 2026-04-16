/**
 * React hook for dynamic config values.
 * GrowthBook removed — always returns the default value.
 */
export function useDynamicConfig<T>(_configName: string, defaultValue: T): T {
  return defaultValue
}
