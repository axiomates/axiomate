// MCP UI types shared across ManagePlugins and mcp/utils.

import type {
  ConfigScope,
  MCPServerConnection,
  McpSSEServerConfig,
  McpHTTPServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js'

export interface HTTPServerInfo {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
  transport: 'http'
  isAuthenticated?: boolean
  config: McpHTTPServerConfig
}

export interface SSEServerInfo {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
  transport: 'sse'
  isAuthenticated?: boolean
  config: McpSSEServerConfig
}

export interface StdioServerInfo {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
  transport: 'stdio'
  config: McpStdioServerConfig
}

export interface AgentMcpServerInfo {
  name: string
  client?: MCPServerConnection
  scope?: ConfigScope
  transport: string
  agentId?: string
  needsAuth?: boolean
  isAuthenticated?: boolean
  url?: string
  command?: string
  args?: string[]
  sourceAgents: string[]
  config?: McpStdioServerConfig | McpHTTPServerConfig | McpSSEServerConfig
}

export type RegularServerInfo =
  | HTTPServerInfo
  | SSEServerInfo
  | StdioServerInfo

export type ServerInfo = RegularServerInfo | AgentMcpServerInfo

export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: RegularServerInfo }
  | { type: 'server-tools'; server: RegularServerInfo }
  | { type: 'server-tool-detail'; server: RegularServerInfo; toolIndex: number }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
