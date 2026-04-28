/**
 * Screenshot implementation using node-screenshots — macOS only.
 *
 * Phase D2 moved this from `computer-use-native-axiomate/src/screenshot.ts`
 * (cross-platform). Phase E stripped the Windows branch (Win uses
 * winFallbacks.ts directly) and the headless-display guard (mac always has
 * a display server; if `node-screenshots` ever fails to load, the require()
 * throw surfaces directly instead of going through a wrapper).
 */

import { createRequire } from 'node:module'

type MonitorType = import('node-screenshots').Monitor
type MonitorClass = typeof import('node-screenshots').Monitor

let _MonitorClass: MonitorClass | null = null
let _loadError: string | null = null

function getMonitorClass(): MonitorClass {
  if (_loadError) throw new Error(_loadError)
  if (_MonitorClass) return _MonitorClass

  try {
    // Use createRequire for ESM compatibility; native .node files can't be import()'d
    const req = createRequire(import.meta.url)
    const mod = req('node-screenshots')
    _MonitorClass = mod.Monitor
    return _MonitorClass!
  } catch (e: any) {
    _loadError = `node-screenshots failed to load: ${e.message}`
    throw new Error(_loadError)
  }
}

export interface DisplayInfo {
  displayId: number
  /** Physical pixel width. */
  physicalWidth: number
  /** Physical pixel height. */
  physicalHeight: number
  /** Logical width (physicalWidth / scaleFactor). Used by nut.js and OS coordinates. */
  width: number
  /** Logical height (physicalHeight / scaleFactor). Used by nut.js and OS coordinates. */
  height: number
  scaleFactor: number
  /** Logical origin X. */
  originX: number
  /** Logical origin Y. */
  originY: number
  isPrimary: boolean
  label: string
}

export interface CaptureResult {
  base64: string
  width: number
  height: number
}

/**
 * On macOS, node-screenshots' Monitor.width() / .height() / .x() / .y()
 * return LOGICAL (point) coordinates. We compute physical pixels by
 * multiplying by the scale factor. (On Win the convention is reversed —
 * physical pixels — but Win uses winFallbacks.ts, not this module.)
 */
function monitorToDisplayInfo(m: MonitorType): DisplayInfo {
  const scale = m.scaleFactor()
  const logW = m.width()
  const logH = m.height()
  const logOriginX = m.x()
  const logOriginY = m.y()
  const physW = Math.round(logW * scale)
  const physH = Math.round(logH * scale)

  return {
    displayId: m.id(),
    physicalWidth: physW,
    physicalHeight: physH,
    width: logW,
    height: logH,
    scaleFactor: scale,
    originX: logOriginX,
    originY: logOriginY,
    isPrimary: m.isPrimary(),
    label: m.name() || `Display ${m.id()}`,
  }
}

export function listDisplays(): DisplayInfo[] {
  return getMonitorClass().all().map(monitorToDisplayInfo)
}

export function getDisplaySize(displayId?: number): DisplayInfo {
  const monitors = getMonitorClass().all()
  if (displayId !== undefined) {
    const m = monitors.find(m => m.id() === displayId)
    if (m) return monitorToDisplayInfo(m)
  }
  const primary = monitors.find(m => m.isPrimary()) ?? monitors[0]
  if (!primary) throw new Error('No displays found')
  return monitorToDisplayInfo(primary)
}

export function findDisplayByPoint(x: number, y: number): DisplayInfo | null {
  const m = getMonitorClass().fromPoint(x, y)
  return m ? monitorToDisplayInfo(m) : null
}

function findMonitor(displayId?: number): MonitorType {
  const monitors = getMonitorClass().all()
  if (displayId !== undefined) {
    const m = monitors.find(m => m.id() === displayId)
    if (m) return m
  }
  const primary = monitors.find(m => m.isPrimary()) ?? monitors[0]
  if (!primary) throw new Error('No displays found')
  return primary
}

export async function captureDisplay(displayId?: number): Promise<CaptureResult> {
  const monitor = findMonitor(displayId)
  const image = await monitor.captureImage()
  // node-screenshots toJpeg returns JPEG buffer (copyOutputData flag, not quality)
  const jpeg = await image.toJpeg()
  const base64 = Buffer.from(jpeg).toString('base64')
  return { base64, width: image.width, height: image.height }
}

/**
 * Capture a region of a display's screenshot.
 * Coordinates are **relative to the display's screenshot image** (0,0 = top-left of that display).
 * This matches what AI sees: screenshot pixel coordinates within a single display.
 */
export async function captureRegion(
  x: number,
  y: number,
  w: number,
  h: number,
  displayId?: number,
): Promise<CaptureResult> {
  const monitor = findMonitor(displayId)
  const image = await monitor.captureImage()
  const cropped = await image.crop(x, y, w, h)
  const jpeg = await cropped.toJpeg()
  const base64 = Buffer.from(jpeg).toString('base64')
  return { base64, width: cropped.width, height: cropped.height }
}
