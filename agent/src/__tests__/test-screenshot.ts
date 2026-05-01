/**
 * Direct NAPI screenshot test — bypasses MCP server and executor wrappers.
 * Tests captureDisplayScaled for both full-screen and sub-region zoom.
 *
 * Usage: npx tsx src/__tests__/test-screenshot.ts
 * Output: C:/tmp/test_full.jpg, C:/tmp/test_zoom.jpg
 */
import * as winNapi from 'computer-use-win-napi-axiomate'
import * as fs from 'fs'
import * as path from 'path'

// node-screenshots for display geometry
const nsModule = await import('node-screenshots')
const Monitor = nsModule.Monitor ?? (nsModule as any).default?.Monitor
if (!Monitor) throw new Error('node-screenshots Monitor not found')

const monitors = Monitor.all()
const primary = monitors.find((m: any) => m.isPrimary()) ?? monitors[0]
if (!primary) throw new Error('No displays found')

const display = {
  id: primary.id(),
  width: primary.width(),
  height: primary.height(),
  originX: primary.x(),
  originY: primary.y(),
}

console.log(`Display: ${display.width}×${display.height} at (${display.originX}, ${display.originY}), id=${display.id}`)

if (!winNapi.isAvailable()) {
  console.error('Win NAPI not available:', winNapi.getLoadError?.())
  process.exit(1)
}

const LONG_EDGE_CAP = 1920
function computeImageDim(w: number, h: number): [number, number] {
  const longEdge = Math.max(w, h)
  if (longEdge <= LONG_EDGE_CAP) return [w, h]
  const ratio = LONG_EDGE_CAP / longEdge
  return [Math.round(w * ratio), Math.round(h * ratio)]
}

const outDir = 'C:/tmp'
fs.mkdirSync(outDir, { recursive: true })

// ── Test 1: Full-screen screenshot with grid ──────────────────────────────
console.log('\n--- Test 1: Full-screen screenshot ---')
const [tw, th] = computeImageDim(display.width, display.height)
console.log(`  Physical: ${display.width}×${display.height} → Virtual: ${tw}×${th}`)

const fullResult = winNapi.captureDisplayScaled(
  { origin: { x: display.originX, y: display.originY }, size: { w: display.width, h: display.height } },
  tw, th, 92, 2, // gridMode=2 (full)
)

if (!fullResult) {
  console.error('  captureDisplayScaled returned null!')
} else {
  const fullPath = path.join(outDir, 'test_full.jpg')
  fs.writeFileSync(fullPath, Buffer.from(fullResult.base64, 'base64'))
  console.log(`  Image: ${fullResult.width}×${fullResult.height}`)
  console.log(`  Saved: ${fullPath} (${fs.statSync(fullPath).size} bytes)`)
}

// ── Test 2: Sub-region zoom (physical coords, raw NAPI) ───────────────────
console.log('\n--- Test 2: Sub-region zoom (physical coords) ---')
// Pick a 600×600 physical region near center
const zoomPhysX = Math.round(display.originX + display.width / 2 - 300)
const zoomPhysY = Math.round(display.originY + display.height / 2 - 300)
const zoomPhysW = 600
const zoomPhysH = 600
console.log(`  Physical region: (${zoomPhysX}, ${zoomPhysY}) ${zoomPhysW}×${zoomPhysH}`)

const zoomResult = winNapi.captureDisplayScaled(
  { origin: { x: zoomPhysX, y: zoomPhysY }, size: { w: zoomPhysW, h: zoomPhysH } },
  zoomPhysW, zoomPhysH, 92, 2, // keep physical resolution, gridMode=2
)

if (!zoomResult) {
  console.error('  captureDisplayScaled returned null for sub-region!')
} else {
  const zoomPath = path.join(outDir, 'test_zoom.jpg')
  fs.writeFileSync(zoomPath, Buffer.from(zoomResult.base64, 'base64'))
  console.log(`  Image: ${zoomResult.width}×${zoomResult.height}`)
  console.log(`  Saved: ${zoomPath} (${fs.statSync(zoomPath).size} bytes)`)
}

// ── Test 3: Sub-region zoom with virtual coordinate grid ──────────────────
console.log('\n--- Test 3: Zoom with virtual coordinate grid ---')
const ratioX = display.width / tw
const ratioY = display.height / th
const virtualX = Math.round(tw / 2 - 150)
const virtualY = Math.round(th / 2 - 150)
const virtualW = 300
const virtualH = 300
console.log(`  Virtual region: (${virtualX}, ${virtualY}) ${virtualW}×${virtualH}`)
const physX = Math.round(virtualX * ratioX) + display.originX
const physY = Math.round(virtualY * ratioY) + display.originY
const physW = Math.round(virtualW * ratioX)
const physH = Math.round(virtualH * ratioY)
console.log(`  Physical mapped: (${physX}, ${physY}) ${physW}×${physH}`)

const virtualZoomResult = winNapi.captureDisplayScaled(
  { origin: { x: physX, y: physY }, size: { w: physW, h: physH } },
  physW, physH, 92, 2,
  virtualX, virtualY, virtualW, virtualH,  // virtual coord grid params
)

if (!virtualZoomResult) {
  console.error('  captureDisplayScaled returned null!')
} else {
  const vZoomPath = path.join(outDir, 'test_zoom_virtual.jpg')
  fs.writeFileSync(vZoomPath, Buffer.from(virtualZoomResult.base64, 'base64'))
  console.log(`  Image: ${virtualZoomResult.width}×${virtualZoomResult.height}`)
  console.log(`  Saved: ${vZoomPath} (${fs.statSync(vZoomPath).size} bytes)`)
  console.log(`  Grid labels should show virtual coords: ${virtualX}-${virtualX + virtualW} / ${virtualY}-${virtualY + virtualH}`)
}

console.log('\nDone. Check C:/tmp/ for output files.')
