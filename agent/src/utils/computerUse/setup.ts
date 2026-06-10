import { feature } from 'bun:bundle'
import type {
  McpInProcessServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import {
  BROWSER_BRIDGE_MCP_SERVER_NAME,
  COMPUTER_USE_MCP_SERVER_NAME,
} from './common.js'

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

/**
 * Sibling factory for the browser-bridge MCP server. Same gating as
 * `setupComputerUseMCP` — gated on DARWIN || WIN32 at build time and again
 * at runtime so a darwin-built bundle running on a non-mac host (shouldn't
 * happen, but) still skips registration. The bunPluginComputerUseStub
 * replaces this module's exports on linux, so the entire
 * `browser-bridge-axiomate` import graph is DCE'd out of the linux bundle.
 */
export function setupBrowserBridgeMCP():
  | Record<string, ScopedMcpServerConfig>
  | undefined {
  if (!feature('DARWIN') && !feature('WIN32')) return undefined
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return undefined
  }

  const config: McpInProcessServerConfig = {
    type: 'in-process',
    factory: async () => {
      const { createBrowserBridgeMcpServer, shutdownBridge } = await import(
        'browser-bridge-axiomate'
      )
      // The launched browser and the agent-browser daemon are both detached, so
      // the OS won't reap them when axiomate exits, and agent-browser's
      // idle-timeout is off by default → the daemon would run forever. Register
      // a graceful-shutdown hook to take down THIS process's browser + daemon
      // (scoped to our per-pid session, never other axiomate instances).
      // Registered here (factory = first connect) so a session that never
      // touches the browser adds no shutdown work.
      const { registerCleanup } = await import('../cleanupRegistry.js')
      registerCleanup(shutdownBridge)
      return createBrowserBridgeMcpServer()
    },
  }
  return {
    [BROWSER_BRIDGE_MCP_SERVER_NAME]: {
      ...config,
      scope: 'dynamic',
    },
  }
}
