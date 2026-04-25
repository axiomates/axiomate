/**
 * Compatibility layer: wraps our cross-platform screenshot/apps functions
 * into the @ant/computer-use-swift interface that agent code expects.
 *
 * Agent loads this via: require('computer-use-native-axiomate') as ComputerUseAPI
 * The original is a macOS-only Swift NAPI module. We provide cross-platform
 * equivalents where possible and no-ops for macOS-specific features.
 */

import {
  listDisplays,
  getDisplaySize,
  captureDisplay,
  captureRegion,
  type DisplayInfo,
  type CaptureResult,
} from '../screenshot.js'
import {
  listRunningApps,
  listInstalledApps,
  openApp,
  getFrontmostApp,
} from '../platforms/apps.js'
import type { ComputerUseAPI } from '../index.js'

export function createComputerUseSwift(): ComputerUseAPI {
  return {
    hotkey: {
      register(_callback: () => void): void {
        // macOS CGEventTap — no cross-platform equivalent
      },
      registerEscape(_callback: () => void): any {
        // macOS-specific escape key monitoring
        return false
      },
      unregister(): void {},
      notifyExpectedEscape(): void {},
    },

    apps: {
      async listInstalled(): Promise<any[]> {
        return listInstalledApps()
      },
      async listRunning(): Promise<any[]> {
        return listRunningApps()
      },
      async getFrontmostApp(): Promise<{ bundleId: string; displayName: string } | null> {
        const app = await getFrontmostApp()
        return app ? { bundleId: app.bundleId, displayName: app.displayName } : null
      },
      async prepareDisplay(..._args: any[]): Promise<any> {
        // macOS-specific: hide/activate apps before screenshot
        return { hidden: [], activated: [] }
      },
      async previewHideSet(...args: any[]): Promise<Array<{ bundleId: string; displayName: string }>> {
        // Args: (allowlistBundleIds: string[], displayId?: number)
        // The displayId arg is not honored — the original mac path used
        // CGWindowListCopyWindowInfo to filter by display; this port doesn't
        // have multi-display window enumeration so we return all
        // non-allowlisted running apps. Slight over-estimate (includes apps
        // on other monitors) but the dialog's "X apps will be hidden" hint
        // is just a preview, not a contract — see the willHide field doc in
        // CuPermissionRequest.
        const allowlistBundleIds = Array.isArray(args[0]) ? (args[0] as string[]) : []
        const allowSet = new Set(allowlistBundleIds)
        const running = await listRunningApps()
        return running
          .filter(a => !allowSet.has(a.bundleId))
          .map(a => ({ bundleId: a.bundleId, displayName: a.displayName }))
      },
      async findWindowDisplays(..._args: any[]): Promise<Array<{ bundleId: string; displayIds: number[] }>> {
        // Returns which display IDs each granted app has windows on.
        // Surfaced only in the request_access response's `windowLocations`
        // field — the consumer (toolCalls.ts:buildWindowLocations) tolerates
        // empty / failure. Single-monitor users see no difference; multi-
        // monitor users miss a hint but can still call `switch_display`.
        // The mac native impl needs CGWindowListCopyWindowInfo to map each
        // window's bounds to a display ID; AppleScript can iterate windows
        // but reports app-relative coordinates that are awkward to project
        // onto display space without the Quartz API. Deferred to native
        // binding (Path 2).
        return []
      },
      async appUnderPoint(_x: number, _y: number): Promise<{ bundleId: string; displayName: string } | null> {
        // Hit-test the topmost window at the given (x, y). When non-null and
        // the bundle is not in the allowlist, the click is rejected — a
        // safety gate that catches the case where a non-allowlisted overlay
        // (toast, notification panel) sits above the allowlisted app's
        // surface. The frontmost check already ran; this catches the gap.
        // Returning null disables the gate (caller's docstring at
        // toolCalls.ts:runHitTestGate documents this fallback).
        // Mac native impl needs CGWindowListCopyWindowInfo to walk windows
        // top-down at the point. Deferred to native binding (Path 2).
        return null
      },
      async iconDataUrl(_bundleId: string): Promise<string | null> {
        // Intentionally null: ComputerUseAppListPanel renders apps with
        // figures.circle / figures.tick text glyphs, not actual icons.
        // dispatch awaits getAppIcon() per app when building the dialog
        // payload — implementing this with `sips`/`qlmanage` would add
        // ~100ms × N latency to dialog show with zero visual change.
        // Keep null until the renderer actually paints icons.
        return null
      },
      async open(bundleId: string): Promise<void> {
        await openApp(bundleId)
      },
      async unhide(..._args: any[]): Promise<void> {
        // macOS-specific: NSRunningApplication.unhide
      },
    },

    display: {
      async captureExcluding(...args: any[]): Promise<any> {
        // Original takes (bundleIds[], quality, w, h, displayId?)
        // We ignore bundle filtering and quality, just capture the display.
        // Return the {base64, width, height} object — toolCalls.ts reads
        // shot.base64 to compute decodedByteLength. Returning a raw Buffer
        // here makes shot.base64 undefined → "endsWith of undefined" crash.
        const displayId = args[4] ?? args[0]
        return captureDisplay(typeof displayId === 'number' ? displayId : undefined)
      },
      async captureRegion(...args: any[]): Promise<any> {
        const [x, y, w, h] = args
        return captureRegion(x, y, w, h)
      },
      getSize(displayId?: number): any {
        return getDisplaySize(displayId)
      },
      listAll(): any {
        return listDisplays()
      },
    },

    screenshot: {
      async capture(...args: any[]): Promise<any> {
        const displayId = args[0]
        return captureDisplay(typeof displayId === 'number' ? displayId : undefined)
      },
      async captureExcluding(...args: any[]): Promise<any> {
        const displayId = args[4] ?? undefined
        return captureDisplay(typeof displayId === 'number' ? displayId : undefined)
      },
      async captureRegion(...args: any[]): Promise<any> {
        const [x, y, w, h] = args
        return captureRegion(x, y, w, h)
      },
    },

    tcc: {
      checkScreenRecording(): boolean {
        // Assume permission granted on non-macOS, or that user has granted it
        return true
      },
      checkAccessibility(): boolean {
        return true
      },
      requestScreenRecording(): void {
        // macOS-specific TCC prompt
      },
    },

    // Top-level aliases (agent's executor.ts calls these directly)
    async captureExcluding(...args: any[]): Promise<any> {
      const displayId = args[4] ?? undefined
      return captureDisplay(typeof displayId === 'number' ? displayId : undefined)
    },
    async captureRegion(...args: any[]): Promise<any> {
      const [x, y, w, h] = args
      return captureRegion(x, y, w, h)
    },
    async resolvePrepareCapture(..._args: any[]): Promise<any> {
      // macOS-specific display preparation
      return {}
    },
    _drainMainRunLoop(): void {
      // macOS-specific: pump CFRunLoop main queue for Swift async
      // No equivalent needed on other platforms
    },
  }
}
