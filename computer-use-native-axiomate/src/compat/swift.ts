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

import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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

const execFileP = promisify(execFile)

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
    async captureWindow(bundleId: string): Promise<CaptureResult | null> {
      // Per-app window capture via macOS's native `screencapture -l <CGWindowID>`.
      // Two-step: AppleScript → CGWindowID, then `screencapture` CLI →
      // JPEG. Both shipped with macOS since 10.4 / 10.6, no extra binaries.
      // Returns null on non-darwin (no equivalent CLI we can rely on),
      // when the app isn't running, or when the AppleScript / capture fails.
      if (process.platform !== 'darwin') return null

      // Step 1: resolve windowID via AppleScript. Tries bundle-id match
      // first; falls back to display-name match (case-insensitive).
      // System Events' window `id` is the CGWindowID — same value
      // `screencapture -l` expects.
      const script = `
on resolveWindow(target)
  tell application "System Events"
    set procs to (every application process whose bundle identifier is target)
    if (count of procs) is 0 then
      set procs to (every application process whose name is target)
    end if
    if (count of procs) is 0 then
      -- case-insensitive name fallback
      set targetLower to do shell script "echo " & quoted form of target & " | tr '[:upper:]' '[:lower:]'"
      repeat with p in (every application process)
        set pname to do shell script "echo " & quoted form of (name of p) & " | tr '[:upper:]' '[:lower:]'"
        if pname is targetLower then
          set procs to {p}
          exit repeat
        end if
      end repeat
    end if
    if (count of procs) is 0 then return ""
    set proc to item 1 of procs
    if (count of windows of proc) is 0 then return ""
    return (id of (first window of proc)) as text
  end tell
end resolveWindow

return resolveWindow("${bundleId.replace(/"/g, '\\"')}")
`

      let windowId: number
      try {
        const { stdout } = await execFileP('osascript', ['-e', script])
        const trimmed = stdout.trim()
        if (!trimmed) return null
        const id = parseInt(trimmed, 10)
        if (isNaN(id)) return null
        windowId = id
      } catch {
        return null
      }

      // Step 2: capture that window to a temp jpeg, read + base64.
      // -l <id>: target window | -t jpg: format | -x: silent | -o: no shadow
      const tmpPath = join(tmpdir(), `axiomate-cu-window-${process.pid}-${Date.now()}.jpg`)
      try {
        await execFileP('screencapture', [
          '-l', String(windowId),
          '-t', 'jpg',
          '-x',
          '-o',
          tmpPath,
        ])
        const buf = await readFile(tmpPath)
        const base64 = buf.toString('base64')
        // We don't have a cheap pure-JS way to read JPEG dims here without
        // pulling sharp. The dispatch only needs base64 to feed the LLM —
        // width/height are advisory. Use a tiny JPEG SOF parser to get
        // exact pixel dims (works for baseline + progressive JPEGs).
        const dims = readJpegDimensions(buf)
        return {
          base64,
          width: dims?.width ?? 0,
          height: dims?.height ?? 0,
        }
      } catch {
        return null
      } finally {
        // Best-effort cleanup. Temp file leak is harmless; tmpdir is GC'd.
        unlink(tmpPath).catch(() => {})
      }
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

/**
 * Tiny baseline + progressive JPEG dimension reader. Parses SOF0/SOF1/SOF2
 * markers to extract width/height. Avoids pulling sharp just to read header
 * dims for a screenshot we already have on disk.
 *
 * Returns null on non-JPEG / truncated input. Spec: ITU-T T.81.
 */
function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  // JPEG starts with FF D8 (SOI). Each segment: FF <marker> [length(2)] [payload].
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) return null
    // Skip pad bytes (FF FF FF...).
    let marker = buf[i + 1]!
    while (marker === 0xff) {
      i++
      marker = buf[i + 1]!
    }
    // SOF0..SOF15 except DHT (C4), DAC (CC), RST (C0..C7 reserved here).
    // The frame markers carrying dimensions are 0xC0..0xC3, 0xC5..0xC7,
    // 0xC9..0xCB, 0xCD..0xCF.
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      // SOF segment: [FF Cx] [length(2)] [precision(1)] [height(2)] [width(2)] ...
      const height = buf.readUInt16BE(i + 5)
      const width = buf.readUInt16BE(i + 7)
      return { width, height }
    }
    // Standalone markers (no payload): SOI (D8), EOI (D9), TEM (01),
    // RST0..RST7 (D0..D7). Skip 2 bytes.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2
      continue
    }
    // Variable-length segment: skip past payload using its length field.
    const segLen = buf.readUInt16BE(i + 2)
    i += 2 + segLen
  }
  return null
}
