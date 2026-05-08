const { loadNapiBinding } = require('../scripts/load-napi.js')

let nativeModule = null
let loadAttempted = false
let loadError = null
let scheme = 'axiomate'

function loadNative() {
  if (loadAttempted) return nativeModule
  loadAttempted = true
  // mac-only by design (package name encodes this).
  if (process.platform !== 'darwin') {
    loadError = `not darwin (process.platform=${process.platform})`
    return null
  }
  const result = loadNapiBinding(__dirname, 'url-handler-mac-napi-axiomate')
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

module.exports.waitForUrlEvent = function waitForUrlEvent(timeoutMs) {
  const mod = loadNative()
  if (!mod) return null

  const url = mod.waitForUrlEvent(timeoutMs)
  if (!url) return null

  // Validate URL matches configured scheme
  const prefix = scheme + '://'
  if (!url.startsWith(prefix)) return null

  return url
}
