import type {
  ComputerUseHostAdapter,
  Logger,
} from 'computer-use-mcp-axiomate'
import { format } from 'util'
import { logForDebugging } from '../debug.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { createCliExecutor } from './executor.js'
import { createWinExecutor } from './winExecutor.js'
import { getChicagoEnabled, getChicagoSubGates } from './gates.js'
import { requireComputerUseSwift } from './swiftLoader.js'

class DebugLogger implements Logger {
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}

let cached: ComputerUseHostAdapter | undefined

/**
 * Process-lifetime singleton. Built once on first CU tool call; native modules
 * (both `computer-use-native-axiomate` and `computer-use-native-axiomate`) are loaded
 * here via the executor factory, which throws on load failure — there is no
 * degraded mode.
 */
export function getComputerUseHostAdapter(): ComputerUseHostAdapter {
  if (cached) return cached
  const isMac = process.platform === 'darwin'
  // One-time init diagnostic: echoes what the host process sees for the
  // bypass env var and key capability flags. The most common confusion
  // mode is "I set AXIOMATE_CU_BYPASS_ALLOWLIST in shell A but axiomate
  // is running in shell B / Bun-compiled exe doesn't inherit env" —
  // this surfaces it immediately at startup.
  logForDebugging(
    `[computer-use] init: AXIOMATE_CU_BYPASS_ALLOWLIST=${
      process.env.AXIOMATE_CU_BYPASS_ALLOWLIST === undefined
        ? '<unset>'
        : JSON.stringify(process.env.AXIOMATE_CU_BYPASS_ALLOWLIST)
    } platform=${process.platform} isMac=${isMac}`,
    { level: 'warn' },
  )
  cached = {
    serverName: COMPUTER_USE_MCP_SERVER_NAME,
    logger: new DebugLogger(),
    executor: isMac
      ? createCliExecutor({
          getMouseAnimationEnabled: () => getChicagoSubGates().mouseAnimation,
          getHideBeforeActionEnabled: () => getChicagoSubGates().hideBeforeAction,
        })
      : createWinExecutor({
          getHideBeforeActionEnabled: () => getChicagoSubGates().hideBeforeAction,
        }),
    ensureOsPermissions: async () => {
      // Windows has no per-app TCC permission model; UAC is the boundary
      // but we don't gate on it (the executor itself checks elevation
      // and warns). Mac path retains the existing TCC checks.
      if (!isMac) {
        return { granted: true }
      }
      const cu = requireComputerUseSwift()
      const accessibility = cu.tcc.checkAccessibility()
      const screenRecording = cu.tcc.checkScreenRecording()
      return accessibility && screenRecording
        ? { granted: true }
        : { granted: false, accessibility, screenRecording }
    },
    isDisabled: () => !getChicagoEnabled(),
    getSubGates: getChicagoSubGates,
    // cleanup.ts always unhides at turn end — no user preference to disable it.
    getAutoUnhideEnabled: () => true,

    // Pixel-validation JPEG decode+crop. MUST be synchronous (the package
    // does `patch1.equals(patch2)` directly on the return value). The upstream
    // Electron app uses `nativeImage` (sync); our `image-processor-napi` is
    // sharp-compatible and async-only. Returning null → validation skipped,
    // click proceeds — the designed fallback per `PixelCompareResult.skipped`.
    // The sub-gate defaults to false anyway.
    cropRawPatch: () => null,
  }
  return cached
}
