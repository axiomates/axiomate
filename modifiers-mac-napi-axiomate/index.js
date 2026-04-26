const { loadNapiBinding } = require('../scripts/load-napi.js')

let nativeModule = null
let loadAttempted = false
let loadError = null

function loadNative() {
  if (loadAttempted) return nativeModule
  loadAttempted = true
  // mac-only by design (package name encodes this).
  if (process.platform !== 'darwin') {
    loadError = `not darwin (process.platform=${process.platform})`
    return null
  }
  const result = loadNapiBinding(__dirname, 'modifiers-mac-napi-axiomate')
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

module.exports.getModifiers = function getModifiers() {
  const mod = loadNative()
  return mod ? mod.getModifiers() : []
}

module.exports.isModifierPressed = function isModifierPressed(modifier) {
  const mod = loadNative()
  return mod ? mod.isModifierPressed(modifier) : false
}

module.exports.prewarm = function prewarm() {
  loadNative()
}
