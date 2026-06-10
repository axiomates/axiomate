/**
 * Public exports. The agent imports `createBrowserBridgeMcpServer`; tests
 * and the bundle plugin import the named pieces.
 */

export { createBrowserBridgeMcpServer } from "./mcpServer.js";
export { shutdownBridge } from "./toolCalls.js";
export type { BrowserKind, BridgeState } from "./types.js";
