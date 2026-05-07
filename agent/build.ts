/**
 * Bun build script for axiomate agent.
 * Bundles src/ into a single JS file with compile-time feature flags and
 * MACRO constant injection. Output goes to dist/cli.js (no --compile here;
 * package-mac.ts and package-win.ts produce the standalone executables).
 *
 * Usage: bun run build.ts
 */

import { readFileSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { getBuildDefine, parseFeatures, printBuildFeatures } from './buildConfig.ts'
import { makeComputerUseStubPlugin } from './bunPluginComputerUseStub.ts'

const pkg = JSON.parse(readFileSync(join(dirname(import.meta.path), 'package.json'), 'utf-8'))

// Read CHANGELOG.md for build-time embedding (so LogoV2 can show release notes without network)
let versionChangelog = ''
try {
  versionChangelog = readFileSync(join(dirname(import.meta.path), '..', 'CHANGELOG.md'), 'utf-8')
} catch {
  // CHANGELOG.md not found — release notes will be empty
}

// Auto-include DARWIN / WIN32 feature on the matching host so dev builds
// (`bun run build`) include the computer-use module. Other hosts strip it
// via DCE. Linux dev builds get neither feature → computer-use stubbed.
const defaultFeatures: string[] = []
if (process.platform === 'darwin') defaultFeatures.push('DARWIN')
if (process.platform === 'win32') defaultFeatures.push('WIN32')
const features = parseFeatures(Bun.argv, process.env, defaultFeatures)
printBuildFeatures('build', features)

// ── Pre-build native NAPI modules so dev runtime loads up-to-date .node ──
// .node files are external (not bundled), loaded from workspace dirs at
// runtime. Without this step, changes to lib.rs would be silently ignored.
{
  const root = resolve(dirname(import.meta.path), '..')

  function runBuildStep(label: string, command: string[], cwd: string) {
    console.log(`  Building ${label} ...`)
    const proc = Bun.spawnSync(command, { cwd, stdio: ['inherit', 'inherit', 'inherit'] })
    if (proc.exitCode !== 0) {
      console.error(`  ✗ ${label} failed`)
      process.exit(1)
    }
    console.log(`  ✓ ${label}`)
  }

  function buildNapi(name: string) {
    const generatedDts = '.napi-generated.d.ts'
    runBuildStep(`${name} (napi build)`,
      ['npx', 'napi', 'build', '--release', '--dts', generatedDts],
      join(root, name))
    rmSync(join(root, name, generatedDts), { force: true })
  }

  if (process.platform === 'win32') {
    buildNapi('audio-capture-axiomate')
    buildNapi('computer-use-win-napi-axiomate')
  } else if (process.platform === 'darwin') {
    buildNapi('clipboard-axiomate')
    buildNapi('audio-capture-axiomate')
    buildNapi('modifiers-mac-napi-axiomate')
    buildNapi('url-handler-mac-napi-axiomate')
    buildNapi('computer-use-mac-napi-axiomate')
  }
}

const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir: 'dist',
  target: 'bun',
  format: 'esm',

  // Resolve .md and .txt files as text (inlined at build time)
  loader: {
    '.md': 'text',
    '.txt': 'text',
  },

  // Compile-time feature flags (bun:bundle feature()). Empty by default —
  // pass --features=DEV or AXIOMATE_BUILD_FEATURES=DEV to opt in.
  features,

  // Compile-time constant replacement (MACRO.*)
  define: getBuildDefine(pkg, versionChangelog),

  // Mark workspace packages and node_modules as external — don't bundle them
  external: [
    // Workspace packages
    'treeify-axiomate',
    'clipboard-axiomate',
    'image-processor-axiomate',
    'audio-capture-axiomate',
    'sandbox-axiomate',
    'computer-use-mcp-axiomate',
    'computer-use-mac-napi-axiomate',
    'computer-use-win-napi-axiomate',
    'mcpb-axiomate',
    // react-reconciler-axiomate is NOT external — must be bundled
    // (contains useEffectEvent support missing from npm version)

    // npm packages that have native bindings or should not be bundled
    // react is NOT external — must be bundled so bun build picks the
    // production version (NODE_ENV=production define). External react would
    // load the development build at runtime, which calls dispatcher.getOwner()
    // that our reconciler doesn't implement.
    // react-reconciler is NOT external — we bundle react-reconciler-axiomate
    // which has useEffectEvent support (npm version doesn't)
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    '@opentelemetry/*',
    'sharp',
    'ws',
    'semver',
    'zod',
    'commander',
    '@commander-js/extra-typings',
    'diff',
    'lodash-es',
    'chalk',
    'figures',
    'highlight.js',
    'cli-highlight',
    'plist',
    'yaml',
    'turndown',
    'parse5',
    'jsonc-parser',
    'node-forge',
    'modifiers-mac-napi-axiomate',
    'url-handler-mac-napi-axiomate',
  ],

  // Stub the computer-use entry point unless DARWIN or WIN32 feature is
  // set, so the entire utils/computerUse/* source tree is excluded from
  // linux bundles. Aligns with the auto-set default features above
  // (DARWIN on darwin host, WIN32 on win32 host, empty elsewhere) but
  // also respects an explicit --features=DARWIN / --features=WIN32
  // override when cross-building.
  plugins: [
    makeComputerUseStubPlugin(
      !features.includes('DARWIN') && !features.includes('WIN32'),
    ),
  ],
})

if (!result.success) {
  console.error('Build failed:')
  for (const msg of result.logs) {
    console.error(msg)
  }
  process.exit(1)
} else {
  console.log(`Build succeeded: ${result.outputs.length} output(s)`)
  for (const output of result.outputs) {
    console.log(`  ${output.path} (${(output.size / 1024).toFixed(0)} KB)`)
  }
}
