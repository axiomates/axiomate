/**
 * Standalone test: exercise enumerateUiElementsInRect + captureDisplayScaled
 * with marks overlay, dump the JPEG so we can visually verify SoM markers
 * are drawn correctly. No AI, no mouse moves — direct napi calls only.
 *
 * Run: bun computer-use-win-napi-axiomate/test-som.js
 *      (output → test-som-output.jpg in this directory)
 */
const winNapi = require('./index.js')
const fs = require('fs')
const path = require('path')

if (!winNapi.isAvailable()) {
  console.error('napi not available:', winNapi.getLoadError())
  process.exit(1)
}

// Coords passed to enumerate_ui_elements_in_rect are PHYSICAL pixels (the
// napi is Per-Monitor V2 DPI-aware; every Win32 coord API speaks physical
// px). On this machine the primary display is 2560×1440 logical at 1.5x
// DPI = 3840×2160 physical. The Win11 taskbar sits at physical y≈2064..2160.
const SCREEN_W_PHYS = 3840
const SCREEN_H_PHYS = 2160
const TASKBAR_H_PHYS = 110
const taskbarRect = {
  origin: { x: 0, y: SCREEN_H_PHYS - TASKBAR_H_PHYS },
  size:   { w: SCREEN_W_PHYS, h: TASKBAR_H_PHYS },
}

console.log(`[test-som] enumerating UI elements in ${JSON.stringify(taskbarRect)}`)
const t0 = Date.now()
const elements = winNapi.enumerateUiElementsInRect(taskbarRect)
const t1 = Date.now()
console.log(`[test-som] got ${elements.length} elements in ${t1 - t0}ms`)
for (const [i, el] of elements.entries()) {
  console.log(`  #${i + 1} ${el.role.padEnd(12)} "${el.name}" bbox=${JSON.stringify(el.bbox)} automationId=${el.automationId ?? '(none)'}`)
}

if (elements.length === 0) {
  console.warn('[test-som] No elements detected — taskbar may not be visible, or UIA returned nothing for this rect.')
}

// Build MarkOverlay list — id starts at 1, x/y = element center (in same
// virtual coord space as the captureDisplayScaled grid params will use).
const marks = elements.map((el, i) => ({
  id: i + 1,
  x: Math.round(el.bbox.origin.x + el.bbox.size.w / 2),
  y: Math.round(el.bbox.origin.y + el.bbox.size.h / 2),
}))

console.log(`[test-som] capturing taskbar region with ${marks.length} marks overlaid`)
const t2 = Date.now()
const result = winNapi.captureDisplayScaled(
  taskbarRect,
  taskbarRect.size.w,           // target_w (no resize)
  taskbarRect.size.h,           // target_h
  92,                           // jpeg_quality
  2,                            // grid_mode (2 = full ruler)
  taskbarRect.origin.x,         // grid_origin_x
  taskbarRect.origin.y,         // grid_origin_y
  taskbarRect.size.w,           // grid_range_w
  taskbarRect.size.h,           // grid_range_h
  marks,                        // ← the new param
)
const t3 = Date.now()
if (!result) {
  console.error('[test-som] captureDisplayScaled returned null')
  process.exit(1)
}
console.log(`[test-som] captured ${result.width}×${result.height} in ${t3 - t2}ms`)

const outPath = path.join(__dirname, 'test-som-output.jpg')
fs.writeFileSync(outPath, Buffer.from(result.base64, 'base64'))
console.log(`[test-som] wrote ${outPath} (${fs.statSync(outPath).size} bytes)`)
console.log('[test-som] open the JPG to visually verify the red numbered circles land on taskbar icons.')
