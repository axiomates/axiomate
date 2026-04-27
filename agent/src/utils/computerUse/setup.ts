import { feature } from 'bun:bundle'
import type {
  McpInProcessServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'

/**
 * Build the in-process MCP server config for the computer-use suite.
 *
 * Returns `undefined` on non-darwin builds. The server is registered into
 * `getAllMcpConfigs` so the existing MCP client connection / cleanup
 * machinery handles it like any other server — except the transport is
 * in-memory (no subprocess), and the server is created lazily by the
 * `factory` here only on first connect.
 *
 * The LLM sees `mcp__computer-use__*` tools (27 of them) and the system
 * prompt's deferred-tools list groups them under one MCP prefix.
 *
 * Build-time gating: the bunPluginComputerUseStub plugin replaces this
 * module's exports with a `setupComputerUseMCP() { return undefined }`
 * stub on linux builds, so the entire `agent/src/utils/computerUse/`
 * + `computer-use-{mcp,native}-axiomate` workspace graph is DCE'd out
 * for that platform. mac (DARWIN feature) and windows (WIN32 feature)
 * both keep computer-use enabled.
 */
export function setupComputerUseMCP():
  | Record<string, ScopedMcpServerConfig>
  | undefined {
  // Gate on build feature AND runtime platform. `feature()` from
  // bun:bundle is a compile-time macro that MUST sit directly in an
  // if-condition or ternary — bun's compiler rewrites it inline; storing
  // its result in a variable defeats the rewrite and the bundle errors.
  if (!feature('DARWIN') && !feature('WIN32')) return undefined
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return undefined
  }

  const config: McpInProcessServerConfig = {
    type: 'in-process',
    factory: async () => {
      // Lazy import — Spotlight enumeration in installedApps.ts takes ~1s
      // and we don't want it on the cold-start path.
      const { createComputerUseMcpServerForCli } = await import('./mcpServer.js')
      return createComputerUseMcpServerForCli()
    },
  }
  return {
    [COMPUTER_USE_MCP_SERVER_NAME]: {
      ...config,
      scope: 'dynamic',
    },
  }
}
