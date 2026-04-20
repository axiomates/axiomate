let nativeModule = null
let loadAttempted = false

function loadNative() {
  if (loadAttempted) return nativeModule
  loadAttempted = true

  const platform = process.platform
  const arch = process.arch
  const candidates = [
    './audio-capture-axiomate.node',
    `./audio-capture-axiomate.${platform}-${arch}.node`,
  ]

  for (const candidate of candidates) {
    try {
      nativeModule = require(candidate)
      return nativeModule
    } catch {
      // try next
    }
  }
  return null
}

module.exports.isNativeAudioAvailable = function isNativeAudioAvailable() {
  const mod = loadNative()
  return mod ? mod.isNativeAudioAvailable() : false
}

module.exports.startNativeRecording = function startNativeRecording(onData, onEnd) {
  const mod = loadNative()
  return mod ? mod.startNativeRecording(onData, onEnd) : false
}

module.exports.stopNativeRecording = function stopNativeRecording() {
  const mod = loadNative()
  if (mod) mod.stopNativeRecording()
}

module.exports.isNativeRecordingActive = function isNativeRecordingActive() {
  const mod = loadNative()
  return mod ? mod.isNativeRecordingActive() : false
}

module.exports.startNativePlayback = function startNativePlayback(sampleRate, channels) {
  const mod = loadNative()
  return mod ? mod.startNativePlayback(sampleRate, channels) : false
}

module.exports.writeNativePlaybackData = function writeNativePlaybackData(data) {
  const mod = loadNative()
  return mod ? mod.writeNativePlaybackData(data) : false
}

module.exports.stopNativePlayback = function stopNativePlayback() {
  const mod = loadNative()
  if (mod) mod.stopNativePlayback()
}

module.exports.isNativePlaying = function isNativePlaying() {
  const mod = loadNative()
  return mod ? mod.isNativePlaying() : false
}

module.exports.microphoneAuthorizationStatus = function microphoneAuthorizationStatus() {
  const mod = loadNative()
  return mod ? mod.microphoneAuthorizationStatus() : 0
}
