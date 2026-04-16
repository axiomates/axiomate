/**
 * React hook for dynamic config values.
 * config removed — always returns the default value.
 */
export function useDynamicConfig<T>(_configName: string, defaultValue: T): T {
  return defaultValue
}
