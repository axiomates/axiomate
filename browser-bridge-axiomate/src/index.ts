/**
 * Public exports. The agent imports `createBrowserBridgeMcpServer`; tests
 * and the bundle plugin import the named pieces.
 */

export { createBrowserBridgeMcpServer } from "./mcpServer.js";
export type {
  BrowserKind,
  BridgeState,
  BridgeProfile,
  BridgeStatus,
  PageRef,
  PageSnapshot,
} from "./types.js";
