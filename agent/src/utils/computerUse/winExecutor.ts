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

  // 1080p-ish screenshot ceiling. Long edge ≤ 1920 covers 16:9 (1920×1080),
  // 16:10 (1920×1200 — slightly over short edge but cap is on long), 21:9
  // ultrawide (1920×823), 4:3 (1920×1440 — short edge over 1080 again, but
  // long-edge cap stays simple). For most desktop displays this is the
  // right size for VL token economy.
  const LONG_EDGE_CAP = 1920

  function computeImageDim(logicalW: number, logicalH: number): [number, number] {
    const longEdge = Math.max(logicalW, logicalH)
    if (longEdge <= LONG_EDGE_CAP) return [logicalW, logicalH]
    const ratio = LONG_EDGE_CAP / longEdge
    return [Math.round(logicalW * ratio), Math.round(logicalH * ratio)]
  }

  // Captures one display via the win NAPI's BitBlt + Lanczos resize +
  // JPEG pipeline. Shared between the `screenshot` (non-atomic) and
  // `resolvePrepareCapture` (atomic) overrides — they only differ in
  // whether the hide loop also runs.
  //
  // Returned ScreenshotResult.{width,height} are the IMAGE dims (≤ 1920
  // long edge); .{displayWidth,displayHeight,originX,originY} are the
  // real display logical dims. In `display_pt` coord mode scaleCoord
  // takes click coords as-is (image dim doesn't affect coord math),
  // and winExecutor.click multiplies by scaleFactor to reach physical
  // px for SetCursorPos. Single DPI conversion at the boundary; image
  // resize is purely a visual / token-budget optimization.
  async function captureScaledDisplay(displayId?: number): Promise<ScreenshotResult | null> {
    if (!napiAvailable) return null
    const display = await base.getDisplaySize(displayId)
    const physW = Math.round(display.width * display.scaleFactor)
    const physH = Math.round(display.height * display.scaleFactor)
    const physX = Math.round(display.originX * display.scaleFactor)
    const physY = Math.round(display.originY * display.scaleFactor)
    const [tw, th] = computeImageDim(display.width, display.height)
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

  // Convert scaleCoord output (logical pt) to the PHYSICAL pixel coords
  // Win32 SetCursorPos requires in a Per-Monitor V2 DPI-aware process.
  // Bun-compiled axiomate IS DPI-aware (proof: full-screen capture
  // returns 3840×2160 not 1920×1080). DPI-unaware processes can use
  // logical coords directly because the OS virtualizes the call —
  // that's why standalone Node + nut.js works but Bun-compiled fails:
  // nut.js's libnut binding doesn't know we're DPI-aware and passes
  // logical coords straight to SetCursorPos, which interprets them as
  // physical → cursor lands at half position. Going through this
  // function and the Win32 NAPI (also DPI-aware, sees physical) avoids
  // the mismatch entirely.
  async function logicalToPhysical(x: number, y: number, displayId?: number): Promise<{ x: number; y: number }> {
    const display = await base.getDisplaySize(displayId)
    return {
      x: Math.round(x * display.scaleFactor),
      y: Math.round(y * display.scaleFactor),
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
    logForDebugging(
      `[CU-HIDE] pre-hide visible apps: ${running.map(a => a.bundleId).join(', ')}`,
      { level: 'warn' },
    )
    const hidden: string[] = []
    for (const app of running) {
      if (allowSet.has(app.bundleId)) {
        logForDebugging(
          `[CU-HIDE] win hideApp SKIP (in allowlist or host-ancestor): bundleId="${app.bundleId}" displayName="${app.displayName}"`,
          { level: 'warn' },
        )
        continue
      }
      try {
        const ok = winNapi.hideApp(app.bundleId)
        logForDebugging(
          `[CU-HIDE] win hideApp bundleId="${app.bundleId}" displayName="${app.displayName}" result=${ok}`,
          { level: 'warn' },
        )
        if (ok) hidden.push(app.bundleId)
      } catch (err) {
        logForDebugging(
          `[CU-HIDE] win hideApp THREW for "${app.bundleId}": ${errorMessage(err)}`,
          { level: 'warn' },
        )
      }
    }
    const after = winNapi.listRunningApps()
    logForDebugging(
      `[CU-HIDE] post-hide visible apps: ${after.map(a => a.bundleId).join(', ')}`,
      { level: 'warn' },
    )
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

    // Win32-direct mouse input — replaces nut.js for moveMouse / click /
    // getCursorPosition. nut.js silently fails in Bun-compiled exes
    // (cursor doesn't visibly move; getPosition returns the requested
    // value, masking the failure as "delta=0 success"). Going through
    // win NAPI calls SetCursorPos / SendInput directly with no
    // intermediate native binding, and uses physical pixel coords
    // which is what DPI-aware Win32 input APIs expect.

    async moveMouse(x: number, y: number): Promise<void> {
      if (!napiAvailable) return base.moveMouse(x, y)
      const phys = await logicalToPhysical(x, y)
      const actual = winNapi.moveCursor(phys.x, phys.y)
      logForDebugging(
        `[computer-use] moveMouse (win): logical=(${x},${y}) physical=(${phys.x},${phys.y}) win32_actual=(${actual.x},${actual.y})`,
        { level: 'debug' },
      )
    },

    async click(
      x: number,
      y: number,
      button: 'left' | 'right' | 'middle',
      count: 1 | 2 | 3,
      modifiers?: string[],
    ): Promise<void> {
      if (!napiAvailable) return base.click(x, y, button, count, modifiers)
      if (modifiers && modifiers.length > 0) {
        // Modifiers still go through nut.js for now (key press/release
        // sandwich). Only the move + click parts are Win32-direct.
        // Fall back to base for the modifier path entirely so the
        // sandwich semantics stay unchanged.
        return base.click(x, y, button, count, modifiers)
      }
      const phys = await logicalToPhysical(x, y)
      const moved = winNapi.moveCursor(phys.x, phys.y)
      logForDebugging(
        `[computer-use] click (win): logical=(${x},${y}) physical=(${phys.x},${phys.y}) win32_actual=(${moved.x},${moved.y}) button=${button} count=${count}`,
        { level: 'debug' },
      )
      const buttonCode = button === 'left' ? 0 : button === 'right' ? 1 : 2
      winNapi.clickMouse(buttonCode, count)
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      // Returns LOGICAL pt for consistency with the rest of the
      // executor surface (other coord-using methods consume scaleCoord
      // output which is logical). Win32 GetCursorPos returns physical
      // px in DPI-aware processes; divide by scaleFactor.
      if (!napiAvailable) return base.getCursorPosition()
      const display = await base.getDisplaySize()
      const phys = winNapi.getCursorPos()
      return {
        x: Math.round(phys.x / display.scaleFactor),
        y: Math.round(phys.y / display.scaleFactor),
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
