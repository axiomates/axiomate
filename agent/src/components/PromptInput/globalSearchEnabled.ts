import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * Whether the advanced search dialogs (Ctrl+Shift+P Quick Open,
 * Ctrl+Shift+F Global Search, Ctrl+R modal history picker) are active.
 * Env-only opt-in (no settings / /config) because the global-search
 * dialog is known not-quite-stable: ripgrep errors are silently
 * swallowed, empty-result vs search-failed cannot be distinguished,
 * and useHistorySearch still has a pending onKeyDown-migration TODO.
 * Users opting in via env knowingly accept those rough edges.
 *
 * When unset, Ctrl+R falls back to the stable classic backward-search
 * UI in useHistorySearch.
 */
export function isGlobalSearchEnabled(): boolean {
  return isEnvTruthy(process.env.AXIOMATE_CODE_ENABLE_GLOBAL_SEARCH)
}
