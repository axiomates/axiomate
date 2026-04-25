/**
 * Bun build script for axiomate agent.
 * Mirrors axiomate-code's build process: bundles src/ into a single JS file
 * with compile-time feature flags and MACRO constant injection.
 *
 * Usage: bun run build.ts
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
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

// Auto-include DARWIN feature on darwin host so dev builds (`bun run build`)
// include the computer-use module. Non-darwin host runs strip it via DCE.
const defaultFeatures = process.platform === 'darwin' ? ['DARWIN'] : []
const features = parseFeatures(Bun.argv, process.env, defaultFeatures)
printBuildFeatures('build', features)

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
    'computer-use-native-axiomate',
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

  // Stub the computer-use entry point unless the DARWIN feature is set,
  // so the entire utils/computerUse/* source tree is excluded from non-mac
  // bundles. Aligns with the auto-set default features above
  // (DARWIN on darwin host, empty elsewhere) but also respects an explicit
  // --features=DARWIN override when cross-building from a non-darwin host.
  plugins: [makeComputerUseStubPlugin(!features.includes('DARWIN'))],
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
