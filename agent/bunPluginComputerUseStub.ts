// Bun.build plugin: alias src/utils/computerUse/setup.ts to a no-op
// stub on non-darwin builds, so the entire computer-use module graph
// (gates / wrapper / hostAdapter / executor / mcpServer / ComputerUseApproval
// / ...) is excluded from windows + linux bundles.
//
// Build-time DCE alone (`feature('DARWIN')` guards inside builtinTools.ts)
// replaces the constant in the if-expression but bun bundler doesn't
// strip require() callsites it considers reachable. Aliasing the entry
// module is more direct: bundler resolves the import to a stub and never
// traverses the real source files.
//
// Usage:
//   plugins: [makeComputerUseStubPlugin(process.platform !== 'darwin')]
//
// The workspace packages computer-use-mcp-axiomate and
// computer-use-native-axiomate are already listed in `external` for both
// build.ts and package-win.ts, so they don't need plugin handling — only
// the source-tree entry point does.

import type { BunPlugin } from 'bun'

// `setup.ts` is the static entry — getAllMcpConfigs() lazy-imports it to
// register the in-process computer-use MCP server.
const SETUP_STUB =
  '// computer-use stub: windows / linux build, native APIs unavailable\n' +
  'export function setupComputerUseMCP() { return undefined }\n'

// `wrapper.tsx` is a dynamic-import target from client.ts (the per-call
// ToolUseContext bridge). Without stubbing, the dynamic import alone makes
// Bun bundle wrapper + its imports (escHotkey / swiftLoader / etc.).
const WRAPPER_STUB =
  '// computer-use stub: windows / linux build, native APIs unavailable\n' +
  'export function setCurrentToolUseContext() {}\n' +
  'export function buildSessionContext() { throw new Error("computer-use stub") }\n'

// `toolRendering.tsx` is dynamic-imported by client.ts only when
// `client.name === 'computer-use'`, but the import statement itself
// would still bundle the module on non-darwin. The render functions
// are pure UI (React + ink) so harmless to bundle, but stubbing keeps
// the windows / linux bundle audit clean (0 computerUse symbols).
const TOOL_RENDERING_STUB =
  '// computer-use stub: windows / linux build, rendering overrides unused\n' +
  'export function getComputerUseMCPRenderingOverrides() { return {} }\n'

// `cleanup.ts` is dynamic-imported by query.ts (abort paths) and
// stopHooks.ts (natural turn end). Both call sites are DARWIN-gated
// at the call site, but stubbing the module guards against the dynamic
// import being seen as reachable by the bundler.
const CLEANUP_STUB =
  '// computer-use stub: windows / linux build, cleanup is no-op\n' +
  'export async function cleanupComputerUseAfterTurn() {}\n'

export function makeComputerUseStubPlugin(enabled: boolean): BunPlugin {
  return {
    name: 'computer-use-stub',
    setup(build) {
      if (!enabled) return

      // Match both entry points (static getAllMcpConfigs import + dynamic
      // client.ts wrapper import). Both forward and backslash separators so
      // the same regex works regardless of host OS.
      build.onResolve(
        {
          filter: /computerUse[\\/]setup(?:\.js|\.ts)?$/,
        },
        args => ({
          path: args.path,
          namespace: 'computer-use-setup-stub',
        }),
      )
      build.onResolve(
        {
          filter: /computerUse[\\/]wrapper(?:\.js|\.tsx?)?$/,
        },
        args => ({
          path: args.path,
          namespace: 'computer-use-wrapper-stub',
        }),
      )
      build.onResolve(
        {
          filter: /computerUse[\\/]toolRendering(?:\.js|\.tsx?)?$/,
        },
        args => ({
          path: args.path,
          namespace: 'computer-use-tool-rendering-stub',
        }),
      )
      build.onResolve(
        {
          filter: /computerUse[\\/]cleanup(?:\.js|\.ts)?$/,
        },
        args => ({
          path: args.path,
          namespace: 'computer-use-cleanup-stub',
        }),
      )

      build.onLoad(
        { filter: /.*/, namespace: 'computer-use-setup-stub' },
        () => ({ contents: SETUP_STUB, loader: 'js' }),
      )
      build.onLoad(
        { filter: /.*/, namespace: 'computer-use-wrapper-stub' },
        () => ({ contents: WRAPPER_STUB, loader: 'js' }),
      )
      build.onLoad(
        { filter: /.*/, namespace: 'computer-use-tool-rendering-stub' },
        () => ({ contents: TOOL_RENDERING_STUB, loader: 'js' }),
      )
      build.onLoad(
        { filter: /.*/, namespace: 'computer-use-cleanup-stub' },
        () => ({ contents: CLEANUP_STUB, loader: 'js' }),
      )
    },
  }
}
