import { feature } from 'bun:bundle'
import type { Tool, ToolInputJSONSchema } from '../../Tool.js'

let cachedTools: readonly Tool[] | undefined

/**
 * Build axiomate Tool[] for the computer-use suite.
 *
 * Build-time gating: feature('DARWIN') is true on darwin builds (set by
 * package-mac.ts; auto-set by build.ts when host is darwin) and false
 * on windows / linux builds. The non-darwin branch returns [] and bun
 * bundler DCE-strips the entire lazy require chain — including the
 * workspace packages computer-use-dispatch-axiomate and
 * computer-use-native-axiomate plus every sibling source file under
 * utils/computerUse/. Net effect: windows / linux binaries contain no
 * computer-use code or dependency.
 *
 * Runtime gating: process.platform === 'darwin' check protects dev /
 * source runs (`bun run src/entrypoints/cli.tsx`) where feature flags
 * may disagree with the actual host platform.
 *
 * Originally the suite was packaged as an in-process MCP server (setup.ts
 * + mcpServer.ts) so the Anthropic API backend would recognize the
 * mcp__computer-use__* name pattern and inject a CU availability hint.
 * axiomate is provider-agnostic — that backend behavior doesn't apply —
 * so we register them as plain builtins. Dispatch still flows through
 * wrapper.tsx in-process: it owns the package-side session context,
 * lock, ESC hotkey, and TCC permission UI.
 *
 * Module-level cache because the tool list is process-stable.
 */
export function getComputerUseBuiltinTools(): readonly Tool[] {
  if (cachedTools) return cachedTools
  if (!feature('DARWIN') || process.platform !== 'darwin') {
    cachedTools = []
    return cachedTools
  }

  // Lazy require so the workspace packages and the entire utils/computerUse
  // module graph are only resolved on darwin. The static check above means
  // the bundler can DCE this branch on non-darwin builds.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { buildComputerUseTools } = require(
    'computer-use-dispatch-axiomate',
  ) as typeof import('computer-use-dispatch-axiomate')
  const { MCPTool } = require(
    '../../tools/MCPTool/MCPTool.js',
  ) as typeof import('../../tools/MCPTool/MCPTool.js')
  const { CLI_CU_CAPABILITIES } = require(
    './common.js',
  ) as typeof import('./common.js')
  const { getChicagoCoordinateMode } = require(
    './gates.js',
  ) as typeof import('./gates.js')
  const { getComputerUseMCPToolOverrides } = require(
    './wrapper.js',
  ) as typeof import('./wrapper.js')
  const { tryGetInstalledAppNames } = require(
    './installedApps.js',
  ) as typeof import('./installedApps.js')
  /* eslint-enable @typescript-eslint/no-require-imports */

  const baseTools = buildComputerUseTools(
    CLI_CU_CAPABILITIES,
    getChicagoCoordinateMode(),
  )

  // Lazy-build augmented descriptions: Spotlight enumeration takes ~100ms
  // and we don't want it on the startup path, so the first description()
  // call awaits this promise (~1s timeout in tryGetInstalledAppNames) and
  // every subsequent call hits the cached Map. The augmented variant is
  // critical for `request_access` — without `installedAppNames` the tool
  // description doesn't list real bundle-ids and the LLM has no way to
  // pick one. Failure (timeout / null) falls back to the base description.
  const augmentedDescPromise: Promise<Map<string, string>> = (async () => {
    const apps = await tryGetInstalledAppNames()
    if (!apps) return new Map()
    const augmented = buildComputerUseTools(
      CLI_CU_CAPABILITIES,
      getChicagoCoordinateMode(),
      apps,
    )
    return new Map(augmented.map(t => [t.name, t.description ?? '']))
  })()

  cachedTools = baseTools.map(tool => {
    const overrides = getComputerUseMCPToolOverrides(tool.name)
    return {
      ...MCPTool,
      name: tool.name,
      isMcp: false,
      // Deferred: ToolSearch surfaces a name-only line in the
      // <available-deferred-tools> block, the LLM fetches the full schema
      // only when it intends to use the tool. Same pattern as
      // SessionSearchTool / WebSearchTool / CronTools. searchHint is used
      // by ToolSearchTool's internal ranking (not rendered in the prompt).
      shouldDefer: true,
      searchHint:
        tool.description?.replace(/\s+/g, ' ').trim().slice(0, 80) ||
        tool.name,
      isEnabled: () => process.platform === 'darwin',
      async description() {
        const map = await augmentedDescPromise
        return map.get(tool.name) || tool.description || ''
      },
      async prompt() {
        const map = await augmentedDescPromise
        return map.get(tool.name) || tool.description || ''
      },
      inputJSONSchema: tool.inputSchema as ToolInputJSONSchema,
      // overrides provides: userFacingName, renderToolUseMessage,
      // renderToolResultMessage, call. Spread last so they win over
      // MCPTool defaults (esp. its stub `call` that returns empty string).
      ...overrides,
    } as Tool
  })

  return cachedTools
}
