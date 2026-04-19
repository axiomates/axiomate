import { isEnvTruthy } from '../envUtils.js'
import { getInitialSettings } from '../settings/settings.js'

/**
 * Whether to use the tree-sitter-style AST parser for bash command
 * permission checks. Opt-in because AST parsing is stricter (fail-closed
 * on unknown node types) than the legacy shell-quote path — some users
 * would experience this as false positives on exotic shell syntax.
 *
 * Env var wins over settings so ad-hoc runs can flip the switch without
 * touching config.
 */
export function isBashAstEnabled(): boolean {
  if (isEnvTruthy(process.env.AXIOMATE_CODE_ENABLE_BASH_AST)) return true
  return getInitialSettings()?.bashAstEnabled === true
}
