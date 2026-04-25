#!/usr/bin/env bun
/**
 * Debug script: dump what `executor.listInstalledApps()` actually returns
 * on this mac. Run after `bun install` from the agent/ directory:
 *
 *   bun run scripts/cu-debug-installed.ts
 *
 * Prints:
 *   - elapsed time
 *   - total app count
 *   - first 20 entries (bundle id, display name, path)
 *   - explicit lookup for the bundle ids the LLM was guessing
 *   - apps with empty / missing bundleId (suspect entries)
 *
 * Use the output to diagnose why ComputerUseAppListPanel marks all
 * candidates as `(not installed)` even though `mdls` confirms they exist.
 */

import { drainRunLoop } from '../src/utils/computerUse/drainRunLoop.js'
import { requireComputerUseSwift } from '../src/utils/computerUse/swiftLoader.js'

if (process.platform !== 'darwin') {
  console.error('This debug script is darwin-only.')
  process.exit(1)
}

const cu = requireComputerUseSwift()

console.log('Calling cu.apps.listInstalled()...')
const start = Date.now()
let apps: Array<{ bundleId: string; displayName: string; path: string }>
try {
  apps = await drainRunLoop(() => cu.apps.listInstalled())
} catch (err) {
  console.error('listInstalled() threw:', err)
  process.exit(2)
}
const elapsed = Date.now() - start

console.log(`Took ${elapsed} ms`)
console.log(`Returned ${apps.length} apps`)
console.log('')

console.log('--- First 20 entries ---')
for (const app of apps.slice(0, 20)) {
  console.log(
    `  ${(app.bundleId || '<empty>').padEnd(45)} ${(app.displayName || '<no name>').padEnd(30)} ${app.path}`,
  )
}
console.log('')

console.log('--- Suspect entries (empty bundleId) ---')
const suspect = apps.filter(a => !a.bundleId || a.bundleId.trim() === '')
console.log(`Count: ${suspect.length}`)
for (const a of suspect.slice(0, 10)) {
  console.log(
    `  bundleId=${JSON.stringify(a.bundleId)} name=${JSON.stringify(a.displayName)} path=${a.path}`,
  )
}
console.log('')

console.log('--- Lookup for known bundle ids ---')
const targets = [
  'com.google.Chrome',
  'com.googlecode.iterm2',
  'com.apple.Safari',
  'com.apple.Terminal',
  'com.apple.finder',
  'com.microsoft.VSCode',
  'com.tencent.xinWeChat',
  'com.tencent.qq',
]
for (const t of targets) {
  const found = apps.find(a => a.bundleId === t)
  if (found) {
    console.log(`  ${t.padEnd(35)} FOUND   "${found.displayName}" @ ${found.path}`)
  } else {
    // Also check case-insensitive
    const ci = apps.find(
      a => a.bundleId.toLowerCase() === t.toLowerCase(),
    )
    console.log(
      `  ${t.padEnd(35)} ${ci ? `CASE-MISMATCH found "${ci.bundleId}"` : 'NOT FOUND'}`,
    )
  }
}
console.log('')

console.log('--- All bundle ids containing "Chrome", "term", "Terminal" ---')
const re = /chrome|term|safari/i
for (const a of apps) {
  if (re.test(a.bundleId) || re.test(a.displayName)) {
    console.log(
      `  ${a.bundleId.padEnd(45)} ${a.displayName.padEnd(30)} ${a.path}`,
    )
  }
}
