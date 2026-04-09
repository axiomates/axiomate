import { useEffect } from 'react'
import { callIdeRpc } from '../services/mcp/client.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import type { PermissionMode } from '../types/permissions.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from '../utils/browserExtension/common.js'

/**
 * A hook that syncs permission mode changes to the Chrome extension.
 * The prompt notification listener was ant-only and has been removed.
 */
export function usePromptsFromClaudeInChrome(
  mcpClients: MCPServerConnection[],
  toolPermissionMode: PermissionMode,
): void {
  // Sync permission mode with Chrome extension whenever it changes
  useEffect(() => {
    const chromeClient = findChromeClient(mcpClients)
    if (!chromeClient) return

    const chromeMode =
      toolPermissionMode === 'bypassPermissions'
        ? 'skip_all_permission_checks'
        : 'ask'

    void callIdeRpc('set_permission_mode', { mode: chromeMode }, chromeClient)
  }, [mcpClients, toolPermissionMode])
}

function findChromeClient(
  clients: MCPServerConnection[],
): ConnectedMCPServer | undefined {
  return clients.find(
    (client): client is ConnectedMCPServer =>
      client.type === 'connected' &&
      client.name === CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  )
}
