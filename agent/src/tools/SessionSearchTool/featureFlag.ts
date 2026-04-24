/**
 * Feature flag gate for SessionSearchTool.
 *
 * Mirrors the pattern of other opt-in feature toggles
 * (globalSearchEnabled, messageActionsEnabled, etc.):
 *   1. Env var wins (AXIOMATE_CODE_ENABLE_SESSION_SEARCH=1)
 *   2. Falls back to settings.sessionSearchEnabled
 *   3. Default: false (Phase 1 gradual rollout per plan)
 */
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export function isSessionSearchEnabled(): boolean {
  if (isEnvTruthy(process.env.AXIOMATE_CODE_ENABLE_SESSION_SEARCH)) {
    return true
  }
  return getInitialSettings()?.sessionSearchEnabled === true
}
