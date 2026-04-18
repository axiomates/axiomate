import * as React from 'react'
import { useEffect } from 'react'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'

type Props = {
  mcpClients?: MCPServerConnection[]
}

const EMPTY_MCP_CLIENTS: MCPServerConnection[] = []

export function useMcpConnectivityStatus({
  mcpClients = EMPTY_MCP_CLIENTS,
}: Props): void {
  const { addNotification } = useNotifications()
  useEffect(() => {
    const failedLocalClients = mcpClients.filter(
      client =>
        client.type === 'failed' &&
        client.config.type !== 'sse-ide' &&
        client.config.type !== 'ws-ide',
    )
    const needsAuthLocalServers = mcpClients.filter(
      client => client.type === 'needs-auth',
    )
    if (
      failedLocalClients.length === 0 &&
      needsAuthLocalServers.length === 0
    ) {
      return
    }
    if (failedLocalClients.length > 0) {
      addNotification({
        key: 'mcp-failed',
        jsx: (
          <>
            <Text color="error">
              {failedLocalClients.length} MCP{' '}
              {failedLocalClients.length === 1 ? 'server' : 'servers'} failed
            </Text>
            <Text dimColor> · /mcp</Text>
          </>
        ),
        priority: 'medium',
      })
    }
    if (needsAuthLocalServers.length > 0) {
      addNotification({
        key: 'mcp-needs-auth',
        jsx: (
          <>
            <Text color="warning">
              {needsAuthLocalServers.length} MCP{' '}
              {needsAuthLocalServers.length === 1
                ? 'server needs'
                : 'servers need'}{' '}
              auth
            </Text>
            <Text dimColor> · /mcp</Text>
          </>
        ),
        priority: 'medium',
      })
    }
  }, [addNotification, mcpClients])
}
