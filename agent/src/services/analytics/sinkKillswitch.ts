export type SinkName = 'datadog' | 'firstParty'

/**
 * Per-sink analytics killswitch.
 * Previously backed by GrowthBook; now always returns false (sink stays on).
 */
export function isSinkKilled(_sink: SinkName): boolean {
  return false
}
