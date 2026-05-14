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
} from './nodeScreenshots.js'
import { getImageProcessor } from 'image-processor-axiomate'
import {
  listRunningApps,
  listInstalledApps,
  openApp,
  getFrontmostApp,
} from './osascriptApps.js'
import type { ComputerUseAPI } from './types.js'

// Lazy-load the optional macOS native binding. Requiring it is the only
// platform-specific syscall in this module — keep it best-effort so a
// missing binary just disables native features without breaking the build.
type MacNativeBinding = {
  isAvailable: () => boolean
  isAccessibilityTrusted?: () => boolean
  getFrontmostApp?: () => Promise<{ appIdentifier: string; displayName: string } | null>
  hideApp: (appIdentifier: string) => Promise<boolean>
  unhideApp: (appIdentifier: string) => Promise<boolean>
  activateApp: (appIdentifier: string) => Promise<boolean>
  registerEscapeHotkey: (cb: () => void) => boolean
  unregisterEscapeHotkey: () => void
  notifyExpectedEscape: () => void
  captureExcluding: (opts: {
    allowedAppIdentifiers: string[]
    displayId: number
    quality?: number
    width?: number
    height?: number
  }) => Promise<{ base64: string; width: number; height: number } | null>
  captureWindow: (
    appIdentifier: string,
  ) => Promise<{
    image: {
      base64: string
      width: number
      height: number
      originX: number
      originY: number
      displayWidth: number
      displayHeight: number
    } | null
    diagnostic: string
  }>
  findWindowDisplays: (
    appIdentifiers: string[],
  ) => Array<{ appIdentifier: string; displayIds: number[] }>
  appUnderPoint: (
    x: number,
    y: number,
  ) => { appIdentifier: string; displayName: string } | null
  contentAppUnderPoint?: (
    x: number,
    y: number,
  ) => { appIdentifier: string; displayName: string } | null
  listVisibleWindowsDetailed?: () => Promise<Array<{
    windowId: number
    appIdentifier: string
    displayName: string
    rect: { origin: { x: number; y: number }; size: { w: number; h: number } }
    layer: number
    zRank: number
  }>>
  enumerateUiElementsBulkForApp?: (
    appIdentifier: string,
  ) => Promise<{
    elements: any[]
    browserViewportBboxes: any[]
    elapsedMs: number
    truncatedByWalltime: boolean
  }>
  enumerateUiElementsBulkForMacWindow?: (
    windowId: number,
    appIdentifier: string,
  ) => Promise<{
    elements: any[]
    browserViewportBboxes: any[]
    elapsedMs: number
    truncatedByWalltime: boolean
  }>
}

let macNativeCached: MacNativeBinding | null | undefined
function loadMacNative(): MacNativeBinding | null {
  if (macNativeCached !== undefined) return macNativeCached
  // No need for `process.platform !== 'darwin'` guard: this file lives under
  // macShim/ and is only consumed by mac path code (swiftLoader.ts). The
  // mac-napi package's index.js itself checks process.platform and returns
  // null on non-darwin, so the require() below is safe everywhere.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('computer-use-mac-napi-axiomate') as MacNativeBinding
    macNativeCached = mod
  } catch {
    macNativeCached = null
  }
  return macNativeCached
}

async function maybeResizeCapture(
  capture: CaptureResult,
  width?: number,
  height?: number,
  quality?: number,
): Promise<CaptureResult> {
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    width <= 0 ||
    height <= 0 ||
    (capture.width === width && capture.height === height)
  ) {
    return capture
  }
  const sharp = await getImageProcessor()
  const input = Buffer.from(capture.base64, 'base64')
  const q = typeof quality === 'number'
    ? Math.max(1, Math.min(100, Math.round(quality * 100)))
    : 85
  const out = await sharp(input)
    .resize(width, height, { fit: 'fill' })
    .jpeg({ quality: q })
    .toBuffer()
  return {
    base64: out.toString('base64'),
    width,
    height,
  }
}

