#!/usr/bin/env bun
/**
 * Test the actual screenshot path that the LLM hits inside axiomate.
 * Run from agent/:  bun run scripts/cu-debug-screenshot.ts
 *
 * The LLM said "原生截图模块加载失败" but that's its own guess. This
 * script invokes the same code path with explicit error output so we can
 * see the real exception / stack.
 */

import { drainRunLoop } from '../src/utils/computerUse/drainRunLoop.js'
import { requireComputerUseSwift } from '../src/utils/computerUse/swiftLoader.js'

if (process.platform !== 'darwin') {
  console.error('darwin-only')
  process.exit(1)
}

console.log('Step 1: load native module via requireComputerUseSwift()')
let cu
try {
  cu = requireComputerUseSwift()
  console.log('  OK — type:', typeof cu, 'has apps?', !!cu.apps, 'has screenshot?', !!cu.screenshot)
} catch (e) {
  console.error('  FAILED to load module:')
  console.error(e)
  process.exit(2)
}

console.log('')
console.log('Step 2: cu.apps.listInstalled() — sanity check')
try {
  const apps = await drainRunLoop(() => cu.apps.listInstalled())
  console.log('  OK — count:', apps.length)
} catch (e) {
  console.error('  FAILED:')
  console.error(e)
}

console.log('')
console.log('Step 3: cu.screenshot.captureExcluding(...) — the actual screenshot call')
try {
  const result = await drainRunLoop(() =>
    cu.screenshot.captureExcluding([], 0.75, 1920, 1080, undefined),
  )
  console.log('  OK — type:', typeof result)
  if (result && typeof result === 'object') {
    console.log('  constructor:', result.constructor?.name)
    console.log('  Buffer.isBuffer:', Buffer.isBuffer(result))
    if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
      console.log('  byteLength:', result.length || result.byteLength)
    } else {
      console.log('  keys:', Object.keys(result).join(', '))
      console.log('  JSON preview:', JSON.stringify(result).slice(0, 500))
    }
  }
} catch (e) {
  console.error('  FAILED:')
  console.error(e)
  if (e instanceof Error) {
    console.error('  stack:', e.stack)
  }
}

console.log('')
console.log('Step 4: cu.tcc.checkScreenRecording() — sanity check')
try {
  const r = cu.tcc.checkScreenRecording()
  console.log('  OK — returns:', r, '(stub always returns true)')
} catch (e) {
  console.error('  FAILED:', e)
}
