/**
 * Bun build script for axiomate agent.
 * Mirrors claude-code's build process: bundles src/ into a single JS file
 * with compile-time feature flags and MACRO constant injection.
 *
 * Usage: bun run build.ts
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'

const pkg = JSON.parse(readFileSync(join(dirname(import.meta.path), 'package.json'), 'utf-8'))

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

  // Compile-time constant replacement (MACRO.*)
  define: {
    'MACRO.VERSION': JSON.stringify(pkg.version || '0.1.0'),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.PACKAGE_URL': JSON.stringify(pkg.name || 'axiomate'),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(pkg.name || 'axiomate'),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/user/axiomate/issues'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify('Report issues at https://github.com/user/axiomate/issues'),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
    // Force production mode for React (development mode's useEffectEvent
    // dispatcher doesn't work with our bundled reconciler)
    'process.env.NODE_ENV': JSON.stringify('production'),
  },

  // Mark workspace packages and node_modules as external — don't bundle them
  external: [
    // Workspace packages
    'treeify-axiomate',
    'clipboard-axiomate',
    'image-processor-axiomate',
    'audio-capture-axiomate',
    'sandbox-axiomate',
    'computer-use-mcp-axiomate',
    'computer-use-native-axiomate',
    'mcpb-axiomate',
    'chrome-mcp-axiomate',
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
    '@anthropic-ai/bedrock-sdk',
    '@anthropic-ai/vertex-sdk',
    '@anthropic-ai/foundry-sdk',
    '@aws-sdk/*',
    '@azure/*',
    '@modelcontextprotocol/sdk',
    '@opentelemetry/*',
    '@growthbook/growthbook',
    'sharp',
    'ws',
    'semver',
    'zod',
    'commander',
    '@commander-js/extra-typings',
    'google-auth-library',
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
