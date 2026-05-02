/**
 * Debug script: probe what UIA actually sees for various rect sizes /
 * positions, to understand why taskbar items aren't being detected.
 */
const winNapi = require('./index.js')

if (!winNapi.isAvailable()) {
  console.error('napi not available:', winNapi.getLoadError())
  process.exit(1)
}

// Try a series of rects to understand what's happening:
const tests = [
  { name: 'WHOLE SCREEN (1440p)',     rect: { origin: { x: 0,    y: 0    }, size: { w: 2560, h: 1440 } } },
  { name: 'TASKBAR strip (bottom)',   rect: { origin: { x: 0,    y: 1340 }, size: { w: 2560, h: 100  } } },
  { name: 'TASKBAR center 600x80',    rect: { origin: { x: 980,  y: 1360 }, size: { w: 600,  h: 80   } } },
  { name: 'TASKBAR LARGER 2560x200',  rect: { origin: { x: 0,    y: 1240 }, size: { w: 2560, h: 200  } } },
  { name: 'WHOLE virtual desktop',    rect: { origin: { x: -3840, y: -1080 }, size: { w: 11520, h: 4320 } } },
]

for (const t of tests) {
  const t0 = Date.now()
  const els = winNapi.enumerateUiElementsInRect(t.rect)
  const dt = Date.now() - t0
  console.log(`\n=== ${t.name}  rect=${JSON.stringify(t.rect)}  ${dt}ms  ${els.length} elements ===`)
  for (const [i, el] of els.entries()) {
    console.log(`  #${i + 1} ${el.role.padEnd(12)} "${el.name}" bbox=${JSON.stringify(el.bbox)} aid=${el.automationId ?? '-'}`)
  }
}
