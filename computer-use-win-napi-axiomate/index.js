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
  return mod.appUnderPoint({ x, y })
}

// ── Multi-display window mapping ───────────────────────────────────────────

/**
 * Returns Vec<{ appIdentifier, monitorRects: VRect[] }> where each VRect
 * is { origin: { x, y }, size: { w, h } } in virtual-screen physical
 * pixels (same space as `node-screenshots` Monitor.x()/y()/width()/
 * height()). The agent layer maps these to displayIds via origin coord
 * match — see winExecutor.findWindowDisplays.
 */
module.exports.findWindowMonitorRects = function findWindowMonitorRects(appIdentifiers) {
  const mod = loadNative()
  if (!mod) {
    return appIdentifiers.map(appIdentifier => ({ appIdentifier, monitorRects: [] }))
  }
  return mod.findWindowMonitorRects(appIdentifiers)
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

module.exports.hideApp = function hideApp(appIdentifier) {
  const mod = loadNative()
  if (!mod) return false
  return mod.hideApp(appIdentifier)
}

module.exports.unhideApp = function unhideApp(appIdentifier) {
  const mod = loadNative()
  if (!mod) return false
  return mod.unhideApp(appIdentifier)
}

module.exports.listRunningApps = function listRunningApps() {
  const mod = loadNative()
  if (!mod) return []
  return mod.listRunningApps()
}

// ── Per-window screenshot via PrintWindow (DWM-aware) ──────────────────────

module.exports.captureWindow = function captureWindow(appIdentifier, gridMode, marks) {
  const mod = loadNative()
  if (!mod) {
    return {
      image: null,
      diagnostic: `native binding load failed: ${loadError ?? 'unknown'}`,
    }
  }
  return mod.captureWindow(appIdentifier, gridMode, marks)
}

// ── Full-screen BitBlt + Lanczos resize + JPEG (mac-parity capture path) ───

module.exports.captureDisplayScaled = function captureDisplayScaled(
  src,
  targetW,
  targetH,
  jpegQuality,
  gridMode,
  gridOriginX,
  gridOriginY,
  gridRangeW,
  gridRangeH,
  marks,
) {
  const mod = loadNative()
  if (!mod) return null
  return mod.captureDisplayScaled(src, targetW, targetH, jpegQuality, gridMode ?? undefined, gridOriginX ?? undefined, gridOriginY ?? undefined, gridRangeW ?? undefined, gridRangeH ?? undefined, marks ?? undefined)
}

// ── UIAutomation enumeration (SoM overlay for click_target zoom) ─────────
//
// Returns up to 50 visible UI elements whose bbox intersects the input rect.
// Empty Vec on COM failure / non-Windows / native binding load failure —
// agent treats empty as "no marks; fall back to ruler positioning".
module.exports.enumerateUiElementsInRect = function enumerateUiElementsInRect(rect, windowOnly) {
  const mod = loadNative()
  if (!mod) return []
  return mod.enumerateUiElementsInRect(rect, windowOnly)
}

// ── WGC allowlist-filtered capture (Stage 3 skeleton, returns None) ────────

module.exports.captureExcluding = function captureExcluding(opts) {
  const mod = loadNative()
  if (!mod) return null
  return mod.captureExcluding(opts)
}

// ── Win32 mouse input (bypasses nut.js / libnut) ───────────────────────────

module.exports.moveCursor = function moveCursor(p) {
  const mod = loadNative()
  if (!mod) throw new Error(`win NAPI not available: ${loadError ?? 'unknown'}`)
  return mod.moveCursor(p)
}

module.exports.clickMouse = function clickMouse(button, count) {
  const mod = loadNative()
  if (!mod) throw new Error(`win NAPI not available: ${loadError ?? 'unknown'}`)
  return mod.clickMouse(button, count)
}

module.exports.getCursorPos = function getCursorPos() {
  const mod = loadNative()
  if (!mod) throw new Error(`win NAPI not available: ${loadError ?? 'unknown'}`)
  return mod.getCursorPos()
}

module.exports.mouseButtonEvent = function mouseButtonEvent(button, down) {
  const mod = loadNative()
  if (!mod) throw new Error(`win NAPI not available: ${loadError ?? 'unknown'}`)
  return mod.mouseButtonEvent(button, down)
}

module.exports.mouseScroll = function mouseScroll(dx, dy) {
  const mod = loadNative()
  if (!mod) throw new Error(`win NAPI not available: ${loadError ?? 'unknown'}`)
  return mod.mouseScroll(dx, dy)
}

// ── Win32 keyboard input (bypasses nut.js / libnut) ────────────────────────

module.exports.keyEvent = function keyEvent(vk, down, extended) {
  const mod = loadNative()
  if (!mod) throw new Error(`win NAPI not available: ${loadError ?? 'unknown'}`)
  return mod.keyEvent(vk, down, extended)
}

module.exports.typeTextUnicode = function typeTextUnicode(text) {
  const mod = loadNative()
  if (!mod) throw new Error(`win NAPI not available: ${loadError ?? 'unknown'}`)
  return mod.typeTextUnicode(text)
}

module.exports.prewarm = function prewarm() {
  loadNative()
}

// ── Global ESC hotkey (WH_KEYBOARD_LL) ─────────────────────────────────────

/**
 * Install the global ESC hook. Returns false if the binding can't load
 * (caller falls back to "no ESC abort" — same UX as mac without
 * Accessibility permission). Idempotent — re-registering updates the
 * callback and returns true.
 */
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

/**
 * Open a 100ms decay window so the next ESC keydown is treated as
 * model-synthesized (passed through, no abort callback fired). Called by
 * the executor right before injecting a synthetic ESC.
 */
module.exports.notifyExpectedEscape = function notifyExpectedEscape() {
  const mod = loadNative()
  if (!mod) return
  mod.notifyExpectedEscape()
}

/**
 * If axiomate is the current foreground window, hand foreground off to the
 * Z-order #2 visible window (the user's previous app). Used by winExecutor
 * before keyboard input (key / holdKey / type) so SendInput INPUT_KEYBOARD
 * doesn't land in axiomate's own terminal — see Rust doc for details.
 *
 * Returns true if a switch happened (caller should sleep ~20ms before
 * SendInput); false if axiomate wasn't foreground (no-op needed) or no
 * suitable target was found in Z-order.
 */
module.exports.defocusSelfToPreviousForeground = function defocusSelfToPreviousForeground() {
  const mod = loadNative()
  if (!mod) return false
  return mod.defocusSelfToPreviousForeground()
}

// ── Host-window hide / show (pre-screenshot) ────────────────────────

module.exports.hideSelfWindows = function hideSelfWindows() {
  const mod = loadNative()
  if (!mod) return 0
  return mod.hideSelfWindows()
}

module.exports.showSelfWindows = function showSelfWindows() {
  const mod = loadNative()
  if (!mod) return
  mod.showSelfWindows()
}
