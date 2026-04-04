// ESM preload: provides global `require` for Node.js.
// claude-code uses require() extensively for lazy loading. In Bun, require()
// works in ESM natively. In Node.js, we inject it as a global.
//
// IMPORTANT: require() resolution is path-relative. We create it from
// process.argv[1] (the entry script) so that require('./foo') resolves
// relative to the entry point, not this preload script.
//
// Usage: node --import ./dist/runtime/register.js dist/entrypoints/cli.js

import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { resolve } from 'path'

// @ts-ignore — globalThis.require
if (typeof globalThis.require === 'undefined') {
  // Resolve from the entry script so require('./xxx') works relative to it
  const entryPath = process.argv[1] ? resolve(process.argv[1]) : import.meta.url
  const entryUrl = typeof entryPath === 'string' && !entryPath.startsWith('file:')
    ? pathToFileURL(entryPath).href
    : entryPath
  globalThis.require = createRequire(entryUrl)
}
