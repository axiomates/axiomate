// Stub: MCP component types — type-only imports from ManagePlugins.tsx, mcp/utils.ts.

import type {
  ConfigScope,
  MCPServerConnection,
  McpSSEServerConfig,
  McpHTTPServerConfig,
  McpStdioServerConfig,
  McpClaudeAIProxyServerConfig,
} from '../../services/mcp/types.js'

export interface ClaudeAIServerInfo {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
  transport: 'claudeai-proxy'
  isAuthenticated?: boolean
  config: McpClaudeAIProxyServerConfig
}

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

export type MCPViewState = 'list' | 'detail' | 'add' | string

export type ServerInfo =
  | ClaudeAIServerInfo
  | HTTPServerInfo
  | SSEServerInfo
  | StdioServerInfo
  | AgentMcpServerInfo

export function getCwd(): string {
  return process.cwd()
}
