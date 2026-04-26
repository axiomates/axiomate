/**
 * Compatibility layer: wraps our cross-platform screenshot/apps functions
 * into the @ant/computer-use-swift interface that agent code expects.
 *
 * Agent loads this via: require('computer-use-native-axiomate') as ComputerUseAPI
 * The original is a macOS-only Swift NAPI module. We provide cross-platform
 * equivalents where possible.
 *
 * On macOS, when the optional `computer-use-mac-napi-axiomate` native module
 * loads successfully, methods that need real Quartz / AppKit / ScreenCaptureKit
 * APIs (hide / unhide / activate / Esc hotkey / SCContentFilter screenshot)
 * route through the native binding. When the module isn't installed (debug
 * builds, missing Accessibility perms, etc.), each method falls back to its
 * cross-platform behavior (no-op for hide-style methods, full-screen capture
 * for SCContentFilter screenshots).
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

// Lazy-load the optional macOS native binding. Requiring it is the only
// platform-specific syscall in this module — keep it best-effort so a
// missing binary just disables native features without breaking the build.
type MacNativeBinding = {
  isAvailable: () => boolean
  hideApp: (bundleId: string) => Promise<boolean>
  unhideApp: (bundleId: string) => Promise<boolean>
  activateApp: (bundleId: string) => Promise<boolean>
  registerEscapeHotkey: (cb: () => void) => boolean
  unregisterEscapeHotkey: () => void
  notifyExpectedEscape: () => void
  captureExcluding: (opts: {
    allowedBundleIds: string[]
    displayId: number
    quality?: number
    width?: number
    height?: number
  }) => Promise<{ base64: string; width: number; height: number } | null>
}

let macNativeCached: MacNativeBinding | null | undefined
function loadMacNative(): MacNativeBinding | null {
  if (macNativeCached !== undefined) return macNativeCached
  if (process.platform !== 'darwin') {
    macNativeCached = null
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('computer-use-mac-napi-axiomate') as MacNativeBinding
    macNativeCached = mod.isAvailable() ? mod : null
  } catch {
    macNativeCached = null
  }
  return macNativeCached
}

export function createComputerUseSwift(): ComputerUseAPI {
  return {
    hotkey: {
      register(_callback: () => void): void {
        // Generic hotkey registration not exposed by the binding —
        // CGEventTap variant is registerEscape below.
      },
      registerEscape(callback: () => void): any {
        const native = loadMacNative()
        if (!native) return false
        return native.registerEscapeHotkey(callback)
      },
      unregister(): void {
        const native = loadMacNative()
        if (native) native.unregisterEscapeHotkey()
      },
      notifyExpectedEscape(): void {
        const native = loadMacNative()
        if (native) native.notifyExpectedEscape()
      },
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
      async prepareDisplay(...args: any[]): Promise<any> {
        // Args from the dispatch layer (executor.ts:319):
        //   (allowedBundleIds: string[], hostBundleId?: string, displayId?: number, hostBundleId2?: string)
        // We hide every running app NOT in the allowlist (and not the host
        // terminal). The original Swift impl also re-orders z-order so the
        // allowlisted app comes forward; we approximate by `activate`-ing
        // the first allowlisted app that's running.
        const native = loadMacNative()
        if (!native) return { hidden: [], activated: [] }
        const allowedBundleIds = Array.isArray(args[0]) ? (args[0] as string[]) : []
        const hostBundleId = typeof args[1] === 'string' ? (args[1] as string) : undefined
        const allowSet = new Set(allowedBundleIds)
        if (hostBundleId) allowSet.add(hostBundleId)
        const running = await listRunningApps()
        const hidden: string[] = []
        const activated: string[] = []
        // Hide serially — NSWorkspace's runningApplications iteration shares
        // state with hide() side effects, and parallel hides can produce
        // z-order flicker (one hide reorders, the next races on the new
        // order). ~30ms × N apps; for typical N=10-30 that's <1s, dominated
        // by the AppKit ipc round-trip per app. Don't Promise.all this.
        for (const app of running) {
          if (allowSet.has(app.bundleId)) continue
          // hideApp resolves true if any matching running app was hidden.
          const ok = await native.hideApp(app.bundleId).catch(() => false)
          if (ok) hidden.push(app.bundleId)
        }
        // Bring the first allowlisted running app forward.
        for (const app of running) {
          if (!allowSet.has(app.bundleId)) continue
          if (hostBundleId && app.bundleId === hostBundleId) continue
          const ok = await native.activateApp(app.bundleId).catch(() => false)
          if (ok) {
            activated.push(app.bundleId)
            break
          }
        }
        return { hidden, activated }
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
      async unhide(...args: any[]): Promise<void> {
        // Args: (bundleIds: string[]) — the dispatch layer's
        // hiddenDuringTurn set, restored at turn end.
        const native = loadMacNative()
        if (!native) return
        const bundleIds = Array.isArray(args[0]) ? (args[0] as string[]) : []
        await Promise.allSettled(bundleIds.map(id => native.unhideApp(id)))
      },
    },

    display: {
      async captureExcluding(...args: any[]): Promise<any> {
        // Original signature: (bundleIds[], quality, w, h, displayId?).
        // When the mac native binding is loaded AND its capture_excluding
        // returns a non-null result, use it (proper compositor-level
        // filtering by the SCContentFilter). Otherwise fall back to a
        // full-screen node-screenshots capture (current cross-platform
        // behavior — the agent's CLI_CU_CAPABILITIES.screenshotFiltering
        // is set to 'none', so the LLM is told the screenshot is
        // unfiltered).
        const allowedBundleIds = Array.isArray(args[0]) ? (args[0] as string[]) : []
        const quality = typeof args[1] === 'number' ? (args[1] as number) : undefined
        const width = typeof args[2] === 'number' ? (args[2] as number) : undefined
        const height = typeof args[3] === 'number' ? (args[3] as number) : undefined
        const displayId = typeof args[4] === 'number' ? (args[4] as number) : undefined

        const native = loadMacNative()
        if (native && typeof displayId === 'number') {
          try {
            const filtered = await native.captureExcluding({
              allowedBundleIds,
              displayId,
              quality,
              width,
              height,
            })
            if (filtered) return filtered
          } catch {
            // fall through to node-screenshots full-screen capture
          }
        }
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
    async resolvePrepareCapture(...args: any[]): Promise<any> {
      // Atomic resolve→prepare→capture path used by dispatch's autoTargetDisplay
      // gate. Original Swift impl chose a display, hid non-allowlist apps,
      // captured, and returned everything in one round-trip.
      // Args from agent executor.ts:
      //   args[0] = allowedBundleIds (with terminal stripped)
      //   args[1] = surrogateHost (terminal bundle id)
      //   args[2] = quality
      //   args[3] = targetW (unused — node-screenshots returns native size)
      //   args[4] = targetH (unused)
      //   args[5] = preferredDisplayId
      //   args[6] = autoResolve (bool)
      //   args[7] = doHide (bool)
      // Returns ResolvePrepareCaptureResult: { displayId, base64, width,
      // height, hidden, displayWidth, displayHeight, originX, originY }.
      const allowedBundleIds = Array.isArray(args[0])
        ? (args[0] as string[])
        : []
      const hostBundleId =
        typeof args[1] === 'string' ? (args[1] as string) : undefined
      const preferredDisplayId =
        typeof args[5] === 'number' ? (args[5] as number) : undefined
      const doHide = args[7] === true

      const display = getDisplaySize(preferredDisplayId)
      const displayId = display.displayId

      // Hide non-allowlisted apps via native binding (when available + doHide
      // + the user actually allowlisted some apps). When allowedBundleIds is
      // empty, treat the screenshot as "no restriction" — capture full-screen
      // without hiding anything (pre-21097da behavior; matches the dispatch's
      // bypass of auto-trigger on `screenshotFiltering: 'none'`). Falls
      // through to no-hide on non-darwin or when binding missing.
      const hidden: string[] = []
      const native = loadMacNative()
      if (doHide && native && allowedBundleIds.length > 0) {
        const allowSet = new Set(allowedBundleIds)
        if (hostBundleId) allowSet.add(hostBundleId)
        const running = await listRunningApps()
        for (const app of running) {
          if (allowSet.has(app.bundleId)) continue
          const ok = await native.hideApp(app.bundleId).catch(() => false)
          if (ok) hidden.push(app.bundleId)
        }
      }

      const capture = await captureDisplay(displayId)

      return {
        displayId,
        base64: capture.base64,
        width: capture.width,
        height: capture.height,
        hidden,
        displayWidth: display.width,
        displayHeight: display.height,
        originX: display.originX,
        originY: display.originY,
      }
    },
    _drainMainRunLoop(): void {
      // macOS-specific: pump CFRunLoop main queue for Swift async
      // No equivalent needed on other platforms
    },
  }
}
