/**
 * Session ingress authentication.
 *
 * Token is provided by the orchestrator (sandbox gateway, MCP wrapper, etc.)
 * via the AXIOMATE_CODE_SESSION_ACCESS_TOKEN environment variable. The
 * legacy file-descriptor and well-known-file paths were CCR-only and were
 * removed along with the CCR/teleport subsystem.
 */

/**
 * Get session ingress authentication token from the environment.
 */
export function getSessionIngressAuthToken(): string | null {
  return process.env.AXIOMATE_CODE_SESSION_ACCESS_TOKEN ?? null
}

/**
 * Build auth headers for the current session token.
 * Session keys (sk-ant-sid) use Cookie auth + X-Organization-Uuid;
 * JWTs use Bearer auth.
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
 * Update the session ingress auth token in-process by setting the env var.
 * Used by orchestrators that refresh tokens in-place.
 */
export function updateSessionIngressAuthToken(token: string): void {
  process.env.AXIOMATE_CODE_SESSION_ACCESS_TOKEN = token
}
