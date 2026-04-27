/**
 * CLI `ComputerExecutor` for Windows. Thin wrapper over the cross-platform
 * `createExecutor` from computer-use-native-axiomate (nut-js for input,
 * node-screenshots for capture, apps.ts PowerShell for app management),
 * with three methods overridden to call into the Windows NAPI binding:
 *
 *   - `listInstalledApps` — registry walk via `computer-use-win-napi-axiomate`
 *     (cross-platform branch in apps.ts returns []; this surfaces the real
 *     installed-app list to `request_access`)
 *   - `appUnderPoint` — `WindowFromPoint` hit-test (click safety gate)
 *   - `findWindowDisplays` — `EnumWindows` + `MonitorFromWindow` mapping
 *
 * Stage 2 will add `screenshotWindow` (BitBlt), `prepareForAction` /
 * `previewHideSet` (`ShowWindow(SW_HIDE)`), and `getFrontmostApp` upgrade.
 *
 * No drainRunLoop / @MainActor concerns on Windows — Win32 APIs are
 * thread-safe and don't need CFRunLoop pumping.
 */

import { createExecutor } from 'computer-use-native-axiomate'
import * as winNapi from 'computer-use-win-napi-axiomate'

import type {
  ComputerExecutor,
  InstalledApp,
} from 'computer-use-mcp-axiomate'

import { logForDebugging } from '../debug.js'
import { CLI_CU_CAPABILITIES } from './common.js'

let elevationWarned = false

export function createWinExecutor(): ComputerExecutor {
  if (process.platform !== 'win32') {
    throw new Error(
      `createWinExecutor called on ${process.platform}. Windows-only.`,
    )
  }

  // Elevation diagnostic — fired once per process. Doesn't block; admin
  // mode is a legitimate run mode (e.g. dev tooling that needs it), but
  // AI clicks can interact with UAC prompts so the user should know.
  if (!elevationWarned) {
    elevationWarned = true
    if (winNapi.isAvailable() && winNapi.isRunningElevated()) {
      logForDebugging(
        '[computer-use] axiomate running elevated (admin); AI mouse/keyboard ' +
        'events can confirm UAC dialogs. Run as a normal user when possible.',
        { level: 'warn' },
      )
    }
  }

  const base = createExecutor()
  const napiAvailable = winNapi.isAvailable()

  return {
    ...base,
    capabilities: {
      ...CLI_CU_CAPABILITIES,
      platform: 'win32',
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      if (!napiAvailable) {
        // Fall through to cross-platform stub (returns []). Better than
        // crashing — request_access still works, just with empty options.
        return base.listInstalledApps()
      }
      const list = winNapi.listInstalledApps()
      return list.map(a => ({
        bundleId: a.bundleId,
        displayName: a.displayName,
        path: a.path,
      }))
    },

    async appUnderPoint(x, y) {
      if (!napiAvailable) return base.appUnderPoint(x, y)
      return winNapi.appUnderPoint(x, y)
    },

    async findWindowDisplays(bundleIds) {
      if (!napiAvailable) return base.findWindowDisplays(bundleIds)
      return winNapi.findWindowDisplays(bundleIds)
    },
  }
}
