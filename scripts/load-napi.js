/**
 * Shared napi binding loader. Single source of truth for filename
 * patterns — preventing the silent "filename mismatch" footgun where
 * `napi build` produces `<name>.node` (plain) but a hand-written
 * loader only checks `<name>.<platform>-<arch>.node` (triple-suffix)
 * candidates and silently returns null.
 *
 * Usage from each NAPI package's index.js:
 *
 *   const { loadNapiBinding } = require('../scripts/load-napi.js')
 *   const { mod, error } = loadNapiBinding(__dirname, 'my-package-name')
 *   // mod is the binding (or null on fail)
 *   // error is null on success; otherwise a human-readable string
 *   // explaining which candidates were tried and why each failed
 *
 * Platform-agnostic by design: callers (e.g. mac-only packages) decide
 * whether to short-circuit by `process.platform` BEFORE invoking this
 * util. Cross-platform packages (audio-capture) just call it directly.
 */
const { join } = require('node:path')

function loadNapiBinding(packageDir, packageName) {
  const candidates = [
    // napi build (host) default output — works for fresh dev builds
    // on any platform (napi-rs CLI 2.x). This is what bootstrap's
    // `napi build --release` produces with no --target flag.
    join(packageDir, `${packageName}.node`),
    // Triple-suffix variant — used when distributing prebuilt binaries
    // for multiple platforms via npm (CI matrix) or when explicitly
    // building with `napi build --target <triple>`.
    join(packageDir, `${packageName}.${process.platform}-${process.arch}.node`),
  ]

  const errors = []
  for (const candidate of candidates) {
    try {
      return { mod: require(candidate), error: null }
    } catch (e) {
      errors.push(`${candidate}: ${e && e.message ? e.message : String(e)}`)
    }
  }
  return {
    mod: null,
    error: `tried ${candidates.length} candidate(s): ${errors.join(' | ')}`,
  }
}

module.exports = { loadNapiBinding }
