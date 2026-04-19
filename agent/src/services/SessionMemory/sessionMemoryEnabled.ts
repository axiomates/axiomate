import { isEnvTruthy } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Whether session memory (periodic forked-agent MEMORY.md updates during
 * long conversations) is enabled. Opt-in because each trigger costs a
 * forked-agent roundtrip and the memory file is durable on disk — users
 * who do not want background model calls or persistent state shouldn't
 * inherit them silently.
 *
 * Env var wins over settings so ad-hoc runs can flip without touching config.
 */
export function isSessionMemoryEnabled(): boolean {
  if (isEnvTruthy(process.env.AXIOMATE_CODE_ENABLE_SESSION_MEMORY)) return true
  return getInitialSettings()?.sessionMemoryEnabled === true
}
