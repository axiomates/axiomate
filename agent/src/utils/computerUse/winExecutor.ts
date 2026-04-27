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
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
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

  // Captures one display via the win NAPI's BitBlt + Lanczos resize +
  // JPEG pipeline. Shared between the `screenshot` (non-atomic) and
  // `resolvePrepareCapture` (atomic) overrides — both need the dim-
  // matching trick, the only difference between them is whether they
  // also run the hide loop. Returns null on NAPI failure → caller
  // falls back to base.{screenshot, resolvePrepareCapture}.
  //
  // Resize target = display LOGICAL dims (1920×1080 for 4K @ 200%),
  // not the API token-budget output of `targetImageSize`. Reason:
  // observed Qwen-VL3.6 (and likely other non-Anthropic VLMs) emit
  // click coords in *display logical pt* space regardless of the
  // image dims they were shown — `(603, 986)` on a 1920×1080 screen
  // is consistent across multiple click attempts even when the image
  // was 1456×819. Making the image dim equal to display dim turns
  // scaleCoord (image_px → display_pt via `displayWidth/imageWidth`)
  // into an identity transform, so whichever coord convention the
  // model uses (image-px OR display-pt — they coincide) clicks land
  // correctly. Mac path keeps `targetImageSize` because the NAPI
  // pipeline there has its own resize and Anthropic users on mac
  // do follow the image-px convention; we don't flip mac until
  // mac's behavior is verified with the same Qwen model.
  async function captureScaledDisplay(displayId?: number): Promise<ScreenshotResult | null> {
    if (!napiAvailable) return null
    const display = await base.getDisplaySize(displayId)
    const physW = Math.round(display.width * display.scaleFactor)
    const physH = Math.round(display.height * display.scaleFactor)
    const physX = Math.round(display.originX * display.scaleFactor)
    const physY = Math.round(display.originY * display.scaleFactor)
    const tw = display.width
    const th = display.height
    const r = winNapi.captureDisplayScaled(physX, physY, physW, physH, tw, th, 75)
    if (!r) {
      logForDebugging(
        `[computer-use] captureDisplayScaled returned null (physX=${physX} physY=${physY} physW=${physW} physH=${physH} tw=${tw} th=${th})`,
        { level: 'warn' },
      )
      return null
    }
    return {
      base64: r.base64,
      width: r.width,
      height: r.height,
      displayId: display.displayId,
      displayWidth: display.width,
      displayHeight: display.height,
      originX: display.originX,
      originY: display.originY,
    }
  }

  // Hide every running app whose exe path isn't in the allowlist.
  // Shared between `prepareForAction` (non-atomic path) and
  // `resolvePrepareCapture` (atomic path). Caller decides whether to
  // call this (i.e. checks getHideBeforeActionEnabled).
  function runHideLoop(allowlistBundleIds: string[]): string[] {
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
        `[computer-use] runHideLoop (win): hidden=${hidden.length} apps (deny-list system processes auto-skipped)`,
        { level: 'debug' },
      )
    }
    return hidden
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

    async screenshot(opts: {
      allowedBundleIds: string[]
      displayId?: number
    }): Promise<ScreenshotResult> {
      // Non-atomic path — toolCalls.ts handleScreenshot calls this when
      // autoTargetDisplay sub-gate is OFF. Hide loop (if enabled) runs
      // separately via prepareForAction; here we only do the capture.
      const r = await captureScaledDisplay(opts.displayId)
      if (!r) return base.screenshot(opts)
      return r
    },

    async resolvePrepareCapture(opts: {
      allowedBundleIds: string[]
      preferredDisplayId?: number
      autoResolve: boolean
      doHide?: boolean
    }): Promise<ResolvePrepareCaptureResult> {
      // Atomic path — toolCalls.ts handleScreenshot calls this when
      // autoTargetDisplay sub-gate is ON (the common case). Combines the
      // hide loop AND the capture in one logical call. The mac swift NAPI
      // does this atomically inside a single CGScreen pump; on win we run
      // them sequentially in TS, same observable effect.
      //
      // Critical for click correctness: this MUST do the same Lanczos
      // resize the non-atomic screenshot does, otherwise the atomic-path
      // user sees raw 3840×2160 dims while the API server resizes to 1568,
      // and scaleCoord uses the wrong denominator. The original cross-
      // platform impl in computer-use-native-axiomate skipped both the
      // hide AND the resize, which is what was breaking win clicks.
      const hidden = opts.doHide && getHideBeforeActionEnabled() && napiAvailable
        ? runHideLoop(opts.allowedBundleIds)
        : []
      const r = await captureScaledDisplay(opts.preferredDisplayId)
      if (!r) {
        const fallback = await base.resolvePrepareCapture(opts)
        return { ...fallback, hidden }
      }
      return {
        displayId: r.displayId ?? 0,
        base64: r.base64,
        width: r.width,
        height: r.height,
        hidden,
        displayWidth: r.displayWidth,
        displayHeight: r.displayHeight,
        originX: r.originX,
        originY: r.originY,
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
      // before taking screenshot / clicks. Two layers of protection
      // prevent accidentally hiding critical UI:
      //
      //   1. host-terminal exemption (runHideLoop) — adds the parent
      //      terminal exe (cmd.exe / pwsh.exe / Windows Terminal /
      //      Git Bash / VS Code integrated terminal / etc) to the
      //      allowlist so we never hide our own TTY
      //   2. system-process deny-list (Rust hide_app) — hard-blocks
      //      explorer.exe / dwm.exe / sihost.exe / Win11 shell hosts.
      //      Safety net for "screen goes black" mode.
      if (!napiAvailable) return base.prepareForAction(allowlistBundleIds, _displayId)
      if (!getHideBeforeActionEnabled()) return []
      return runHideLoop(allowlistBundleIds)
    },
  }
}
