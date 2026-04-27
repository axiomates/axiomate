/**
 * Win32 `ComputerExecutor`. Thin wrapper over the cross-platform
 * `createExecutor` from computer-use-native-axiomate (node-screenshots
 * for displays, apps.ts PowerShell for some app management), with
 * Windows-specific overrides via `computer-use-win-napi-axiomate`:
 *
 *   - `listInstalledApps` — registry walk
 *   - `appUnderPoint` — `WindowFromPoint` hit-test
 *   - `findWindowDisplays` — `EnumWindows` + `MonitorFromWindow` mapping
 *   - `getFrontmostApp` — `GetForegroundWindow` fast path
 *   - `screenshotWindow` — `PrintWindow` with `PW_RENDERFULLCONTENT`
 *   - `screenshot` / `resolvePrepareCapture` — Win32 BitBlt + Lanczos
 *     resize via `captureDisplayScaled`
 *   - `moveMouse` / `click` / `getCursorPosition` — direct Win32
 *     SetCursorPos / SendInput (replaces nut.js for mouse input)
 *
 * **Does NOT implement `prepareForAction` / `previewHideSet`.** Win's
 * model is "don't touch other apps; clicks deliver to wherever they
 * land and Win11 shell handles target activation." The hide-before-
 * action concept is macOS-specific (driven by SCContentFilter
 * compositor allowlist). Both methods are optional in the
 * `ComputerExecutor` interface — see
 * computer-use-mcp-axiomate/src/executor.ts for the divergence note.
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
    // JPEG quality 92 (was 75). At 75 the chroma subsampling + DCT
    // quantization smudges 24×24-px task bar icons enough that VL
    // models misidentify which icon is which. 92 keeps small UI
    // elements crisp; size goes up ~2.5× (~150KB → ~370KB) which is
    // still fine for token budgets.
    const r = winNapi.captureDisplayScaled(physX, physY, physW, physH, tw, th, 92)
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
      // autoTargetDisplay sub-gate is ON (the common case). On Win we
      // deliberately do NOT honor the hide loop (mac semantics): Win's
      // model is "don't touch other apps; clicks deliver to wherever they
      // land and Win11 shell handles target activation". Empty `hidden`
      // returned regardless of `opts.doHide`. See COORDINATES.md / the
      // platform-divergence note in computer-use-mcp-axiomate/executor.ts.
      const r = await captureScaledDisplay(opts.preferredDisplayId)
      if (!r) {
        return await base.resolvePrepareCapture(opts)
      }
      return {
        displayId: r.displayId ?? 0,
        base64: r.base64,
        width: r.width,
        height: r.height,
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
    // intermediate native binding.
    //
    // Coords are LOGICAL pt end-to-end. SetCursorPos / GetCursorPos in
    // a DPI-aware Bun process accept and return logical pt directly —
    // there's no DPI multiplication anywhere on the win path. Empirical
    // proof from earlier diagnostics: SetCursorPos(980, 2110) clamps to
    // (980, 1080) = logical screen y-max, not (980, 2110) physical
    // (which would have been valid since 2110 < 2160). See COORDINATES.md.

    async moveMouse(x: number, y: number): Promise<void> {
      if (!napiAvailable) return base.moveMouse(x, y)
      const actual = winNapi.moveCursor(Math.round(x), Math.round(y))
      logForDebugging(
        `[computer-use] moveMouse (win): logical=(${x},${y}) win32_actual=(${actual.x},${actual.y})`,
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
        return base.click(x, y, button, count, modifiers)
      }
      const moved = winNapi.moveCursor(Math.round(x), Math.round(y))
      logForDebugging(
        `[computer-use] click (win): logical=(${x},${y}) win32_actual=(${moved.x},${moved.y}) button=${button} count=${count}`,
        { level: 'debug' },
      )
      const buttonCode = button === 'left' ? 0 : button === 'right' ? 1 : 2
      winNapi.clickMouse(buttonCode, count)
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      if (!napiAvailable) return base.getCursorPosition()
      const phys = winNapi.getCursorPos()
      return { x: phys.x, y: phys.y }
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

    // No `prepareForAction` / `previewHideSet` overrides — Win does not
    // implement the hide-before-action model. Both methods are optional in
    // ComputerExecutor (computer-use-mcp-axiomate/executor.ts); callers
    // use `?.()` and treat undefined as "nothing to hide". Mac keeps its
    // own implementation via the cross-platform base + swift NAPI.
  }
}
