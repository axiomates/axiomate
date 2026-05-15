/**
 * MCP server factory for the browser bridge.
 *
 * Pattern mirrors `computer-use-mcp-axiomate`'s `createComputerUseMcpServer`:
 * a single `Server` with `ListToolsRequestSchema` + `CallToolRequestSchema`
 * handlers. Unlike computer-use it doesn't take an adapter — the bridge
 * has no host-side state machine, just a CDP client.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { dispatchBrowserBridgeTool } from "./toolCalls.js";
import { buildBrowserBridgeTools } from "./tools.js";

export function createBrowserBridgeMcpServer(): Server {
  const server = new Server(
    { name: "browser-bridge", version: "0.1.0" },
    { capabilities: { tools: {}, logging: {} } },
  );

  const tools = buildBrowserBridgeTools();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      return await dispatchBrowserBridgeTool(
        request.params.name,
        request.params.arguments ?? {},
      );
    },
  );

  return server;
}
