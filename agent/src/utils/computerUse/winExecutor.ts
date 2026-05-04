/**
 * Win32 `ComputerExecutor`. Pure Win path — composes `computer-use-win-napi-axiomate`
 * (Rust NAPI: registry walk, WindowFromPoint, BitBlt+Lanczos screenshot,
 * SetCursorPos / SendInput input, WH_KEYBOARD_LL ESC hook) with
 * `winFallbacks.ts` (node-screenshots for display geometry, PowerShell for
 * frontmost / openApp / clipboard write).
 *
 *   - `listInstalledApps` — registry walk (NAPI)
 *   - `appUnderPoint` — `WindowFromPoint` hit-test (NAPI)
 *   - `findWindowDisplays` — `EnumWindows` + `MonitorFromWindow` mapping (NAPI)
 *   - `getFrontmostApp` — `GetForegroundWindow` fast path (NAPI), PowerShell fallback
 *   - `screenshotWindow` — `PrintWindow` with `PW_RENDERFULLCONTENT` (NAPI)
 *   - `screenshot` / `resolvePrepareCapture` — Win32 BitBlt + Lanczos
 *     resize via `captureDisplayScaled` (NAPI), node-screenshots fallback
 *   - `moveMouse` / `click` / `getCursorPosition` — direct Win32
 *     SetCursorPos / SendInput (NAPI). NO fallback — Win NAPI is REQUIRED
 *     for input. The historical fallback was nut.js, which silent-fails in
 *     Bun-compiled exes (commit 0b63760 introduced direct SendInput
 *     specifically for that reason). Throwing on missing NAPI surfaces the
 *     real cause instead of the false "input degraded" appearance.
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
 *
 * Phase D1 (commit pending): dropped `createExecutor` from
 * `computer-use-native-axiomate` — Win path no longer transits that
 * package. `winFallbacks.ts` owns the non-NAPI primitives directly.
 */

import * as winNapi from 'computer-use-win-napi-axiomate'

