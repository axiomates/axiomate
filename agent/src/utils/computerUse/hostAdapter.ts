import type {
  ComputerUseHostAdapter,
  Logger,
} from 'computer-use-mcp-axiomate'
import { format } from 'util'
import { logForDebugging } from '../debug.js'
import { getGlobalConfig } from '../config.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { createCliExecutor } from './macExecutor.js'
import { createWinExecutor } from './winExecutor.js'
import { getChicagoEnabled, getChicagoSubGates } from './gates.js'
import { requireComputerUseSwift } from './swiftLoader.js'
import { getMainLoopModel } from '../model/model.js'

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
  cached = {
    serverName: COMPUTER_USE_MCP_SERVER_NAME,
    logger: new DebugLogger(),
    executor: isMac
      ? createCliExecutor({
          getMouseAnimationEnabled: () => getChicagoSubGates().mouseAnimation,
          getHideBeforeActionEnabled: () => getChicagoSubGates().hideBeforeAction,
        })
      : createWinExecutor(),
    ensureOsPermissions: async () => {
      // Windows has no per-app TCC permission model; UAC is the boundary
      // but we don't gate on it (the executor itself checks elevation
      // and warns). Mac path retains the existing TCC checks.
      if (!isMac) {
        return { platform: 'win32', granted: true }
      }
      const cu = requireComputerUseSwift()
      const accessibility = cu.tcc.checkAccessibility()
      const screenRecording = cu.tcc.checkScreenRecording()
      return {
        platform: 'darwin',
        granted: accessibility && screenRecording,
        accessibility,
        screenRecording,
      }
    },
    isDisabled: () => !getChicagoEnabled(),
    isVisionLocateEnabled: () => getGlobalConfig().visionLocateEnabled === true,
    currentModelSupportsImages: () => {
      try {
        const model = getMainLoopModel()
        return getGlobalConfig().models?.[model]?.supportsImages !== false
      } catch {
        return true
      }
    },
    getSubGates: getChicagoSubGates,
    // cleanup.ts always unhides at turn end — no user preference to disable it.
    getAutoUnhideEnabled: () => true,



  }
  return cached
}
