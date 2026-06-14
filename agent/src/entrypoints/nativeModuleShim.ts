// Runtime .node loader shim for Bun-compiled exes.
//
// Catches the dynamic cases the bundle-time plugin can't see — notably
// the `bindings` package (used by @nut-tree-fork/libnut-{win32,darwin}),
// which walks directory trees at runtime to find .node files and then
// require()s the computed path. Inside a Bun compiled binary that walk
// starts from a virtual path and never reaches the real .node on disk.
//
// Strategy: wrap process.dlopen. If the original filename fails to load
// (ENOENT / MODULE_NOT_FOUND / virtual-path miss), retry with
// <exeDir>/<basename>.node — the layout package-{win,mac}.ts produces.
//
// Also registers a Bun virtual module for @img/sharp-<platform> so that
// sharp's JS wrapper can find the native addon. Sharp does
// require('@img/sharp-win32-x64') which fails in compiled binaries since
// the package only lives in the pnpm store. The Bun.plugin intercepts
// this before normal resolution and loads the .node from the exe dir.
//
// No-op in dev mode: process.execPath points at the bun/node runtime,
// whose directory doesn't contain our .node files; the original dlopen
// path keeps working via node_modules.

import { basename, dirname, join } from 'node:path'

const execBase = basename(process.execPath).toLowerCase()
const isCompiledExe = !/^(bun|node)(\.exe)?$/.test(execBase)

if (isCompiledExe) {
  const exeDir = dirname(process.execPath)

  // --- dlopen shim (for bindings-style dynamic native loading) ---
  const originalDlopen = process.dlopen.bind(process)
  process.dlopen = function dlopenShim(
    module: NodeModule,
    filename: string,
    flags?: number,
  ): void {
    try {
      originalDlopen(module, filename, flags)
    } catch (err) {
      const fallback = join(exeDir, basename(filename))
      if (fallback !== filename) {
        originalDlopen(module, fallback, flags)
        return
      }
      throw err
    }
  }

  // --- Bun virtual module for @img/sharp-* platform packages ---
  // Derive the expected package name from the current platform/arch.
  const sharpPlatformPkg = `@img/sharp-${process.platform}-${process.arch}`
  const sharpNodeFile = join(exeDir, `sharp-${process.platform}-${process.arch}.node`)

  try {
    ;(Bun as any).plugin({
      name: 'sharp-native-resolver',
      setup(build: any) {
        // Register a virtual module that loads the .node from exe dir
        build.module(sharpPlatformPkg, () => ({
          exports: require(sharpNodeFile),
          loader: 'object',
        }))
      },
    })
  } catch {
    // Bun.plugin unavailable or failed — sharp will use its own fallback
  }
}
