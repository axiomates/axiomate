import { isEnvTruthy } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Whether end-of-turn memory extraction (forked-agent distilling facts into
 * daily logs + MEMORY.md) is enabled. Opt-in because extraction runs after
 * every completed turn, each run costs a forked-agent roundtrip, and the
 * daily log files accumulate on disk across sessions. Users who don't want
 * this background cost shouldn't inherit it silently.
 *
 * Env var wins over settings so ad-hoc runs can flip without touching config.
 */
export function isExtractMemoriesEnabled(): boolean {
  if (isEnvTruthy(process.env.AXIOMATE_CODE_ENABLE_EXTRACT_MEMORIES)) {
    return true
  }
  return getInitialSettings()?.extractMemoriesEnabled === true
}
