/**
 * Session-wide Bearer auth token.
 *
 * Generic env-var auth mechanism: any embedder or orchestrator can set
 * AXIOMATE_CODE_SESSION_ACCESS_TOKEN to attach an Authorization header to
 * outbound MCP transport requests (WS/HTTP) that don't already carry an
 * OAuth credential. Not tied to any specific backend — works with
 * self-hosted MCP proxies, corporate SSO gateways, or plain per-session
 * Bearer tokens.
 *
 * Historically used by the upstream Claude Code Relay to attach its
 * session cookie; the code survives because the mechanism (per-session
 * Bearer injection) is broadly useful on its own.
 */

/**
 * Get the session-wide auth token from the environment, if set.
 */
export function getSessionIngressAuthToken(): string | null {
  return process.env.AXIOMATE_CODE_SESSION_ACCESS_TOKEN ?? null
}

/**
 * Build auth headers for the session token.
 * Anthropic-style session keys (sk-ant-sid) use Cookie auth plus
 * X-Organization-Uuid; everything else is treated as a Bearer JWT.
 */
export function getSessionIngressAuthHeaders(): Record<string, string> {
  const token = getSessionIngressAuthToken()
  if (!token) return {}
  if (token.startsWith('sk-ant-sid')) {
    const headers: Record<string, string> = {
      Cookie: `sessionKey=${token}`,
    }
    const orgUuid = process.env.AXIOMATE_CODE_ORGANIZATION_UUID
    if (orgUuid) {
      headers['X-Organization-Uuid'] = orgUuid
    }
    return headers
  }
  return { Authorization: `Bearer ${token}` }
}

/**
 * Update the token in-process by setting the env var. For orchestrators
 * that refresh tokens without restarting the agent.
 */
export function updateSessionIngressAuthToken(token: string): void {
  process.env.AXIOMATE_CODE_SESSION_ACCESS_TOKEN = token
}
