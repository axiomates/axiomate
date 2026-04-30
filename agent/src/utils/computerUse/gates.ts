import type { CoordinateMode, CuSubGates } from 'computer-use-mcp-axiomate'

type ChicagoConfig = CuSubGates & {
  enabled: boolean
  coordinateMode: CoordinateMode
}

function defaultCoordinateMode(): CoordinateMode {
  return 'pixels'
}

const DEFAULTS_BASE = {
  enabled: false,
  pixelValidation: false,
  clipboardPasteMultiline: true,
  mouseAnimation: true,
  hideBeforeAction: true,
  autoTargetDisplay: true,
  clipboardGuard: true,
} as const

function readConfig(): ChicagoConfig {
  // Computer-use is enabled on darwin (mac native peer in
  // computer-use-mac-napi-axiomate) and win32 (win native peer in
  // computer-use-win-napi-axiomate, Stage 1 shipped). Build-time DCE
  // via feature('DARWIN') / feature('WIN32') strips the entire module
  // on linux; this runtime gate backs that up for dev / source runs.
  //
  // Note: this gate's `enabled` value drives `adapter.isDisabled()`,
  // which mcpServer.ts uses to gate the ListTools response. False here
  // means the in-process MCP server returns `{ tools: [] }`, and the
  // LLM sees zero computer-use tools even though the server is
  // connected — that's why this gate matters for tool surface.
  const coordinateMode = defaultCoordinateMode()
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return { ...DEFAULTS_BASE, coordinateMode, enabled: false }
  }
  return { ...DEFAULTS_BASE, coordinateMode, enabled: true }
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
