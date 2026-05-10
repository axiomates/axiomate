// Bun.build plugin: rewrite literal .node imports so they resolve from
// <exeDir>/<basename>.node at runtime instead of Bun's virtual-path resolver.
//
// A Bun-compiled single-file exe bundles all JS into a virtual filesystem
// (B:/~BUN/root/). Literal requires like `require('./foo.node')` or
// `require('@pkg/foo.node')` inside bundled code resolve against that
// virtual path and miss the real .node files copied beside the exe. This
// plugin replaces each literal .node import with a tiny shim that computes
// the absolute on-disk path from `process.execPath` at runtime.
//
// Covers: audio-capture-axiomate, node-screenshots, sharp (@img/sharp-*),
// and every other workspace/third-party package that references .node
// files as static string literals.
//
// NOT covered: dynamic requires where the path is computed at runtime —
// notably the `bindings` package used by @nut-tree-fork/libnut-{win32,darwin}.
// Those are handled by the process.dlopen shim at the CLI entry
// (src/entrypoints/nativeModuleShim.ts).

import { basename } from 'node:path'
import type { BunPlugin } from 'bun'

export const nativeExeDirPlugin: BunPlugin = {
  name: 'native-exe-dir',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, args => {
      // sharp has its own multi-step runtime loader and package-export
      // resolution; rewriting its .node imports here breaks the path chain
      // that worked in older mac package builds. Leave sharp untouched and
      // only rewrite the simpler direct native imports we control.
      if (/sharp/i.test(args.path)) {
        return
      }
      return {
        path: args.path,
        namespace: 'native-exe-dir',
      }
    })

    build.onLoad({ filter: /.*/, namespace: 'native-exe-dir' }, args => {
      const file = basename(args.path)
      return {
        contents:
          "const { dirname, join } = require('node:path')\n" +
          'const exeDir = dirname(process.execPath)\n' +
          `module.exports = require(join(exeDir, ${JSON.stringify(file)}))\n`,
        loader: 'js',
      }
    })
  },
}
