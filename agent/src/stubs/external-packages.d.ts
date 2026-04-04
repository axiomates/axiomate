// Stub declarations for packages not available on npm.

// @anthropic-ai/claude-agent-sdk — Anthropic internal SDK, not published.
declare module '@anthropic-ai/claude-agent-sdk' {
  export const version: string
  export function createClient(options?: any): any
  export type AgentSDKClient = any
  export type PermissionMode = any
}

// @ant/claude-for-chrome-mcp — Anthropic browser extension MCP.
declare module '@ant/claude-for-chrome-mcp' {
  export function createClaudeForChromeMcpServer(options?: any): any
  export type ClaudeForChromeContext = any
  export const BROWSER_TOOLS: Array<{ name: string; [key: string]: any }>
}

// bun:ffi — Bun's FFI module, not available in Node.
declare module 'bun:ffi' {
  export function dlopen(path: string, symbols: Record<string, any>): any
  export function CString(ptr: any): string
  export const ptr: any
  export const toBuffer: any
  export const toArrayBuffer: any
}

// --------------------------------------------------------------------------
// Augment @anthropic-ai/sdk types that are newer than the installed version.
// The installed SDK's BetaMessageDeltaUsage only has output_tokens;
// claude-code v2.1.88 accesses several additional fields from a newer API.
// --------------------------------------------------------------------------
declare module '@anthropic-ai/sdk/resources/beta/messages/messages.mjs' {
  // Re-export all types that the SDK provides in messages.d.ts but TS can't
  // resolve via the .mjs specifier (no .d.mts exists).
  export type BetaContentBlock = any
  export type BetaContentBlockParam = any
  export type BetaImageBlockParam = any
  export type BetaMessage = any
  export type BetaMessageParam = any
  export type BetaMessageStreamParams = any
  export type BetaRawMessageStreamEvent = any
  export type BetaRedactedThinkingBlock = any
  export type BetaThinkingBlock = any
  export type BetaTool = any
  export type BetaToolChoiceAuto = any
  export type BetaToolChoiceTool = any
  export type BetaToolResultBlockParam = any
  export type BetaToolUnion = any
  export type BetaToolUseBlock = any
  export type BetaUsage = any

  export interface BetaMessageDeltaUsage {
    output_tokens?: number
    input_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    server_tool_use?: any
    iterations?: number
  }

  // Types from a newer SDK version not yet installed
  export type BetaJSONOutputFormat = any
  export type BetaOutputConfig = any
  export type BetaRequestDocumentBlock = any
  export type BetaStopReason = string
  export type BetaWebSearchTool20250305 = any

  // Re-export create params
  export type MessageCreateParams = any
  export type MessageCreateParamsNonStreaming = any
  export type MessageCreateParamsStreaming = any
  export type MessageCountTokensParams = any
}

// NOTE: ambient overrides for axiomate workspace packages (computer-use-mcp,
// computer-use-native, sandbox, image-processor) have been removed.
// Missing exports are now added directly to each package's src/index.ts.
