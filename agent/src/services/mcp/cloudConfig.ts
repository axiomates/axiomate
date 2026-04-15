import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { clearMcpAuthCache } from './client.js'
import type { ScopedMcpServerConfig } from './types.js'

/**
 * Axiomate doesn't have Anthropic OAuth, so cloud MCP configs are never
 * available. Return an empty record immediately.
 */
export async function fetchClaudeAIMcpConfigsIfEligible(): Promise<Record<string, ScopedMcpServerConfig>> {
  return {}
}

/**
 * Clears the memoized cache for fetchClaudeAIMcpConfigsIfEligible.
 * Call this after login so the next fetch will use the new auth tokens.
 */
export function clearClaudeAIMcpConfigsCache(): void {
  // No-op: fetchClaudeAIMcpConfigsIfEligible always returns empty
  clearMcpAuthCache()
}

/**
 * Record that a claude.ai connector successfully connected. Idempotent.
 *
 * Gates the "N connectors unavailable/need auth" startup notifications: a
 * connector that was working yesterday and is now failed is a state change
 * worth surfacing; an org-configured connector that's been needs-auth since
 * it showed up is one the user has demonstrably ignored.
 */
export function markClaudeAiMcpConnected(name: string): void {
  saveGlobalConfig(current => {
    const seen = current.claudeAiMcpEverConnected ?? []
    if (seen.includes(name)) return current
    return { ...current, claudeAiMcpEverConnected: [...seen, name] }
  })
}

export function hasClaudeAiMcpEverConnected(name: string): boolean {
  return (getGlobalConfig().claudeAiMcpEverConnected ?? []).includes(name)
}
