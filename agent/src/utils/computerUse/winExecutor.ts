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
  RunningApp,
} from 'computer-use-mcp-axiomate'

import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { CLI_CU_CAPABILITIES } from './common.js'

let elevationWarned = false

export function createWinExecutor(opts: {
  getHideBeforeActionEnabled: () => boolean
}): ComputerExecutor {
  if (process.platform !== 'win32') {
    throw new Error(
      `createWinExecutor called on ${process.platform}. Windows-only.`,
    )
  }
  const { getHideBeforeActionEnabled } = opts

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

  // Host-ancestor detection — exe paths of every parent process up to
  // a depth limit. The actual visible terminal window owner is somewhere
  // in this chain and we don't want to guess: axiomate ← node ← bash ←
  // mintty ← ... etc. Resolved once at construction. prepareForAction
  // adds all of these to the allowlist so the hide loop never tries
  // to hide the user's terminal out from under axiomate. The
  // system-process deny-list inside Rust set_app_visibility filters
  // out ancestors that ARE deny-listed system processes (so adding
  // services.exe / svchost.exe to the allowlist is harmless).
  //
  // Mac uses a single surrogateHost (CFBundleIdentifier of the
  // detected terminal); on Windows there's no equivalent stable
  // identifier so we go broad — exempting the whole ancestor chain.
  const hostAncestorPaths = napiAvailable ? winNapi.getHostAncestorPaths() : []
  if (hostAncestorPaths.length > 0) {
    logForDebugging(
      `[computer-use] host ancestor chain (win, hide-exempt): ${hostAncestorPaths.join(' ← ')}`,
      { level: 'debug' },
    )
  }

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
      // Win NAPI returns monitor RECTs from Win32 GetMonitorInfoW.
      // In a DPI-aware process (Bun on Win10+) those rects are in
      // LOGICAL DIPs — e.g. a 4K display at 200% scale reports
      // 1920×1080 with the secondary at x=-1920. The cross-platform
      // DisplayInfo from listDisplays() already holds DIP-logical
      // origin (originX/originY) computed by node-screenshots
      // dividing raw pixels by scaleFactor. So we match DIP-against-DIP.
      if (!napiAvailable) return base.findWindowDisplays(bundleIds)
      const winInfo = winNapi.findWindowMonitorRects(bundleIds)
      const displays = await base.listDisplays()
      return winInfo.map(({ bundleId, monitorRects }) => {
        const ids = new Set<number>()
        for (const r of monitorRects) {
          for (const d of displays) {
            if (d.originX === r.x && d.originY === r.y) {
              ids.add(d.displayId)
            }
          }
        }
        return { bundleId, displayIds: [...ids] }
      })
    },

    async getFrontmostApp() {
      // Win32 GetForegroundWindow → pid → exe path. Microseconds vs
      // PowerShell shell-out's ~80ms in apps.ts. Returns null on lock
      // screen / UAC secure desktop / no foreground process.
      if (!napiAvailable) return base.getFrontmostApp()
      return winNapi.getForegroundWindow()
    },

    async screenshotWindow(bundleId: string) {
      // PrintWindow + PW_RENDERFULLCONTENT in the win NAPI. Returns a
      // structured outcome with diagnostic — same shape as mac NAPI's
      // capture_window. Non-DWM fallback to BitBlt is internal to the
      // NAPI binding. Click coordinates in subsequent tools still refer
      // to the FULL screen, never the window-cropped image — same
      // contract as mac.
      if (!napiAvailable) return base.screenshotWindow(bundleId)
      const outcome = winNapi.captureWindow(bundleId)
      logForDebugging(
        `[computer-use] capture_window outcome (win): bundleId=${bundleId} diagnostic=${outcome.diagnostic}`,
        { level: 'debug' },
      )
      const image = outcome.image
      if (!image) return null
      return {
        base64: image.base64,
        width: image.width,
        height: image.height,
        displayId: 0,
        displayWidth: image.width,
        displayHeight: image.height,
      }
    },

    async openApp(bundleIdOrName: string): Promise<void> {
      // After the bundleId-unification (commit pending): list_installed_apps
      // returns bundle_id = full exe path. So `bundleIdOrName` here is
      // either:
      //   1. A full exe path (from list_installed_apps / list_running_apps /
      //      app_under_point / find_window_displays — single namespace) —
      //      pass straight to Start-Process.
      //   2. A bare display name (rare — can only happen if upstream
      //      bypassed listInstalledApps and passed user text). Falls
      //      through to PowerShell Start-Process which uses App Paths
      //      registry resolution (chrome / firefox / etc work without
      //      paths).
      // No more registry sub-key lookup needed — that whole namespace
      // is gone.
      return base.openApp(bundleIdOrName)
    },

    async listRunningApps(): Promise<RunningApp[]> {
      // EnumWindows + dedupe by exe path — keeps the bundleId space
      // consistent with the rest of the win NAPI (hideApp /
      // findWindowDisplays expect full exe paths). Cross-platform
      // base.listRunningApps falls through to apps.ts PowerShell which
      // returns ProcessName ("chrome"), so it doesn't match what
      // hideApp / findWindowDisplays compare against.
      if (!napiAvailable) return base.listRunningApps()
      return winNapi.listRunningApps().map(a => ({
        bundleId: a.bundleId,
        displayName: a.displayName,
      }))
    },

    async prepareForAction(
      allowlistBundleIds,
      _displayId,
    ): Promise<string[]> {
      // Hide every running app whose exe path is NOT in the allowlist
      // before taking screenshot / clicks. Mirrors mac's prepareDisplay
      // hide loop. Two layers of protection prevent accidentally hiding
      // critical UI:
      //
      //   1. host-terminal exemption (this function) — adds the parent
      //      terminal exe (cmd.exe / pwsh.exe / Windows Terminal /
      //      Git Bash / VS Code integrated terminal / etc) to the
      //      allowlist so we never hide our own TTY out from under
      //      ourselves
      //   2. system-process deny-list (Rust hide_app) — even if a
      //      bundle id sneaks past the allowlist, the Rust binding
      //      hard-blocks explorer.exe / dwm.exe / sihost.exe / Win11
      //      shell hosts and returns false. This is the safety net
      //      that fixed "screen goes black, must restart explorer"
      //      reports
      if (!napiAvailable) return base.prepareForAction(allowlistBundleIds, _displayId)
      if (!getHideBeforeActionEnabled()) return []
      const allowSet = new Set(allowlistBundleIds)
      for (const ancestor of hostAncestorPaths) allowSet.add(ancestor)
      const running = winNapi.listRunningApps()
      const hidden: string[] = []
      for (const app of running) {
        if (allowSet.has(app.bundleId)) continue
        try {
          if (winNapi.hideApp(app.bundleId)) {
            hidden.push(app.bundleId)
          }
        } catch (err) {
          logForDebugging(
            `[computer-use] hide_app failed for ${app.bundleId}: ${errorMessage(err)}`,
            { level: 'warn' },
          )
        }
      }
      if (hidden.length > 0) {
        logForDebugging(
          `[computer-use] prepareForAction (win): hidden=${hidden.length} apps (deny-list system processes auto-skipped)`,
          { level: 'debug' },
        )
      }
      return hidden
    },
  }
}
