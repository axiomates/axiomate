const { loadNapiBinding } = require('../scripts/load-napi.js')

let nativeModule = null
let loadAttempted = false
// Captures *why* loadNative() returned null. Surfaced via getLoadError() so
// callers (e.g. captureWindow's diagnostic) can show the real cause —
// "file not found", "dyld arch mismatch", etc. — instead of a generic
// "binding not available" message that hides build/install issues.
let loadError = null

function loadNative() {
  if (loadAttempted) return nativeModule
  loadAttempted = true
  // mac-only by design (the package name encodes this). Cross-platform
  // dispatch lives in computer-use-mcp-axiomate, which only routes here
  // on darwin.
  if (process.platform !== 'darwin') {
    loadError = `not darwin (process.platform=${process.platform})`
    return null
  }
  const result = loadNapiBinding(__dirname, 'computer-use-mac-napi-axiomate')
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

// AXIsProcessTrusted() — does this process have Accessibility permission?
// false → AX queries silently return empty / kAXErrorAPIDisabled, which is
// the typical reason `enumerateUiElementsBulkForApp` returns zero elements
// without erroring. Cheap to call; safe to log every screenshot.
module.exports.isAccessibilityTrusted = function isAccessibilityTrusted() {
  const mod = loadNative()
  if (!mod) return false
  return mod.isAccessibilityTrusted()
}

// ── NSRunningApplication hide / unhide (prepareDisplay support) ────────────

module.exports.hideApp = async function hideApp(bundleId) {
  const mod = loadNative()
  if (!mod) return false
  return mod.hideApp(bundleId)
}

module.exports.unhideApp = async function unhideApp(bundleId) {
  const mod = loadNative()
  if (!mod) return false
  return mod.unhideApp(bundleId)
}

module.exports.activateApp = async function activateApp(bundleId) {
  const mod = loadNative()
  if (!mod) return false
  return mod.activateApp(bundleId)
}

// ── CGEventTap (global Esc hotkey) ─────────────────────────────────────────

module.exports.registerEscapeHotkey = function registerEscapeHotkey(callback) {
  const mod = loadNative()
  if (!mod) return false
  return mod.registerEscapeHotkey(callback)
}

module.exports.unregisterEscapeHotkey = function unregisterEscapeHotkey() {
  const mod = loadNative()
  if (!mod) return
  mod.unregisterEscapeHotkey()
}

module.exports.notifyExpectedEscape = function notifyExpectedEscape() {
  const mod = loadNative()
  if (!mod) return
  mod.notifyExpectedEscape()
}

// ── SCContentFilter (allowlist-filtered screenshot) ────────────────────────

module.exports.captureExcluding = async function captureExcluding(opts) {
  const mod = loadNative()
  if (!mod) return null
  return mod.captureExcluding(opts)
}

module.exports.captureWindow = async function captureWindow(bundleId) {
  const mod = loadNative()
  if (!mod) {
    return {
      image: null,
      diagnostic: `native binding load failed: ${loadError ?? 'unknown'}`,
    }
  }
  return mod.captureWindow(bundleId)
}

// ── Window enumeration: display mapping + point hit-test ───────────────────

module.exports.findWindowDisplays = function findWindowDisplays(bundleIds) {
  const mod = loadNative()
  if (!mod) {
    // Empty display lists for every bundle — caller's contract tolerates this.
    return bundleIds.map(bundleId => ({ bundleId, displayIds: [] }))
  }
  return mod.findWindowDisplays(bundleIds)
}

module.exports.appUnderPoint = function appUnderPoint(x, y) {
  const mod = loadNative()
  if (!mod) return null
  return mod.appUnderPoint(x, y)
}

module.exports.getFrontmostApp = function getFrontmostApp() {
  const mod = loadNative()
  if (!mod) return null
  return mod.getFrontmostApp()
}

module.exports.contentAppUnderPoint = function contentAppUnderPoint(x, y) {
  const mod = loadNative()
  if (!mod) return null
  return mod.contentAppUnderPoint(x, y)
}

module.exports.strictAppUnderPoint = function strictAppUnderPoint(x, y) {
  const mod = loadNative()
  if (!mod) return null
  return mod.strictAppUnderPoint(x, y)
}

module.exports.listVisibleWindowsDetailed = async function listVisibleWindowsDetailed() {
  const mod = loadNative()
  if (!mod) return []
  return mod.listVisibleWindowsDetailed()
}

// Phase 1.5 bulk pull. Walks the app's AX tree pre-order using
// AXUIElementCopyMultipleAttributeValues (one IPC per node). Stops at
// AXWebArea. No filtering at the Rust layer.
module.exports.enumerateUiElementsBulkForApp = async function enumerateUiElementsBulkForApp(bundleId) {
  const mod = loadNative()
  if (!mod) {
    return {
      elements: [],
      browserViewportBboxes: [],
      elapsedMs: 0,
      truncatedByWalltime: false,
    }
  }
  return mod.enumerateUiElementsBulkForApp(bundleId)
}

module.exports.enumerateUiElementsBulkForMacWindow = async function enumerateUiElementsBulkForMacWindow(windowId, bundleId) {
  const mod = loadNative()
  if (!mod) {
    return {
      elements: [],
      browserViewportBboxes: [],
      elapsedMs: 0,
      truncatedByWalltime: false,
    }
  }
  return mod.enumerateUiElementsBulkForMacWindow(windowId, bundleId)
}

module.exports.prewarm = function prewarm() {
  loadNative()
}