import type {
  ComputerExecutor,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from 'computer-use-mcp-axiomate'

import { dumpScreenshotForDebug, logForDebugging } from '../debug.js'
import { WIN_CLI_CAPABILITIES } from './common.js'
import { notifyExpectedEscape } from './escHotkey.js'
import {
  getWinDisplaySize,
  listWinDisplays,
  winFallbackGetFrontmostApp,
  winFallbackListRunningApps,
  winFallbackReadClipboard,
  winFallbackResolvePrepareCapture,
  winFallbackScreenshot,
  winFallbackWriteClipboard,
  winInlineOpenApp,
  winListStartMenuApps,
  scoreAppIdSubstringMatch,
} from './winFallbacks.js'

function inputUnavailable(method: string): never {
  throw new Error(
    `Win NAPI not available for ${method} — input requires Win32 SendInput. ` +
      `Check loadError via computer-use-win-napi-axiomate.getLoadError(). ` +
      `(Historical nut.js fallback was dropped: silent-fails in Bun-compiled exes.)`,
  )
}

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

  const napiAvailable = winNapi.isAvailable()

  // 1080p-ish screenshot ceiling. Long edge ≤ 1920 covers 16:9 (1920×1080),
  // 16:10 (1920×1200 — slightly over short edge but cap is on long), 21:9
  // ultrawide (1920×823), 4:3 (1920×1440 — short edge over 1080 again, but
  // long-edge cap stays simple). For most desktop displays this is the
  // right size for VL token economy.
  const LONG_EDGE_CAP = 1920

  function computeImageDim(w: number, h: number): [number, number] {
    const longEdge = Math.max(w, h)
    if (longEdge <= LONG_EDGE_CAP) return [w, h]
    const ratio = LONG_EDGE_CAP / longEdge
    return [Math.round(w * ratio), Math.round(h * ratio)]
  }

  // Captures one display via the win NAPI's BitBlt + Lanczos resize +
  // JPEG pipeline. Shared between the `screenshot` (non-atomic) and
  // `resolvePrepareCapture` (atomic) overrides — they only differ in
  // whether the hide loop also runs.
  //
  // Returned ScreenshotResult.{width,height} are the IMAGE dims (≤ 1920
  // long edge); .{displayWidth,displayHeight,originX,originY} are the
  // display's physical-pixel dims (virtual-screen space). Under
  // Per-Monitor V2 DPI awareness, all coords — including scaleCoord
  // output, click targets, and cursor positions — are in physical px.
  // Image resize is purely a visual / token-budget optimization.
  async function captureScaledDisplay(displayId?: number, gridMode?: number): Promise<ScreenshotResult | null> {
    if (!napiAvailable) return null
    const display = getWinDisplaySize(displayId)
    const [tw, th] = computeImageDim(display.width, display.height)
    // JPEG quality 92 (was 75). At 75 the chroma subsampling + DCT
    // quantization smudges 24×24-px task bar icons enough that VL
    // models misidentify which icon is which. 92 keeps small UI
    // elements crisp; size goes up ~2.5× (~150KB → ~370KB) which is
    // still fine for token budgets.
    const r = winNapi.captureDisplayScaled(
      { origin: { x: display.originX, y: display.originY }, size: { w: display.width, h: display.height } },
      tw, th, 92, gridMode,
    )
    if (!r) {
      logForDebugging(
        `[computer-use] captureDisplayScaled returned null (x=${display.originX} y=${display.originY} w=${display.width} h=${display.height} tw=${tw} th=${th})`,
        { level: 'warn' },
      )
      return null
    }
    // Debug aux: dump JPEG to ~/.axiomate/debug/screenshots/screenshot-latest.jpg
    // so user can visually inspect what AI saw (cursor position, UI state).
    // Best-effort, never breaks the screenshot return path.
    dumpScreenshotForDebug('screenshot', r.base64)
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

  // ── Keyboard mapping ───────────────────────────────────────────────────
  // String key name → Win32 VK code. Lowercased keys match
  // case-insensitively. `extended` flag for the few keys that need
  // KEYEVENTF_EXTENDEDKEY in SendInput (arrows, INS/DEL, navigation
  // cluster, right-side modifiers, numpad-vs-mainrow distinctions).
  // Most keys don't need it — the table below sets it true for the
  // canonical extended set per Win32 keyboard.h.
  type VkInfo = { vk: number; extended: boolean }
  const VK_MAP: Record<string, VkInfo> = (() => {
    const m: Record<string, VkInfo> = {}
    const plain = (vk: number): VkInfo => ({ vk, extended: false })
    const ext = (vk: number): VkInfo => ({ vk, extended: true })
    // Modifiers
    m.ctrl = m.control = plain(0x11)        // VK_CONTROL
    m.alt = m.option = plain(0x12)          // VK_MENU
    m.shift = plain(0x10)                   // VK_SHIFT
    m.win = m.cmd = m.meta = m.super = plain(0x5B) // VK_LWIN
    // Letters a-z
    for (let c = 0; c < 26; c++) m[String.fromCharCode(97 + c)] = plain(0x41 + c)
    // Digits 0-9 (main row)
    for (let d = 0; d < 10; d++) m[String(d)] = plain(0x30 + d)
    // F1-F24
    for (let f = 1; f <= 24; f++) m['f' + f] = plain(0x70 + f - 1)
    // Special non-extended
    m.return = m.enter = plain(0x0D)        // VK_RETURN
    m.escape = m.esc = plain(0x1B)
    m.space = plain(0x20)
    m.tab = plain(0x09)
    m.backspace = plain(0x08)
    m.capslock = plain(0x14)
    m.numlock = ext(0x90)                   // VK_NUMLOCK is extended
    m.scrolllock = plain(0x91)
    m.printscreen = ext(0x2C)               // VK_SNAPSHOT is extended
    m.pause = plain(0x13)
    // Extended (arrows, nav cluster, ins/del)
    m.up = ext(0x26)
    m.down = ext(0x28)
    m.left = ext(0x25)
    m.right = ext(0x27)
    m.home = ext(0x24)
    m.end = ext(0x23)
    m.pageup = ext(0x21)
    m.pagedown = ext(0x22)
    m.insert = ext(0x2D)
    m.delete = ext(0x2E)
    return m
  })()

  function parseKeyName(name: string): VkInfo {
    const k = name.trim().toLowerCase()
    const info = VK_MAP[k]
    if (!info) {
      throw new Error(`Unknown key name: "${name}". Supported: modifiers (ctrl/alt/shift/win), letters a-z, digits 0-9, F1-F24, enter/escape/space/tab/backspace/up/down/left/right/home/end/pageup/pagedown/insert/delete/etc.`)
    }
    return info
  }

  /** Parse "ctrl+shift+a" or "win" into {modifiers, key, extended}. Last
   *  token is the main key; preceding tokens are modifiers. */
  function parseKeySeq(seq: string): { mods: number[]; key: number; keyExtended: boolean } {
    const tokens = seq.split('+').map(s => s.trim()).filter(Boolean)
    if (tokens.length === 0) {
      throw new Error('Empty key sequence')
    }
    const mods = tokens.slice(0, -1).map(t => parseKeyName(t).vk)
    const lastInfo = parseKeyName(tokens[tokens.length - 1]!)
    return { mods, key: lastInfo.vk, keyExtended: lastInfo.extended }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }

  /**
   * Ease-out-cubic animated cursor movement via Win32 SendInput. Mirrors
   * the mac executor's `animatedMove` (nut.js → enigo) but calls
   * winNapi.moveCursor directly. 60 fps, distance-proportional at
   * 2000 px/sec, capped at 0.5 s. Falls through to a single moveCursor
   * when distance is too short for meaningful animation.
   *
   * Only used from `drag` for the press→to trajectory — intermediate
   * positions generate `.leftMouseDragged` events that target apps
   * rely on (scrollbars, window resize, file-list selection, etc.).
   */
  async function animatedMoveCursor(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Promise<void> {
    const deltaX = toX - fromX
    const deltaY = toY - fromY
    const distance = Math.hypot(deltaX, deltaY)
    if (distance < 1) return
    const durationSec = Math.min(distance / 2000, 0.5)
    if (durationSec < 0.03) {
      winNapi.moveCursor({ x: Math.round(toX), y: Math.round(toY) })
      return
    }
    const frameRate = 60
    const frameIntervalMs = 1000 / frameRate
    const totalFrames = Math.floor(durationSec * frameRate)
    for (let frame = 1; frame <= totalFrames; frame++) {
      const t = frame / totalFrames
      const eased = 1 - Math.pow(1 - t, 3)
      winNapi.moveCursor({
        x: Math.round(fromX + deltaX * eased),
        y: Math.round(fromY + deltaY * eased),
      })
      if (frame < totalFrames) {
        await sleep(frameIntervalMs)
      }
    }
  }

  /**
   * Resolve a `screenshot_window` input to the form the win NAPI expects.
   * Inputs that already look like a path or a shell URI pass through
   * unchanged — those are exactly what the NAPI's classic exe-path matcher
   * and AUMID matcher consume directly. Inputs that look like a friendly
   * name (e.g. `"Calculator"` from a zh-CN agent that hasn't seen the
   * AUMID yet) get the same Get-StartApps + substring-scoring fallback
   * `open_application` uses, so AI can use the same vocabulary across
   * both tools.
   *
   * On Get-StartApps miss / NAPI unavailable we return the original input
   * unchanged so the NAPI's diagnostic surfaces the exact string the AI
   * passed (helps debug "why didn't this match anything").
   */
  function resolveWinAppIdentifierForCapture(input: string): string {
    if (input.startsWith('shell:') || input.includes('\\') || input.includes('/')) {
      return input
    }
    if (!napiAvailable) return input
    const lower = input.toLowerCase()
    const startApps = winListStartMenuApps()
    if (startApps.length === 0) return input
    // Exact friendly-name match wins.
    const exact = startApps.find(a => a.name.toLowerCase() === lower)
    if (exact) {
      const launcher = `shell:AppsFolder\\${exact.appId}`
      logForDebugging(
        `[computer-use] screenshotWindow (win): resolved "${input}" → "${launcher}" via Get-StartApps (name-exact, name="${exact.name}")`,
        { level: 'debug' },
      )
      return launcher
    }
    // AppID PackageName substring scoring — same logic as openApp.
    const scored = scoreAppIdSubstringMatch(input, startApps)
    const best = scored[0]?.app
    if (best) {
      const launcher = `shell:AppsFolder\\${best.appId}`
      logForDebugging(
        `[computer-use] screenshotWindow (win): resolved "${input}" → "${launcher}" via Get-StartApps (appid-substring, name="${best.name}", score=${scored[0]!.score}, candidates=${scored.length})`,
        { level: 'debug' },
      )
      return launcher
    }
    return input
  }

  /**
   * Keyboard-input foreground guard. SendInput INPUT_KEYBOARD events route
   * to whichever window has keyboard focus at SendInput time. If axiomate
   * itself is foreground (common right after the user submits a prompt),
   * the key would land in axiomate's terminal instead of the AI's intended
   * target. The Rust impl walks Z-order to the first non-our-PID visible
   * window and SetForegroundWindows to it — that's "the app the user was
   * using before clicking into axiomate". Mouse / scroll do NOT need this
   * because INPUT_MOUSE events route by coordinate, not by focus.
   *
   * 20ms sleep after the switch lets the OS dispatch the focus-change
   * message before SendInput fires; otherwise the keys can race the
   * focus change and still hit axiomate.
   */
  async function defocusBeforeKeyboardInput(): Promise<void> {
    if (!napiAvailable) return
    const switched = winNapi.defocusSelfToPreviousForeground()
    if (switched) {
      logForDebugging('[computer-use] defocused axiomate before keyboard input', { level: 'debug' })
      await sleep(20)
    }
  }

  return {
    // No `hostAppIdentifier` field — Win deliberately omits the host
    // sentinel (mac uses CLI_HOST_APP_IDENTIFIER to skip its hide loop
    // for the terminal). On Win we don't need it: keyboard input runs
    // through `defocusBeforeKeyboardInput()` which pushes the axiomate
    // terminal to background before SendInput fires, so the frontmost-
    // app safety gate in toolCalls.ts (`frontmost.appIdentifier ===
    // hostAppIdentifier`) never fires on the terminal naturally.
    capabilities: { ...WIN_CLI_CAPABILITIES },

    // ── Display geometry (winFallbacks → node-screenshots) ──────────────

    async getDisplaySize(displayId?: number) {
      return getWinDisplaySize(displayId)
    },

    async listDisplays() {
      return listWinDisplays()
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      if (!napiAvailable) {
        // Empty stub — request_access still works, just with empty options.
        // Functional degradation: AI sees no installed-app picker but every
        // currently-running app stays accessible via screenshot + click.
        return []
      }
      // Classic apps via Uninstall registry walk (full exe paths).
      const classic: InstalledApp[] = winNapi.listInstalledApps().map(a => ({
        appIdentifier: a.appIdentifier,
        displayName: a.displayName,
        path: a.path,
      }))
      // UWP / Microsoft Store apps via Get-StartApps. Classic apps don't
      // include UWP (Calculator, Photos, Settings, modern Notepad, Paint, …)
      // because UWP ships via AppX packages, not Uninstall registry. UWP
      // entries get appIdentifier = `shell:AppsFolder\<AppID>` — directly
      // launchable by openApp's shell: branch and (post-G2) usable as a
      // stable identifier for screenshot_window via AUMID matching.
      const uwp: InstalledApp[] = winListStartMenuApps().map(a => ({
        appIdentifier: `shell:AppsFolder\\${a.appId}`,
        displayName: a.name,
        path: '',
      }))
      // Dedupe by displayName lower-case. A classic registry entry for
      // "Microsoft Notepad" can shadow the UWP "Notepad" — keep the first
      // occurrence (classic preferred since it has a real path).
      const seen = new Set<string>()
      const merged: InstalledApp[] = []
      for (const a of [...classic, ...uwp]) {
        const key = a.displayName.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(a)
      }
      return merged
    },

    async appUnderPoint(x, y) {
      if (!napiAvailable) return null
      return winNapi.appUnderPoint(x, y)
    },

    async findWindowDisplays(appIdentifiers) {
      // Win NAPI returns monitor VRects (physical virtual-screen px)
      // from Win32 GetMonitorInfoW under Per-Monitor V2 DPI awareness.
      // node-screenshots also returns physical-pixel origins. We match
      // physical-origin-against-physical-origin.
      if (!napiAvailable) {
        return appIdentifiers.map(appIdentifier => ({ appIdentifier, displayIds: [] }))
      }
      const winInfo = winNapi.findWindowMonitorRects(appIdentifiers)
      const displays = listWinDisplays()
      return winInfo.map(({ appIdentifier, monitorRects }) => {
        const ids = new Set<number>()
        for (const r of monitorRects) {
          for (const d of displays) {
            if (d.originX === r.origin.x && d.originY === r.origin.y) {
              ids.add(d.displayId)
            }
          }
        }
        return { appIdentifier, displayIds: [...ids] }
      })
    },

    async getFrontmostApp() {
      // Win32 GetForegroundWindow → pid → exe path. Microseconds vs
      // PowerShell shell-out's ~80ms in winFallbacks. Returns null on lock
      // screen / UAC secure desktop / no foreground process.
      if (!napiAvailable) return winFallbackGetFrontmostApp()
      return winNapi.getForegroundWindow()
    },

    async screenshotWindow(appIdentifier: string) {
      // PrintWindow + PW_RENDERFULLCONTENT in the win NAPI. Returns a
      // structured outcome with diagnostic — same shape as mac NAPI's
      // capture_window. Non-DWM fallback to BitBlt is internal to the
      // NAPI binding. Click coordinates in subsequent tools still refer
      // to the FULL screen, never the window-cropped image — same
      // contract as mac.
      //
      // Friendly-name resolution: if the AI passes "Calculator" instead
      // of the full AUMID launcher URI, mirror the openApp fallback —
      // exact display-name match against Get-StartApps, then AppID
      // PackageName substring scoring (cross-locale: zh-CN where the
      // friendly name comes back as "计算器" but the AppID is always
      // English). This lets `screenshot_window` accept the same input
      // shape as `open_application`. Inputs that look like a path or
      // a shell URI are passed through untouched.
      if (!napiAvailable) return null
      const resolved = resolveWinAppIdentifierForCapture(appIdentifier)
      const outcome = winNapi.captureWindow(resolved)
      logForDebugging(
        `[CU-CAPTURE] capture_window: input="${appIdentifier}" resolved="${resolved}" diagnostic=${outcome.diagnostic}`,
        { level: 'debug' },
      )
      const image = outcome.image
      if (!image) return null
      // Debug aux: dump JPEG so user can visually inspect what AI saw.
      dumpScreenshotForDebug('screenshot_window', image.base64)
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
      allowedAppIdentifiers: string[]
      displayId?: number
      coordinateGrid?: string
    }): Promise<ScreenshotResult> {
      // Non-atomic path — toolCalls.ts handleScreenshot calls this when
      // autoTargetDisplay sub-gate is OFF. Hide loop (if enabled) runs
      // separately via prepareForAction; here we only do the capture.
      const gridMode = opts.coordinateGrid === 'none' ? 0 : opts.coordinateGrid === 'edge' ? 1 : 2
      const r = await captureScaledDisplay(opts.displayId, gridMode)
      if (!r) return winFallbackScreenshot(opts)
      return r
    },

    async zoom(region, _allowedAppIdentifiers, displayId?: number, coordinateGrid?: string, marks?: Array<{ id: number; x: number; y: number }>) {
      if (!napiAvailable) {
        throw new Error(
          `Win NAPI not available for zoom — ruler/grid/marks/cursor-circle require the NAPI's ` +
            `captureDisplayScaled pipeline. Check loadError via computer-use-win-napi-axiomate.getLoadError().`,
        )
      }
      const display = getWinDisplaySize(displayId)
      const [fullVirtualW, fullVirtualH] = computeImageDim(display.width, display.height)
      const ratioX = display.width / fullVirtualW
      const ratioY = display.height / fullVirtualH
      const physRegion = {
        x: Math.round(region.x * ratioX) + display.originX,
        y: Math.round(region.y * ratioY) + display.originY,
        w: Math.round(region.w * ratioX),
        h: Math.round(region.h * ratioY),
      }
      const gridMode = coordinateGrid === 'none' ? 0 : coordinateGrid === 'edge' ? 1 : 2
      // SoM markers: passed through verbatim — coords are in the same
      // virtual-coord space as `region` (rulers' label space), which is
      // exactly what the napi's draw_marks_on_rgb expects.
      const r = winNapi.captureDisplayScaled(
        { origin: { x: physRegion.x, y: physRegion.y }, size: { w: physRegion.w, h: physRegion.h } },
        physRegion.w, physRegion.h,
        92, gridMode,
        region.x, region.y, region.w, region.h,
        marks,
      )
      if (!r) {
        throw new Error(
          `Zoom capture failed — captureDisplayScaled returned null. ` +
            `This is typically a transient GDI / DWM hiccup (session lock, display mode change). Retry the zoom.`,
        )
      }
      dumpScreenshotForDebug('zoom', r.base64)
      return { base64: r.base64, width: r.width, height: r.height }
    },

    async resolvePrepareCapture(opts: {
      allowedAppIdentifiers: string[]
      preferredDisplayId?: number
      autoResolve: boolean
      doHide?: boolean
      coordinateGrid?: string
    }): Promise<ResolvePrepareCaptureResult> {
      // Atomic path — toolCalls.ts handleScreenshot calls this when
      // autoTargetDisplay sub-gate is ON (the common case). On Win we
      // deliberately do NOT honor the hide loop (mac semantics): Win's
      // model is "don't touch other apps; clicks deliver to wherever they
      // land and Win11 shell handles target activation". Empty `hidden`
      // returned regardless of `opts.doHide`. See COORDINATES.md / the
      // platform-divergence note in computer-use-mcp-axiomate/executor.ts.
      const gridMode = opts.coordinateGrid === 'none' ? 0 : opts.coordinateGrid === 'edge' ? 1 : 2
      const r = await captureScaledDisplay(opts.preferredDisplayId, gridMode)
      if (!r) {
        return await winFallbackResolvePrepareCapture(opts)
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

    // ── UI Automation (SoM overlay for click_target zoom) ──────────────
    // Enumerate visible UI elements within a physical-pixel rect via
    // IUIAutomation::FindAll rooted at the desktop. The agent calls this
    // during a click_target loop's zoom step; results feed into the SoM
    // marker overlay drawn into the zoomed image AND the structured-text
    // mark list that goes back alongside the image.
    //
    // Returns [] when the napi isn't available (non-Windows / load failure)
    // or when COM init / IUIAutomation creation failed inside Rust — the
    // dispatcher treats empty as "no marks; fall back to ruler positioning".
    async enumerateVisibleElements(rect) {
      if (!napiAvailable) return []
      const raw = await winNapi.enumerateUiElementsInRect({
        origin: { x: Math.round(rect.x), y: Math.round(rect.y) },
        size:   { w: Math.round(rect.w), h: Math.round(rect.h) },
      })
      return raw.map(e => ({
        bbox: {
          x: e.bbox.origin.x,
          y: e.bbox.origin.y,
          w: e.bbox.size.w,
          h: e.bbox.size.h,
        },
        name: e.name,
        role: e.role,
        automationId: e.automationId ?? undefined,
      }))
    },

    // Win32-direct mouse input — replaces nut.js for moveMouse / click /
    // getCursorPosition. nut.js silently fails in Bun-compiled exes
    // (cursor doesn't visibly move; getPosition returns the requested
    // value, masking the failure as "delta=0 success"). Going through
    // win NAPI calls SendInput directly with no intermediate native
    // binding.
    //
    // Coords are PHYSICAL virtual-screen px end-to-end. The win NAPI
    // is Per-Monitor V2 DPI-aware (ensure_dpi_aware in lib.rs), so
    // all Win32 coord APIs — GetCursorPos, SendInput, WindowFromPoint
    // — speak physical pixels. DisplayGeometry on Win carries physical
    // values, so scaleCoord naturally outputs physical coords. No DPI
    // multiplication anywhere on the win path. See COORDINATES.md.

    async moveMouse(x: number, y: number): Promise<void> {
      if (!napiAvailable) inputUnavailable('moveMouse')
      const actual = winNapi.moveCursor({ x: Math.round(x), y: Math.round(y) })
      logForDebugging(
        `[computer-use] moveMouse (win): target=(${x},${y}) win32_actual=(${actual.x},${actual.y})`,
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
      if (!napiAvailable) inputUnavailable('click')
      const buttonCode = button === 'left' ? 0 : button === 'right' ? 1 : 2
      const modVks = (modifiers ?? []).map(m => parseKeyName(m).vk)
      // Modifier path: press all modifiers, position cursor, click, release
      // modifiers in reverse. All Win32 SendInput — no nut.js fall-through.
      for (const vk of modVks) winNapi.keyEvent(vk, true, false)
      const moved = winNapi.moveCursor({ x: Math.round(x), y: Math.round(y) })
      logForDebugging(
        `[computer-use] click (win): target=(${x},${y}) win32_actual=(${moved.x},${moved.y}) button=${button} count=${count} modifiers=[${(modifiers ?? []).join(',')}]`,
        { level: 'debug' },
      )
      try {
        winNapi.clickMouse(buttonCode, count)
      } finally {
        for (const vk of [...modVks].reverse()) winNapi.keyEvent(vk, false, false)
      }
    },

    async mouseDown(): Promise<void> {
      if (!napiAvailable) inputUnavailable('mouseDown')
      winNapi.mouseButtonEvent(0, true)
    },

    async mouseUp(): Promise<void> {
      if (!napiAvailable) inputUnavailable('mouseUp')
      winNapi.mouseButtonEvent(0, false)
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      if (!napiAvailable) inputUnavailable('getCursorPosition')
      const phys = winNapi.getCursorPos()
      return { x: phys.x, y: phys.y }
    },

    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      if (!napiAvailable) inputUnavailable('drag')
      // Win32 drag = move-to-from → button-down → animated-move-to-to → button-up.
      // Mouse path is left-button only (per ComputerExecutor contract).
      if (from) winNapi.moveCursor({ x: Math.round(from.x), y: Math.round(from.y) })
      winNapi.mouseButtonEvent(0, true)
      try {
        // Tiny sleep so the OS sees the down before the move. Without it
        // some apps treat a same-tick down+move as a click + then ignored
        // movement, which breaks selection-drag semantics.
        await sleep(10)
        const startPos = winNapi.getCursorPos()
        await animatedMoveCursor(startPos.x, startPos.y, to.x, to.y)
      } finally {
        winNapi.mouseButtonEvent(0, false)
      }
    },

    async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
      if (!napiAvailable) inputUnavailable('scroll')
      // Pre-position cursor so the scroll lands in the intended window.
      // Wheel ticks: incoming dx/dy are "lines" units (positive dy = up
      // by convention here). Multiply by WHEEL_DELTA (120).
      winNapi.moveCursor({ x: Math.round(x), y: Math.round(y) })
      winNapi.mouseScroll(Math.round(dx) * 120, Math.round(dy) * 120)
      logForDebugging(
        `[computer-use] scroll (win): target=(${x},${y}) dx=${dx} dy=${dy}`,
        { level: 'debug' },
      )
    },

    // ── Keyboard (Win32 SendInput INPUT_KEYBOARD direct) ────────────────

    async key(keySequence: string, repeat?: number): Promise<void> {
      if (!napiAvailable) inputUnavailable('key')
      const { mods, key, keyExtended } = parseKeySeq(keySequence)
      const n = Math.max(1, repeat ?? 1)
      // Bare ESC (no modifiers): punch a hole in our own WH_KEYBOARD_LL
      // hook so the model-synthesized keydown flows to its target instead
      // of triggering the abort callback. ctrl+esc / shift+esc etc. are
      // not bare ESC and don't need the hole.
      const isBareEsc = mods.length === 0 && key === 0x1b
      logForDebugging(
        `[computer-use] key (win): seq="${keySequence}" mods=[${mods.map(v => '0x' + v.toString(16)).join(',')}] key=0x${key.toString(16)}${keyExtended ? ' (ext)' : ''} repeat=${n}`,
        { level: 'debug' },
      )
      await defocusBeforeKeyboardInput()
      for (let i = 0; i < n; i++) {
        for (const m of mods) winNapi.keyEvent(m, true, false)
        try {
          if (isBareEsc) notifyExpectedEscape()
          winNapi.keyEvent(key, true, keyExtended)
          winNapi.keyEvent(key, false, keyExtended)
        } finally {
          for (const m of [...mods].reverse()) winNapi.keyEvent(m, false, false)
        }
      }
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      if (!napiAvailable) inputUnavailable('holdKey')
      const infos = keyNames.map(parseKeyName)
      logForDebugging(
        `[computer-use] holdKey (win): keys=[${keyNames.join(',')}] durationMs=${durationMs}`,
        { level: 'debug' },
      )
      await defocusBeforeKeyboardInput()
      for (const info of infos) {
        // Same bare-ESC hole-punch as key() — our hook would otherwise
        // see the keydown and abort the turn.
        if (info.vk === 0x1b) notifyExpectedEscape()
        winNapi.keyEvent(info.vk, true, info.extended)
      }
      try {
        await sleep(durationMs)
      } finally {
        for (const info of [...infos].reverse()) winNapi.keyEvent(info.vk, false, info.extended)
      }
    },

    async type(text: string, opts: { viaClipboard: boolean }): Promise<void> {
      if (!napiAvailable) inputUnavailable('type')
      await defocusBeforeKeyboardInput()
      if (opts.viaClipboard) {
        // viaClipboard: write text to system clipboard, then issue
        // Win32-direct ctrl+v. Clipboard write is via PowerShell stdin
        // (winFallbacks.winFallbackWriteClipboard); the keyboard chord
        // has to be SendInput to actually fire.
        try {
          winFallbackWriteClipboard(text)
          winNapi.keyEvent(0x11, true, false)  // VK_CONTROL down
          try {
            winNapi.keyEvent(0x56, true, false)  // V down
            winNapi.keyEvent(0x56, false, false) // V up
          } finally {
            winNapi.keyEvent(0x11, false, false) // VK_CONTROL up
          }
        } catch {
          // Clipboard write failed → fall back to per-char typing
          winNapi.typeTextUnicode(text)
        }
      } else {
        winNapi.typeTextUnicode(text)
      }
      logForDebugging(
        `[computer-use] type (win): len=${text.length} viaClipboard=${opts.viaClipboard}`,
        { level: 'debug' },
      )
    },

    async openApp(appIdentifierOrName: string): Promise<void> {
      // Resolution chain:
      //   1. shell:AppsFolder\<AppID> (or any shell:URI) → Start-Process
      //      handles the URI scheme natively. This is what list_installed_apps
      //      returns for UWP / Microsoft Store apps.
      //   2. Looks like a path (contains \, /, or .exe suffix) → direct
      //      Start-Process. AI passed list_installed_apps output verbatim.
      //   3. Display-name match against winNapi.listInstalledApps registry
      //      walk → use the resolved full path. Catches the common case
      //      where AI passes a friendly name like "Chrome" without first
      //      calling list_installed_apps.
      //   4. Display-name match against Get-StartApps (UWP) → launch via
      //      `shell:AppsFolder\<AppID>`. Catches AI passing "Calculator" /
      //      "Photos" / "Settings" without prior list_installed_apps.
      //   5. Pass-through to PowerShell Start-Process. App Paths registry
      //      resolves a few canonical names ("chrome", "firefox", "calc",
      //      "notepad" via WindowsApps alias). On failure, winInlineOpenApp
      //      surfaces a clean error pointing AI at list_installed_apps.
      if (appIdentifierOrName.startsWith('shell:')) {
        return winInlineOpenApp(appIdentifierOrName)
      }
      const looksLikePath =
        appIdentifierOrName.includes('\\') ||
        appIdentifierOrName.includes('/') ||
        appIdentifierOrName.toLowerCase().endsWith('.exe')
      if (looksLikePath) {
        return winInlineOpenApp(appIdentifierOrName)
      }
      const lower = appIdentifierOrName.toLowerCase()
      if (napiAvailable) {
        const installed = winNapi.listInstalledApps()
        const match = installed.find(
          a => a.displayName.toLowerCase() === lower,
        )
        if (match?.path) {
          logForDebugging(
            `[computer-use] openApp (win): resolved "${appIdentifierOrName}" → "${match.path}" via listInstalledApps`,
            { level: 'debug' },
          )
          return winInlineOpenApp(match.path)
        }
      }
      const startApps = winListStartMenuApps()
      // Match strategies, in order of strictness:
      //   1. Exact lowercase name match (en-US: "Calculator" === "calculator").
      //   2. AppID-package-name substring match, scored by word-boundary —
      //      cross-locale (AppIDs are always English regardless of OS
      //      locale, so this catches zh-CN where Get-StartApps Name returns
      //      "计算器"). Whitespace stripped from input so "Windows Calculator"
      //      still hits "microsoft.windowscalculator". Score boosts a hit
      //      that lands on a separator boundary or string edge so "calc"
      //      hitting Microsoft.WindowsCalculator outranks Microsoft.MyCalcThing,
      //      and "edge" hitting MicrosoftEdge outranks MicrosoftEdgeUpdate.
      let sm = startApps.find(a => a.name.toLowerCase() === lower)
      let matchKind = "name-exact"
      if (!sm) {
        // AppID-PackageName substring match with word-boundary scoring.
        // See `scoreAppIdSubstringMatch` for the scoring rules and rationale.
        const scored = scoreAppIdSubstringMatch(appIdentifierOrName, startApps)
        sm = scored[0]?.app
        if (sm) {
          matchKind = "appid-substring"
          // Multi-candidate diagnostic — when 2+ hits exist, list top 5
          // so debug logs surface the alternatives the AI might have meant.
          if (scored.length > 1) {
            const others = scored.slice(1, 5).map(s => `${s.app.name}(${s.app.appId}, score=${s.score})`).join(', ')
            logForDebugging(
              `[computer-use] openApp (win): "${appIdentifierOrName}" matched ${scored.length} AppID-substring candidates; picked "${sm.name}" (${sm.appId}, score=${scored[0]!.score}); others: [${others}]`,
              { level: 'debug' },
            )
          }
        }
      }
      if (sm) {
        const launcher = `shell:AppsFolder\\${sm.appId}`
        logForDebugging(
          `[computer-use] openApp (win): resolved "${appIdentifierOrName}" → "${launcher}" via Get-StartApps (UWP, ${matchKind} match: name="${sm.name}")`,
          { level: 'debug' },
        )
        return winInlineOpenApp(launcher)
      }
      logForDebugging(
        `[computer-use] openApp (win): "${appIdentifierOrName}" did not match any of ${startApps.length} Get-StartApps UWP entries; falling through to Start-Process raw`,
        { level: 'debug' },
      )
      return winInlineOpenApp(appIdentifierOrName)
    },

    async listRunningApps(): Promise<RunningApp[]> {
      // EnumWindows + dedupe by exe path — keeps the appIdentifier space
      // consistent with the rest of the win NAPI (hideApp /
      // findWindowDisplays expect full exe paths). PowerShell fallback
      // returns ProcessName ("chrome"), which won't match hideApp's
      // exe-path expectation but is better than empty when NAPI is dead.
      if (!napiAvailable) return winFallbackListRunningApps()
      return winNapi.listRunningApps().map(a => ({
        appIdentifier: a.appIdentifier,
        displayName: a.displayName,
      }))
    },

    async readClipboard(): Promise<string> {
      return winFallbackReadClipboard()
    },

    async writeClipboard(text: string): Promise<void> {
      winFallbackWriteClipboard(text)
    },

    // No `prepareForAction` / `previewHideSet` overrides — Win does not
    // implement the hide-before-action model. Both methods are optional in
    // ComputerExecutor (computer-use-mcp-axiomate/executor.ts); callers
    // use `?.()` and treat undefined as "nothing to hide". Mac keeps its
    // own implementation via mac NAPI / macShim.
  }
}
