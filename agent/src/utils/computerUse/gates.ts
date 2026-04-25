import type { CoordinateMode, CuSubGates } from 'computer-use-dispatch-axiomate'

type ChicagoConfig = CuSubGates & {
  enabled: boolean
  coordinateMode: CoordinateMode
}

const DEFAULTS: ChicagoConfig = {
  enabled: false,
  pixelValidation: false,
  clipboardPasteMultiline: true,
  mouseAnimation: true,
  hideBeforeAction: true,
  autoTargetDisplay: true,
  clipboardGuard: true,
  coordinateMode: 'pixels',
}

function readConfig(): ChicagoConfig {
  // Hard-guard non-darwin: the native module assumes macOS APIs
  // (SCContentFilter / NSWorkspace / TCC) plus pbcopy/pbpaste in executor.ts.
  // Build-time DCE via feature('DARWIN') in builtinTools.ts already strips
  // the entire module on non-darwin builds; this runtime guard backs that
  // up for dev / source runs.
  if (process.platform !== 'darwin') {
    return { ...DEFAULTS, enabled: false }
  }
  return { ...DEFAULTS, enabled: true }
}

export function getChicagoEnabled(): boolean {
  return readConfig().enabled
}

export function getChicagoSubGates(): CuSubGates {
  const { enabled: _e, coordinateMode: _c, ...subGates } = readConfig()
  return subGates
}

let frozenCoordinateMode: CoordinateMode | undefined
export function getChicagoCoordinateMode(): CoordinateMode {
  frozenCoordinateMode ??= readConfig().coordinateMode
  return frozenCoordinateMode
}