function parseDisplayCaptureArgs(args: any[]): {
  allowedAppIdentifiers: string[]
  quality?: number
  width?: number
  height?: number
  displayId?: number
} {
  return {
    allowedAppIdentifiers: Array.isArray(args[0]) ? (args[0] as string[]) : [],
    quality: typeof args[1] === 'number' ? (args[1] as number) : undefined,
    width: typeof args[2] === 'number' ? (args[2] as number) : undefined,
    height: typeof args[3] === 'number' ? (args[3] as number) : undefined,
    displayId: typeof args[4] === 'number' ? (args[4] as number) : undefined,
  }
}

function parseRegionCaptureArgs(args: any[]): {
  x: number
  y: number
  w: number
  h: number
  outW?: number
  outH?: number
  quality?: number
  displayId?: number
} {
  // Legacy/simple path: (x, y, w, h, displayId?)
  if (typeof args[0] === 'number') {
    return {
      x: args[0] as number,
      y: args[1] as number,
      w: args[2] as number,
      h: args[3] as number,
      displayId: typeof args[4] === 'number' ? (args[4] as number) : undefined,
    }
  }
  // Mac executor zoom path without explicit resize:
  // (allowedAppIdentifiers, x, y, w, h, displayId)
  if (args.length === 6) {
    return {
      x: args[1] as number,
      y: args[2] as number,
      w: args[3] as number,
      h: args[4] as number,
      displayId: typeof args[5] === 'number' ? (args[5] as number) : undefined,
    }
  }
  // Executor path: (allowedAppIdentifiers, x, y, w, h, outW, outH, quality, displayId)
  return {
    x: args[1] as number,
    y: args[2] as number,
    w: args[3] as number,
    h: args[4] as number,
    outW: typeof args[5] === 'number' ? (args[5] as number) : undefined,
    outH: typeof args[6] === 'number' ? (args[6] as number) : undefined,
    quality: typeof args[7] === 'number' ? (args[7] as number) : undefined,
    displayId: typeof args[8] === 'number' ? (args[8] as number) : undefined,
  }
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
      async getFrontmostApp(): Promise<{ appIdentifier: string; displayName: string } | null> {
        const native = loadMacNative()
        if (native?.getFrontmostApp) {
          return native.getFrontmostApp()
        }
        const app = await getFrontmostApp()
        return app ? { appIdentifier: app.appIdentifier, displayName: app.displayName } : null
      },
      async prepareDisplay(...args: any[]): Promise<any> {
        // Args from the dispatch layer (executor.ts:319):
        //   (allowedAppIdentifiers: string[], hostAppIdentifier?: string, displayId?: number, hostAppIdentifier2?: string)
        // We hide every running app NOT in the allowlist (and not the host
        // terminal). The original Swift impl also re-orders z-order so the
        // allowlisted app comes forward; we approximate by `activate`-ing
        // the first allowlisted app that's running.
        const native = loadMacNative()
        if (!native) return { hidden: [], activated: [] }
        const allowedAppIdentifiers = Array.isArray(args[0]) ? (args[0] as string[]) : []
        const hostAppIdentifier = typeof args[1] === 'string' ? (args[1] as string) : undefined
        const allowSet = new Set(allowedAppIdentifiers)
        if (hostAppIdentifier) allowSet.add(hostAppIdentifier)
        const running = await listRunningApps()
        const hidden: string[] = []
        const activated: string[] = []
        // Hide serially — NSWorkspace's runningApplications iteration shares
        // state with hide() side effects, and parallel hides can produce
        // z-order flicker (one hide reorders, the next races on the new
        // order). ~30ms × N apps; for typical N=10-30 that's <1s, dominated
        // by the AppKit ipc round-trip per app. Don't Promise.all this.
        for (const app of running) {
          if (allowSet.has(app.appIdentifier)) continue
          // hideApp resolves true if any matching running app was hidden.
          const ok = await native.hideApp(app.appIdentifier).catch(() => false)
          if (ok) hidden.push(app.appIdentifier)
        }
        // Bring the first allowlisted running app forward.
        for (const app of running) {
          if (!allowSet.has(app.appIdentifier)) continue
          if (hostAppIdentifier && app.appIdentifier === hostAppIdentifier) continue
          const ok = await native.activateApp(app.appIdentifier).catch(() => false)
          if (ok) {
            activated.push(app.appIdentifier)
            break
          }
        }
        return { hidden, activated }
      },
      async previewHideSet(...args: any[]): Promise<Array<{ appIdentifier: string; displayName: string }>> {
        // Args: (allowlistAppIdentifiers: string[], displayId?: number)
        // The displayId arg is not honored — the original mac path used
        // CGWindowListCopyWindowInfo to filter by display; this port doesn't
        // have multi-display window enumeration so we return all
        // non-allowlisted running apps. Slight over-estimate (includes apps
        // on other monitors) but the dialog's "X apps will be hidden" hint
        // is just a preview, not a contract — see the willHide field doc in
        // CuPermissionRequest.
        const allowlistAppIdentifiers = Array.isArray(args[0]) ? (args[0] as string[]) : []
        const allowSet = new Set(allowlistAppIdentifiers)
        const running = await listRunningApps()
        return running
          .filter(a => !allowSet.has(a.appIdentifier))
          .map(a => ({ appIdentifier: a.appIdentifier, displayName: a.displayName }))
      },
      async findWindowDisplays(...args: any[]): Promise<Array<{ appIdentifier: string; displayIds: number[] }>> {
        // Per-app display-id hint surfaced via request_access's
        // windowLocations field. The native binding walks
        // CGWindowListCopyWindowInfo and intersects each window's bounds
        // against CGDisplayBounds for every active display.
        // Fallback: empty list when binding missing — request_access just
        // omits the hint, single-monitor users see no difference.
        const native = loadMacNative()
        const appIdentifiers = Array.isArray(args[0]) ? (args[0] as string[]) : []
        if (!native) {
          return appIdentifiers.map(appIdentifier => ({ appIdentifier, displayIds: [] }))
        }
        return native.findWindowDisplays(appIdentifiers)
      },
      async appUnderPoint(x: number, y: number): Promise<{ appIdentifier: string; displayName: string } | null> {
        // Click safety gate hit-test. Returns the bundle id of the topmost
        // visible window at (x, y), or null when the cursor is on bare
        // desktop (or binding unavailable, in which case the gate
        // gracefully degrades — see toolCalls.ts:runHitTestGate).
        const native = loadMacNative()
        if (!native) return null
        return native.appUnderPoint(x, y)
      },
      async contentAppUnderPoint(x: number, y: number): Promise<{ appIdentifier: string; displayName: string } | null> {
        const native = loadMacNative()
        if (!native?.contentAppUnderPoint) return null
        return native.contentAppUnderPoint(x, y)
      },
      async open(appIdentifier: string): Promise<void> {
        await openApp(appIdentifier)
      },
      async unhide(...args: any[]): Promise<void> {
        // Args: (appIdentifiers: string[]) — the dispatch layer's
        // hiddenDuringTurn set, restored at turn end.
        const native = loadMacNative()
        if (!native) return
        const appIdentifiers = Array.isArray(args[0]) ? (args[0] as string[]) : []
        await Promise.allSettled(appIdentifiers.map(id => native.unhideApp(id)))
      },
    },

    display: {
      async captureExcluding(...args: any[]): Promise<any> {
        // Original signature: (appIdentifiers[], quality, w, h, displayId?).
        // When the mac native binding is loaded AND its capture_excluding
        // returns a non-null result, use it (proper compositor-level
        // filtering by the SCContentFilter). Otherwise fall back to a
        // full-screen node-screenshots capture (current cross-platform
        // behavior — the agent's MAC_CLI_CAPABILITIES.screenshotFiltering
        // is set to 'none', so the LLM is told the screenshot is
        // unfiltered).
        const {
          allowedAppIdentifiers,
          quality,
          width,
          height,
          displayId,
        } = parseDisplayCaptureArgs(args)

        const native = loadMacNative()
        if (native && typeof displayId === 'number') {
          try {
            const filtered = await native.captureExcluding({
              allowedAppIdentifiers,
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
        const capture = await captureDisplay(typeof displayId === 'number' ? displayId : undefined)
        return maybeResizeCapture(capture, width, height, quality)
      },
      async captureRegion(...args: any[]): Promise<any> {
        const { x, y, w, h, outW, outH, quality, displayId } = parseRegionCaptureArgs(args)
        const capture = await captureRegion(x, y, w, h, displayId)
        return maybeResizeCapture(capture, outW, outH, quality)
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
        const { quality, width, height, displayId } = parseDisplayCaptureArgs(args)
        const capture = await captureDisplay(typeof displayId === 'number' ? displayId : undefined)
        return maybeResizeCapture(capture, width, height, quality)
      },
      async captureRegion(...args: any[]): Promise<any> {
        const { x, y, w, h, outW, outH, quality, displayId } = parseRegionCaptureArgs(args)
        const capture = await captureRegion(x, y, w, h, displayId)
        return maybeResizeCapture(capture, outW, outH, quality)
      },
    },

    tcc: {
      checkScreenRecording(): boolean {
        // Assume permission granted on non-macOS, or that user has granted it.
        // Real screen-recording probe would need a TCC-specific check; the
        // captureExcluding call itself surfaces the failure via blank pixels.
        return true
      },
      checkAccessibility(): boolean {
        // Delegate to the mac napi's `AXIsProcessTrusted()`. Without this,
        // the previous stub always returned true and masked the real state —
        // bulk AX enumeration silently returns 0 elements when trust is
        // missing. Fall back to true only when the native binding isn't
        // available at all (non-macOS / build artifact missing), to keep
        // existing happy-path behavior unchanged.
        const native = loadMacNative()
        if (!native || !native.isAccessibilityTrusted) return true
        return native.isAccessibilityTrusted()
      },
      requestScreenRecording(): void {
        // macOS-specific TCC prompt
      },
    },

    // Top-level aliases (agent's executor.ts calls these directly)
    async captureExcluding(...args: any[]): Promise<any> {
      const { quality, width, height, displayId } = parseDisplayCaptureArgs(args)
      const capture = await captureDisplay(typeof displayId === 'number' ? displayId : undefined)
      return maybeResizeCapture(capture, width, height, quality)
    },
    async hideApp(appIdentifier: string): Promise<boolean> {
      const native = loadMacNative()
      if (!native) return false
      return native.hideApp(appIdentifier)
    },
    async unhideApp(appIdentifier: string): Promise<boolean> {
      const native = loadMacNative()
      if (!native) return false
      return native.unhideApp(appIdentifier)
    },
    async activateApp(appIdentifier: string): Promise<boolean> {
      const native = loadMacNative()
      if (!native) return false
      return native.activateApp(appIdentifier)
    },
    async captureRegion(...args: any[]): Promise<any> {
      const { x, y, w, h, outW, outH, quality, displayId } = parseRegionCaptureArgs(args)
      const capture = await captureRegion(x, y, w, h, displayId)
      return maybeResizeCapture(capture, outW, outH, quality)
    },
    async captureWindow(appIdentifier: string): Promise<{
      image: {
        base64: string
        width: number
        height: number
        originX: number
        originY: number
        displayWidth: number
        displayHeight: number
      } | null
      diagnostic: string
    }> {
      // Per-window capture via the mac NAPI binding's CGWindowListCreateImage
      // path. Always returns an outcome (image-or-null + diagnostic). The
      // diagnostic is logged on the agent side via logForDebugging, so
      // ~/.axiomate/debug/latest reveals which step failed without relying
      // on stderr eprintln (which the TUI obscures).
      const native = loadMacNative()
      if (!native) {
        return {
          image: null,
          diagnostic: 'native binding not available on this platform',
        }
      }
      return native.captureWindow(appIdentifier)
    },
    async listVisibleWindowsDetailed() {
      const native = loadMacNative()
      if (!native?.listVisibleWindowsDetailed) return []
      return native.listVisibleWindowsDetailed()
    },
    // Phase 1.5 bulk-pull AX enumeration. The mac napi binding implements
    // both; the swift shim must forward them so executor's
    // `cu.enumerateUiElementsBulk…` is non-undefined and the macExecutor
    // wrapper actually invokes native (instead of falling back to the
    // hardcoded empty BulkResult guard).
    async enumerateUiElementsBulkForApp(appIdentifier: string) {
      const native = loadMacNative()
      if (!native?.enumerateUiElementsBulkForApp) {
        return {
          elements: [],
          browserViewportBboxes: [],
          elapsedMs: 0,
          truncatedByWalltime: false,
        }
      }
      return native.enumerateUiElementsBulkForApp(appIdentifier)
    },
    async enumerateUiElementsBulkForMacWindow(windowId: number, appIdentifier: string) {
      const native = loadMacNative()
      if (!native?.enumerateUiElementsBulkForMacWindow) {
        return {
          elements: [],
          browserViewportBboxes: [],
          elapsedMs: 0,
          truncatedByWalltime: false,
        }
      }
      return native.enumerateUiElementsBulkForMacWindow(windowId, appIdentifier)
    },
    async resolvePrepareCapture(...args: any[]): Promise<any> {
      // Atomic resolve→prepare→capture path used by dispatch's autoTargetDisplay
      // gate. Original Swift impl chose a display, hid non-allowlist apps,
      // captured, and returned everything in one round-trip.
      // Args from agent executor.ts:
      //   args[0] = allowedAppIdentifiers (with terminal stripped)
      //   args[1] = surrogateHost (terminal bundle id)
      //   args[2] = quality
      //   args[3] = targetW (unused — node-screenshots returns native size)
      //   args[4] = targetH (unused)
      //   args[5] = preferredDisplayId
      //   args[6] = autoResolve (bool)
      //   args[7] = doHide (bool)
      // Returns ResolvePrepareCaptureResult: { displayId, base64, width,
      // height, hidden, displayWidth, displayHeight, originX, originY }.
      const allowedAppIdentifiers = Array.isArray(args[0])
        ? (args[0] as string[])
        : []
      const hostAppIdentifier =
        typeof args[1] === 'string' ? (args[1] as string) : undefined
      const preferredDisplayId =
        typeof args[5] === 'number' ? (args[5] as number) : undefined
      const doHide = args[7] === true

      const display = getDisplaySize(preferredDisplayId)
      const displayId = display.displayId

      // Hide non-allowlisted apps via native binding (when available + doHide
      // + the user actually allowlisted some apps). When allowedAppIdentifiers is
      // empty, treat the screenshot as "no restriction" — capture full-screen
      // without hiding anything (pre-21097da behavior; matches the dispatch's
      // bypass of auto-trigger on `screenshotFiltering: 'none'`). Falls
      // through to no-hide on non-darwin or when binding missing.
      const hidden: string[] = []
      const native = loadMacNative()
      if (doHide && native && allowedAppIdentifiers.length > 0) {
        const allowSet = new Set(allowedAppIdentifiers)
        if (hostAppIdentifier) allowSet.add(hostAppIdentifier)
        const running = await listRunningApps()
        for (const app of running) {
          if (allowSet.has(app.appIdentifier)) continue
          const ok = await native.hideApp(app.appIdentifier).catch(() => false)
          if (ok) hidden.push(app.appIdentifier)
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
