import { isEnvTruthy } from './envUtils.js'

/**
 * Check if --agent-teams flag is provided via CLI.
 * Checks process.argv directly to avoid import cycles with bootstrap/state.
 * Note: The flag is only shown in help under the feature gate, but if users
 * pass it anyway, it will work (subject to the killswitch).
 */
function isAgentTeamsFlagSet(): boolean {
  return process.argv.includes('--agent-teams')
}

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * Requires opt-in via AXIOMATE_CODE_EXPERIMENTAL_AGENT_TEAMS env var
 * OR --agent-teams flag.
 */
export function isAgentSwarmsEnabled(): boolean {
  // Require opt-in via env var or --agent-teams flag
  if (
    !isEnvTruthy(process.env.AXIOMATE_CODE_EXPERIMENTAL_AGENT_TEAMS) &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  return true
}
