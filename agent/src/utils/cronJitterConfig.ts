// GrowthBook-backed cron jitter configuration.
//
// Separated from cronScheduler.ts so the scheduler can be bundled in the
// Agent SDK public build without pulling in analytics/growthbook.ts and
// its large transitive dependency set (settings/hooks/config cycle).
//
// Usage:
//   REPL (useScheduledTasks.ts): pass `getJitterConfig: getCronJitterConfig`
//   Daemon/SDK: omit getJitterConfig → DEFAULT_CRON_JITTER_CONFIG applies.

import {
  type CronJitterConfig,
  DEFAULT_CRON_JITTER_CONFIG,
} from './cronTasks.js'

/**
 * Returns the default cron jitter config.
 *
 * Previously read from GrowthBook (`ax_kairos_cron_config`). Now returns
 * the hardcoded default. Pass this as `getJitterConfig` when calling
 * createCronScheduler in REPL contexts.
 */
export function getCronJitterConfig(): CronJitterConfig {
  return DEFAULT_CRON_JITTER_CONFIG
}
