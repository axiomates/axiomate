const { loadNapiBinding } = require('../scripts/load-napi.js')

let nativeModule = null
let loadAttempted = false
// Captures *why* loadNative() returned null, surfaced via getLoadError().
// Mirrors computer-use-mac-napi-axiomate so callers can show actual cause
// (file not found, ABI mismatch, etc.) instead of a generic null.
let loadError = null

function loadNative() {
  if (loadAttempted) return nativeModule
  loadAttempted = true
  // win-only by design (the package name encodes this). Cross-platform
  // dispatch lives in computer-use-mcp-axiomate, which only routes here
  // on win32.
  if (process.platform !== 'win32') {
    loadError = `not win32 (process.platform=${process.platform})`
    return null
  }
  const result = loadNapiBinding(__dirname, 'computer-use-win-napi-axiomate')
  nativeModule = result.mod
  loadError = result.error
  return nativeModule
}

module.exports.getLoadError = function getLoadError() {
  return loadError
}

module.exports.isAvailable = function isAvailable() {
  return loadNative() !== null
}

// ── Registry-walk app enumeration ──────────────────────────────────────────

module.exports.listInstalledApps = function listInstalledApps() {
  const mod = loadNative()
  if (!mod) return []
  return mod.listInstalledApps()
}

// ── Click safety hit-test ──────────────────────────────────────────────────

module.exports.appUnderPoint = function appUnderPoint(x, y) {
  const mod = loadNative()
  if (!mod) return null
  return mod.appUnderPoint(x, y)
}

// ── Multi-display window mapping ───────────────────────────────────────────

/**
 * Returns Vec<{ bundleId, monitorRects: [{x,y,width,height}] }> in raw
 * Win32 physical pixel coords (same space as `node-screenshots`
 * Monitor.x()/y()/width()/height()). The agent layer maps these to
 * displayIds via origin coord match — see winExecutor.findWindowDisplays.
 *
 * Renamed from findWindowDisplays in Stage 2.x because the previous
 * impl returned positional indices that didn't align with
 * node-screenshots' opaque ID scheme.
 */
module.exports.findWindowMonitorRects = function findWindowMonitorRects(bundleIds) {
  const mod = loadNative()
  if (!mod) {
    return bundleIds.map(bundleId => ({ bundleId, monitorRects: [] }))
  }
  return mod.findWindowMonitorRects(bundleIds)
}

// ── Elevation probe (TokenElevation read) ──────────────────────────────────

module.exports.isRunningElevated = function isRunningElevated() {
  const mod = loadNative()
  if (!mod) return false
  return mod.isRunningElevated()
}

module.exports.getHostAncestorPaths = function getHostAncestorPaths() {
  const mod = loadNative()
  if (!mod) return []
  return mod.getHostAncestorPaths()
}

// ── Foreground window (Win32 fast path) ────────────────────────────────────

module.exports.getForegroundWindow = function getForegroundWindow() {
  const mod = loadNative()
  if (!mod) return null
  return mod.getForegroundWindow()
}

// ── Hide / unhide app windows (ShowWindow) ─────────────────────────────────

module.exports.hideApp = function hideApp(bundleId) {
  const mod = loadNative()
  if (!mod) return false
  return mod.hideApp(bundleId)
}

module.exports.unhideApp = function unhideApp(bundleId) {
  const mod = loadNative()
  if (!mod) return false
  return mod.unhideApp(bundleId)
}

module.exports.listRunningApps = function listRunningApps() {
  const mod = loadNative()
  if (!mod) return []
  return mod.listRunningApps()
}

// ── Per-window screenshot via PrintWindow (DWM-aware) ──────────────────────

module.exports.captureWindow = function captureWindow(bundleId) {
  const mod = loadNative()
  if (!mod) {
    return {
      image: null,
      diagnostic: `native binding load failed: ${loadError ?? 'unknown'}`,
    }
  }
  return mod.captureWindow(bundleId)
}

// ── Full-screen BitBlt + Lanczos resize + JPEG (mac-parity capture path) ───

module.exports.captureDisplayScaled = function captureDisplayScaled(
  physicalX,
  physicalY,
  physicalW,
  physicalH,
  targetW,
  targetH,
  jpegQuality,
) {
  const mod = loadNative()
  if (!mod) return null
  return mod.captureDisplayScaled(
    physicalX,
    physicalY,
    physicalW,
    physicalH,
    targetW,
    targetH,
    jpegQuality,
  )
}

// ── WGC allowlist-filtered capture (Stage 3 skeleton, returns None) ────────

module.exports.captureExcluding = function captureExcluding(opts) {
  const mod = loadNative()
  if (!mod) return null
  return mod.captureExcluding(opts)
}

module.exports.prewarm = function prewarm() {
  loadNative()
}
