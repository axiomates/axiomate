// Bun.build plugin: alias src/utils/computerUse/builtinTools.ts to a no-op
// stub on non-darwin builds, so the entire computer-use module graph
// (gates / wrapper / hostAdapter / executor / mcpServer / setup /
// ComputerUseApproval / ...) is excluded from windows + linux bundles.
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
// The workspace packages computer-use-dispatch-axiomate and
// computer-use-native-axiomate are already listed in `external` for both
// build.ts and package-win.ts, so they don't need plugin handling — only
// the source-tree entry point does.

import type { BunPlugin } from 'bun'

const STUB_CONTENTS =
  '// computer-use stub: windows / linux build, native APIs unavailable\n' +
  'export function getComputerUseBuiltinTools() { return [] }\n'

export function makeComputerUseStubPlugin(enabled: boolean): BunPlugin {
  return {
    name: 'computer-use-stub',
    setup(build) {
      if (!enabled) return

      // Match the lone entry point that tools.ts imports. Both forward and
      // backslash separators so the same regex works regardless of host OS.
      build.onResolve(
        {
          filter: /computerUse[\\/]builtinTools(?:\.js|\.ts)?$/,
        },
        args => ({
          path: args.path,
          namespace: 'computer-use-stub',
        }),
      )

      build.onLoad(
        { filter: /.*/, namespace: 'computer-use-stub' },
        () => ({
          contents: STUB_CONTENTS,
          loader: 'js',
        }),
      )
    },
  }
}
