import { buildComputerUseTools } from 'computer-use-mcp-axiomate'
import { type Tool, type ToolInputJSONSchema } from '../../Tool.js'
import { MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { CLI_CU_CAPABILITIES } from './common.js'
import { getChicagoCoordinateMode, getChicagoEnabled } from './gates.js'
import { getComputerUseMCPToolOverrides } from './wrapper.js'

let cachedTools: readonly Tool[] | undefined

/**
 * Build axiomate Tool[] for the computer-use suite.
 *
 * Originally these were packaged as an in-process MCP server (setup.ts +
 * mcpServer.ts) so the Anthropic API backend would recognize the
 * `mcp__computer-use__*` name pattern and inject a CU availability hint into
 * the system prompt. axiomate is provider-agnostic — that backend behavior
 * doesn't apply — so we register them as plain builtins, gated by darwin +
 * computerUseEnabled.
 *
 * Dispatch still flows through wrapper.tsx in-process: it owns the
 * package-side session context, in-process lock, ESC hotkey, and TCC
 * permission UI. We just reuse its `getComputerUseMCPToolOverrides()` to get
 * the `call` + render functions for each tool name.
 *
 * Spreading MCPTool gives us the boilerplate fields (`inputSchema`
 * passthrough, `outputSchema`, `maxResultSizeChars`,
 * `mapToolResultToToolResultBlockParam`, etc.) that `buildTool()` requires.
 * `isMcp` is overridden to false — these are builtins now, and `isMcp` is
 * checked by api.ts / analyzeContext.ts to bucket tools at the API layer.
 *
 * Module-level cache because the tool definition list is process-stable.
 * `isEnabled` is per-call so the cache does not pin the disabled state.
 */
export function getComputerUseBuiltinTools(): readonly Tool[] {
  if (cachedTools) return cachedTools
  if (process.platform !== 'darwin') {
    cachedTools = []
    return cachedTools
  }

  const cuTools = buildComputerUseTools(
    CLI_CU_CAPABILITIES,
    getChicagoCoordinateMode(),
  )

  cachedTools = cuTools.map(tool => {
    const overrides = getComputerUseMCPToolOverrides(tool.name)
    return {
      ...MCPTool,
      name: tool.name,
      isMcp: false,
      isEnabled: () =>
        process.platform === 'darwin' && getChicagoEnabled(),
      async description() {
        return tool.description ?? ''
      },
      async prompt() {
        return tool.description ?? ''
      },
      inputJSONSchema: tool.inputSchema as ToolInputJSONSchema,
      // overrides provides: userFacingName, renderToolUseMessage,
      // renderToolResultMessage, call. Spread last so they win over MCPTool
      // defaults (esp. its stub `call` that returns empty string).
      ...overrides,
    } as Tool
  })

  return cachedTools
}
