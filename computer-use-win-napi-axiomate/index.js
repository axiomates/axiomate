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

module.exports.findWindowDisplays = function findWindowDisplays(bundleIds) {
  const mod = loadNative()
  if (!mod) {
    return bundleIds.map(bundleId => ({ bundleId, displayIds: [] }))
  }
  return mod.findWindowDisplays(bundleIds)
}

// ── Elevation probe (TokenElevation read) ──────────────────────────────────

module.exports.isRunningElevated = function isRunningElevated() {
  const mod = loadNative()
  if (!mod) return false
  return mod.isRunningElevated()
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

module.exports.prewarm = function prewarm() {
  loadNative()
}
