// JS entry point: Rust NAPI on macOS (sync fast path), fallback for all platforms (async).

const { loadNapiBinding } = require('../scripts/load-napi.js')

let nativeModule = null
let loadAttempted = false
let loadError = null

function loadNative() {
  if (loadAttempted) return nativeModule
  loadAttempted = true
  // mac NAPI is the fast sync path; non-darwin uses the JS fallback
  // (PowerShell on Windows, xclip/wl-paste on Linux). No NAPI build
  // for those platforms today, so short-circuit here keeps loadError
  // semantically accurate ("not darwin" vs an actual load failure).
  if (process.platform !== 'darwin') {
    loadError = `not darwin (process.platform=${process.platform})`
    return null
  }
  const result = loadNapiBinding(__dirname, 'clipboard-axiomate')
  nativeModule = result.mod
  loadError = result.error
  return nativeModule
}

module.exports.isAvailable = function isAvailable() {
  return loadNative() !== null
}

module.exports.getLoadError = function getLoadError() {
  return loadError
}

// Lazy-load fallback module
let fallbackModule = null
function getFallback() {
  if (!fallbackModule) {
    fallbackModule = require('./dist/fallback.js')
  }
  return fallbackModule
}

// --- Sync API (macOS NAPI only, returns false/null on other platforms) ---

module.exports.hasClipboardImage = function hasClipboardImage() {
  const mod = loadNative()
  return mod ? mod.hasClipboardImage() : false
}

module.exports.readClipboardImage = function readClipboardImage(maxWidth, maxHeight) {
  const mod = loadNative()
  return mod ? mod.readClipboardImage(maxWidth, maxHeight) : null
}

// --- Async API (cross-platform: NAPI when available, fallback otherwise) ---

module.exports.hasClipboardImageAsync = async function hasClipboardImageAsync() {
  const mod = loadNative()
  if (mod) return mod.hasClipboardImage()
  return getFallback().hasClipboardImageAsync()
}

module.exports.readClipboardImageAsync = async function readClipboardImageAsync(maxWidth, maxHeight) {
  const mod = loadNative()
  if (mod) return mod.readClipboardImage(maxWidth, maxHeight)
  return getFallback().readClipboardImageAsync(maxWidth, maxHeight)
}

module.exports.readClipboardText = async function readClipboardText() {
  return getFallback().readClipboardText()
}
