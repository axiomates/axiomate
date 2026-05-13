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
const { join, dirname } = require('node:path')
const { existsSync } = require('node:fs')
const Module = require('node:module')

function dlopen(filepath) {
  const m = new Module(filepath)
  process.dlopen(m, filepath)
  return m.exports
}

function loadNapiBinding(packageDir, packageName) {
  // In a Bun-compiled exe, __dirname is baked to the BUILD machine path.
  // The .node files are actually copied next to the exe, so we also search
  // dirname(process.execPath) as a fallback directory.
  const searchDirs = [packageDir]
  const exeDir = dirname(process.execPath)
  if (exeDir !== packageDir) searchDirs.push(exeDir)

  const suffixes = [
    `${packageName}.node`,
    `${packageName}.${process.platform}-${process.arch}.node`,
  ]

  const errors = []
  for (const dir of searchDirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, suffix)
      try {
        return { mod: require(candidate), error: null }
      } catch (e) {
        if (existsSync(candidate)) {
          try {
            return { mod: dlopen(candidate), error: null }
          } catch (e2) {
            errors.push(`${candidate}: dlopen: ${e2 && e2.message ? e2.message : String(e2)}`)
            continue
          }
        }
        errors.push(`${candidate}: ${e && e.message ? e.message : String(e)}`)
      }
    }
  }
  return {
    mod: null,
    error: `tried ${errors.length} candidate(s): ${errors.join(' | ')}`,
  }
}

module.exports = { loadNapiBinding }
