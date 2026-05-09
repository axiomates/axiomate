/**
 * CLI `ComputerExecutor` implementation. Wraps two native modules:
 *   - `computer-use-native-axiomate` (Rust/enigo) — mouse, keyboard, frontmost app
 *   - `computer-use-native-axiomate` — SCContentFilter screenshots, NSWorkspace apps, TCC
 *
 * Contract: `packages/desktop/computer-use-mcp/src/executor.ts` in the apps
 * repo. The reference impl is the upstream Electron app's computer-use
 * executor — see notable deviations under "CLI deltas" below.
 *
 * ── CLI deltas from the upstream Electron app ─────────────────────────────────────────────────
 *
 * No `withClickThrough`. the upstream Electron app wraps every mouse op in
 *   `BrowserWindow.setIgnoreMouseEvents(true)` so clicks fall through the
 *   overlay. We're a terminal — no window — so the click-through bracket is
 *   a no-op. The sentinel `CLI_HOST_APP_IDENTIFIER` never matches frontmost.
 *
 * Terminal as surrogate host. `getTerminalAppIdentifier()` detects the emulator
 *   we're running inside. It's passed as `hostAppIdentifier` to `prepareDisplay`/
 *   `resolvePrepareCapture` so the Swift side exempts it from hide AND skips
 *   it in the activate z-order walk (so the terminal being frontmost doesn't
 *   eat clicks meant for the target app). Also stripped from `allowedAppIdentifiers`
 *   via `withoutTerminal()` so screenshots don't capture it (Swift 0.2.1's
 *   captureExcluding takes an allow-list despite the name — apps#30355).
 *   `capabilities.hostAppIdentifier` stays as the sentinel — the package's
 *   frontmost gate uses that, and the terminal being frontmost is fine.
 *
 * Clipboard via `pbcopy`/`pbpaste`. No Electron `clipboard` module.
 */

import type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from 'computer-use-mcp-axiomate'

import { API_RESIZE_PARAMS, targetImageSize } from 'computer-use-mcp-axiomate'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { getConfigHomeDir } from '../envUtils.js'
import { sleep } from '../sleep.js'
import { join } from 'path'
import { overlayScreenshotArtifacts } from './imageOverlay.js'
import {
  MAC_CLI_CAPABILITIES,
  CLI_HOST_APP_IDENTIFIER,
  getTerminalAppIdentifier,
} from './common.js'
import { drainRunLoop } from './drainRunLoop.js'
import { notifyExpectedEscape } from './escHotkey.js'
import { requireComputerUseInput } from './inputLoader.js'
import { requireComputerUseSwift } from './swiftLoader.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const SCREENSHOT_JPEG_QUALITY = 0.75
type GridMode = 'none' | 'edge' | 'full'

function dumpMacScreenshotForDebug(tool: string, base64: string): void {
  try {
    if (!base64) return
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    const buf = Buffer.from(base64, 'base64')
    if (buf.length === 0) return
    const dir = join(getConfigHomeDir(), 'debug', 'screenshots')
    fs.mkdirSync(dir, { recursive: true })
    const safe = tool.replace(/[^a-zA-Z0-9_-]/g, '_')
    fs.writeFileSync(join(dir, `${safe}-latest.jpg`), buf)
  } catch {
    // best-effort
  }
}

/** Logical → physical → API target dims. See `targetImageSize` + COORDINATES.md. */
function computeTargetDims(
  logicalW: number,
  logicalH: number,
  scaleFactor: number,
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor)
  const physH = Math.round(logicalH * scaleFactor)
  return targetImageSize(physW, physH, API_RESIZE_PARAMS)
}

async function readClipboardViaPbpaste(): Promise<string> {
  const { stdout, code } = await execFileNoThrow('pbpaste', [], {
    useCwd: false,
  })
  if (code !== 0) {
    throw new Error(`pbpaste exited with code ${code}`)
  }
  return stdout
}

async function writeClipboardViaPbcopy(text: string): Promise<void> {
  const { code } = await execFileNoThrow('pbcopy', [], {
    input: text,
    useCwd: false,
  })
  if (code !== 0) {
    throw new Error(`pbcopy exited with code ${code}`)
  }
}

type Input = ReturnType<typeof requireComputerUseInput>

/**
 * Single-element key sequence matching "escape" or "esc" (case-insensitive).
 * Used to hole-punch the CGEventTap abort for model-synthesized Escape — enigo
 * accepts both spellings, so the tap must too.
 */
function isBareEscape(parts: readonly string[]): boolean {
  if (parts.length !== 1) return false
  const lower = parts[0]!.toLowerCase()
  return lower === 'escape' || lower === 'esc'
}

/**
 * Instant move, then 50ms — an input→HID→AppKit→NSEvent round-trip before the
 * caller reads `NSEvent.mouseLocation` or dispatches a click. Used for click,
 * scroll, and drag-from; `animatedMove` is reserved for drag-to only. The
 * intermediate animation frames were triggering hover states and, on the
 * decomposed mouseDown/moveMouse path, emitting stray `.leftMouseDragged`
 * events (toolCalls.ts handleScroll's mouse_full workaround).
 */
const MOVE_SETTLE_MS = 50

async function moveAndSettle(
  input: Input,
  x: number,
  y: number,
): Promise<void> {
  await input.moveMouse(x, y, false)
  await sleep(MOVE_SETTLE_MS)
}

/**
 * Release `pressed` in reverse (last pressed = first released). Errors are
 * swallowed so a release failure never masks the real error.
 *
 * Drains via pop() rather than snapshotting length: if a drainRunLoop-
 * orphaned press lambda resolves an in-flight input.key() AFTER finally
 * calls us, that late push is still released on the next iteration. The
 * orphaned flag stops the lambda at its NEXT check, not the current await.
 */
async function releasePressed(input: Input, pressed: string[]): Promise<void> {
  let k: string | undefined
  while ((k = pressed.pop()) !== undefined) {
    try {
      await input.key(k, 'release')
    } catch {
      // Swallow — best-effort release.
    }
  }
}

/**
 * Bracket `fn()` with modifier press/release. `pressed` tracks which presses
 * actually landed, so a mid-press throw only releases what was pressed — no
 * stuck modifiers. The finally covers both press-phase and fn() throws.
 *
 * Caller must already be inside drainRunLoop() — key() dispatches to the
 * main queue and needs the pump to resolve.
 */
async function withModifiers<T>(
  input: Input,
  mods: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const pressed: string[] = []
  try {
    for (const m of mods) {
      await input.key(m, 'press')
      pressed.push(m)
    }
    return await fn()
  } finally {
    await releasePressed(input, pressed)
  }
}

/**
 * Port of the upstream Electron app's `typeViaClipboard`. Sequence:
 *   1. Save the user's clipboard.
 *   2. Write our text.
 *   3. READ-BACK VERIFY — clipboard writes can silently fail. If the
 *      read-back doesn't match, never press Cmd+V (would paste junk).
 *   4. Cmd+V via keys().
 *   5. Sleep 100ms — battle-tested threshold for the paste-effect vs
 *      clipboard-restore race. Restoring too soon means the target app
 *      pastes the RESTORED content.
 *   6. Restore — in a `finally`, so a throw between 2-5 never leaves the
 *      user's clipboard clobbered. Restore failures are swallowed.
 */
async function typeViaClipboard(input: Input, text: string): Promise<void> {
  let saved: string | undefined
  try {
    saved = await readClipboardViaPbpaste()
  } catch {
    logForDebugging(
      '[computer-use] pbpaste before paste failed; proceeding without restore',
    )
  }

  try {
    await writeClipboardViaPbcopy(text)
    if ((await readClipboardViaPbpaste()) !== text) {
      throw new Error('Clipboard write did not round-trip.')
    }
    await input.keys(['command', 'v'])
    await sleep(100)
  } finally {
    if (typeof saved === 'string') {
      try {
        await writeClipboardViaPbcopy(saved)
      } catch {
        logForDebugging('[computer-use] clipboard restore after paste failed')
      }
    }
  }
}

/**
 * Port of the upstream Electron app's `animateMouseMovement` + `animatedMove`. Ease-out-cubic at
 * 60fps; distance-proportional duration at 2000 px/sec, capped at 0.5s. When
 * the sub-gate is off (or distance < ~2 frames), falls through to
 * `moveAndSettle`. Called only from `drag` for the press→to motion — target
 * apps may watch for `.leftMouseDragged` specifically (not just "button down +
 * position changed") and the slow motion gives them time to process
 * intermediate positions (scrollbars, window resizes).
 */
async function animatedMove(
  input: Input,
  targetX: number,
  targetY: number,
  mouseAnimationEnabled: boolean,
): Promise<void> {
  if (!mouseAnimationEnabled) {
    await moveAndSettle(input, targetX, targetY)
    return
  }
  const start = await input.mouseLocation()
  const deltaX = targetX - start.x
  const deltaY = targetY - start.y
  const distance = Math.hypot(deltaX, deltaY)
  if (distance < 1) return
  const durationSec = Math.min(distance / 2000, 0.5)
  if (durationSec < 0.03) {
    await moveAndSettle(input, targetX, targetY)
    return
  }
  const frameRate = 60
  const frameIntervalMs = 1000 / frameRate
  const totalFrames = Math.floor(durationSec * frameRate)
  for (let frame = 1; frame <= totalFrames; frame++) {
    const t = frame / totalFrames
    const eased = 1 - Math.pow(1 - t, 3)
    await input.moveMouse(
      Math.round(start.x + deltaX * eased),
      Math.round(start.y + deltaY * eased),
      false,
    )
    if (frame < totalFrames) {
      await sleep(frameIntervalMs)
    }
  }
  // Last frame has no trailing sleep — same HID round-trip before the
  // caller's mouseButton reads NSEvent.mouseLocation.
  await sleep(MOVE_SETTLE_MS)
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createCliExecutor(opts: {
  getMouseAnimationEnabled: () => boolean
  getHideBeforeActionEnabled: () => boolean
}): ComputerExecutor {
  if (process.platform !== 'darwin') {
    throw new Error(
      `createCliExecutor is the mac-only factory and was called on ${process.platform}. ` +
        `This is a routing bug — hostAdapter.ts should dispatch win32 to createWinExecutor. ` +
        `Computer-use itself works on Windows via the win32 native peer ` +
        `(computer-use-win-napi-axiomate); this throw means a code path skipped the platform dispatch.`,
    )
  }

  // Swift loaded once at factory time — every executor method needs it.
  // Input loaded lazily via requireComputerUseInput() on first mouse/keyboard
  // call — it caches internally, so screenshot-only flows never pull the
  // enigo .node.
  const cu = requireComputerUseSwift()

  const { getMouseAnimationEnabled, getHideBeforeActionEnabled } = opts
  const terminalAppIdentifier = getTerminalAppIdentifier()
  const surrogateHost = terminalAppIdentifier ?? CLI_HOST_APP_IDENTIFIER
  // Swift 0.2.1's captureExcluding/captureRegion take an ALLOW list despite the
  // name (apps#30355 — complement computed Swift-side against running apps).
  // The terminal isn't in the user's grants so it's naturally excluded, but if
  // the package ever passes it through we strip it here so the terminal never
  // photobombs a screenshot.
  const withoutTerminal = (allowed: readonly string[]): string[] =>
    terminalAppIdentifier === null
      ? [...allowed]
      : allowed.filter(id => id !== terminalAppIdentifier)

  logForDebugging(
    terminalAppIdentifier
      ? `[computer-use] terminal ${terminalAppIdentifier} → surrogate host (hide-exempt, activate-skip, screenshot-excluded)`
      : '[computer-use] terminal not detected; falling back to sentinel host',
  )

  return {
    capabilities: {
      ...MAC_CLI_CAPABILITIES,
      hostAppIdentifier: CLI_HOST_APP_IDENTIFIER,
    },

    // ── Pre-action sequence (hide + defocus) ────────────────────────────

    async prepareForAction(
      allowlistAppIdentifiers: string[],
      displayId?: number,
    ): Promise<string[]> {
      if (!getHideBeforeActionEnabled()) {
        return []
      }
      // prepareDisplay isn't @MainActor (plain Task{}), but its .hide() calls
      // trigger window-manager events that queue on CFRunLoop. Without the
      // pump, those pile up during Swift's ~1s of usleeps and flush all at
      // once when the next pumped call runs — visible window flashing.
      // Electron drains CFRunLoop continuously so the upstream Electron app doesn't see this.
      // Worst-case 100ms + 5×200ms safety-net ≈ 1.1s, well under the 30s
      // drainRunLoop ceiling.
      //
      // "Continue with action execution even if switching fails" — the
      // frontmost gate in toolCalls.ts catches any actual unsafe state.
      return drainRunLoop(async () => {
        try {
          const result = await cu.apps.prepareDisplay(
            allowlistAppIdentifiers,
            surrogateHost,
            displayId,
          )
          if (result.activated) {
            logForDebugging(
              `[computer-use] prepareForAction: activated ${result.activated}`,
            )
          }
          return result.hidden
        } catch (err) {
          logForDebugging(
            `[computer-use] prepareForAction failed; continuing to action: ${errorMessage(err)}`,
            { level: 'warn' },
          )
          return []
        }
      })
    },

    async previewHideSet(
      allowlistAppIdentifiers: string[],
      displayId?: number,
    ): Promise<Array<{ appIdentifier: string; displayName: string }>> {
      return cu.apps.previewHideSet(
        [...allowlistAppIdentifiers, surrogateHost],
        displayId,
      )
    },

    // ── Display ──────────────────────────────────────────────────────────

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      return cu.display.getSize(displayId)
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      return cu.display.listAll()
    },

    async findWindowDisplays(
      appIdentifiers: string[],
    ): Promise<Array<{ appIdentifier: string; displayIds: number[] }>> {
      return cu.apps.findWindowDisplays(appIdentifiers)
    },

    async resolvePrepareCapture(opts: {
      allowedAppIdentifiers: string[]
      preferredDisplayId?: number
      autoResolve: boolean
      doHide?: boolean
    }): Promise<ResolvePrepareCaptureResult> {
      const d = cu.display.getSize(opts.preferredDisplayId)
      const [targetW, targetH] = computeTargetDims(
        d.width,
        d.height,
        d.scaleFactor,
      )
      logForDebugging(
        `[computer-use] agent.resolvePrepareCapture enter: allowedAppIdentifiers=[${opts.allowedAppIdentifiers.join(',')}] preferredDisplayId=${opts.preferredDisplayId ?? 'undef'} autoResolve=${opts.autoResolve} doHide=${opts.doHide ?? 'undef'} targetW=${targetW} targetH=${targetH} displayW=${d.width} displayH=${d.height} scale=${d.scaleFactor}`,
        { level: 'debug' },
      )
      const result: ResolvePrepareCaptureResult = await drainRunLoop(() =>
        cu.resolvePrepareCapture(
          withoutTerminal(opts.allowedAppIdentifiers),
          surrogateHost,
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts.preferredDisplayId,
          opts.autoResolve,
          opts.doHide,
        ),
      )
      logForDebugging(
        `[computer-use] agent.resolvePrepareCapture done: base64Len=${result?.base64?.length ?? 'undef'} width=${result?.width} height=${result?.height} displayId=${result?.displayId} hiddenCount=${result?.hidden?.length ?? 0} captureError=${result?.captureError ?? 'none'}`,
        { level: 'debug' },
      )
      return result
    },

    /**
     * Pre-size to `targetImageSize` output so the API transcoder's early-return
     * fires — no server-side resize, `scaleCoord` stays coherent. See
     * packages/desktop/computer-use-mcp/COORDINATES.md.
     */
    async screenshot(opts: {
      allowedAppIdentifiers: string[]
      displayId?: number
      coordinateGrid?: string
    }): Promise<ScreenshotResult> {
      const d = cu.display.getSize(opts.displayId)
      const [targetW, targetH] = computeTargetDims(
        d.width,
        d.height,
        d.scaleFactor,
      )
      logForDebugging(
        `[computer-use] agent.screenshot enter: allowedAppIdentifiers=[${opts.allowedAppIdentifiers.join(',')}] displayId=${opts.displayId ?? 'undef'} targetW=${targetW} targetH=${targetH} displayW=${d.width} displayH=${d.height} scale=${d.scaleFactor}`,
        { level: 'debug' },
      )
      const result: ScreenshotResult = await drainRunLoop(() =>
        cu.screenshot.captureExcluding(
          withoutTerminal(opts.allowedAppIdentifiers),
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts.displayId,
        ),
      )
      logForDebugging(
        `[computer-use] agent.screenshot done: base64Len=${result?.base64?.length ?? 'undef'} width=${result?.width} height=${result?.height} displayId=${result?.displayId}`,
        { level: 'debug' },
      )
      if (opts.coordinateGrid && opts.coordinateGrid !== 'none') {
        result.base64 = await overlayScreenshotArtifacts({
          base64: result.base64,
          imageWidth: result.width,
          imageHeight: result.height,
          gridMode: opts.coordinateGrid as GridMode,
          range: {
            originX: 0,
            originY: 0,
            rangeW: result.width,
            rangeH: result.height,
          },
          jpegQuality: 85,
        })
      }
      dumpMacScreenshotForDebug('screenshot', result.base64)
      return result
    },

    async screenshotWindow(
      appIdentifier: string,
      gridMode?: number,
      marks?: Array<{ id: number; x: number; y: number }>,
    ): Promise<ScreenshotResult | null> {
      // Delegates to the compat layer's `captureWindow`, which routes to the
      // native NAPI binding (CGWindowListCreateImage). The native call
      // returns a structured outcome — { image, diagnostic } — so the agent
      // can surface failure reasons via logForDebugging instead of relying
      // on stderr eprintln (which the TUI obscures).
      logForDebugging(
        `[computer-use] agent.screenshotWindow enter: appIdentifier=${appIdentifier}`,
        { level: 'debug' },
      )
      const outcome = await cu.captureWindow(appIdentifier)
      // Always log the diagnostic. On success it reads "ok" (or "ok (...)"
      // when fallback path was taken); on failure it explains which step
      // died and includes pid / candidate windowIDs / layers / TCC hints.
      // grep `~/.axiomate/debug/latest` for `capture_window outcome` to see
      // why a given app identifier failed.
      logForDebugging(
        `[computer-use] capture_window outcome: appIdentifier=${appIdentifier} diagnostic=${outcome.diagnostic}`,
        { level: 'debug' },
      )
      const image = outcome.image
      logForDebugging(
        `[computer-use] agent.screenshotWindow done: ${image ? `base64Len=${image.base64.length} width=${image.width} height=${image.height}` : 'null'}`,
        { level: 'debug' },
      )
      if (!image) return null
      // Pad to ScreenshotResult shape — `displayId`, `displayWidth`,
      // `displayHeight` are unused for window captures (click coords always
      // refer to the full screen).
      const result = {
        base64: (gridMode && gridMode > 0) || (marks?.length ?? 0) > 0
          ? await overlayScreenshotArtifacts({
              base64: image.base64,
              imageWidth: image.width,
              imageHeight: image.height,
              gridMode: gridMode === 1 ? 'edge' : gridMode && gridMode >= 2 ? 'full' : 'none',
              range: {
                originX: image.originX,
                originY: image.originY,
                rangeW: image.displayWidth,
                rangeH: image.displayHeight,
              },
              marks: (marks ?? []).map(m => ({
                id: m.id,
                x: ((m.x - image.originX) / image.displayWidth) * image.width,
                y: ((m.y - image.originY) / image.displayHeight) * image.height,
              })),
              jpegQuality: 85,
            })
          : image.base64,
        width: image.width,
        height: image.height,
        displayId: 0,
        displayWidth: image.displayWidth,
        displayHeight: image.displayHeight,
        originX: image.originX,
        originY: image.originY,
      }
      dumpMacScreenshotForDebug('screenshot_window', result.base64)
      return result
    },

    async zoom(
      regionVirtual: { x: number; y: number; w: number; h: number },
      allowedAppIdentifiers: string[],
      displayId?: number,
      coordinateGrid?: string,
      marks?: Array<{ id: number; x: number; y: number }>,
    ): Promise<{ base64: string; width: number; height: number }> {
      const d = cu.display.getSize(displayId)
      // Virtual (image-px) → logical (points): same ratio as screenshot downscale
      const [imgW, imgH] = computeTargetDims(d.width, d.height, d.scaleFactor)
      const ratioX = d.width / imgW
      const ratioY = d.height / imgH
      const regionLogical = {
        x: regionVirtual.x * ratioX,
        y: regionVirtual.y * ratioY,
        w: regionVirtual.w * ratioX,
        h: regionVirtual.h * ratioY,
      }
      const [outW, outH] = computeTargetDims(
        regionLogical.w,
        regionLogical.h,
        d.scaleFactor,
      )
      const shot: { base64: string; width: number; height: number } = await drainRunLoop(() =>
        cu.screenshot.captureRegion(
          withoutTerminal(allowedAppIdentifiers),
          regionLogical.x,
          regionLogical.y,
          regionLogical.w,
          regionLogical.h,
          outW,
          outH,
          SCREENSHOT_JPEG_QUALITY,
          displayId,
        ),
      )
      const overlayMarks = (marks ?? [])
        .filter(m => m.x >= regionVirtual.x && m.x <= regionVirtual.x + regionVirtual.w && m.y >= regionVirtual.y && m.y <= regionVirtual.y + regionVirtual.h)
        .map(m => ({
          id: m.id,
          x: ((m.x - regionVirtual.x) / regionVirtual.w) * shot.width,
          y: ((m.y - regionVirtual.y) / regionVirtual.h) * shot.height,
        }))
      if ((coordinateGrid && coordinateGrid !== 'none') || overlayMarks.length > 0) {
        shot.base64 = await overlayScreenshotArtifacts({
          base64: shot.base64,
          imageWidth: shot.width,
          imageHeight: shot.height,
          gridMode: (coordinateGrid as 'none' | 'edge' | 'full' | undefined) ?? 'none',
          range: {
            originX: regionVirtual.x,
            originY: regionVirtual.y,
            rangeW: regionVirtual.w,
            rangeH: regionVirtual.h,
          },
          marks: overlayMarks,
          jpegQuality: 85,
        })
      }
      dumpMacScreenshotForDebug('zoom', shot.base64)
      return shot
    },

    // ── Keyboard ─────────────────────────────────────────────────────────

    /**
     * xdotool-style sequence e.g. "ctrl+shift+a" → split on '+' and pass to
     * keys(). keys() dispatches to DispatchQueue.main — drainRunLoop pumps
     * CFRunLoop so it resolves. Rust's error-path cleanup (enigo_wrap.rs)
     * releases modifiers on each invocation, so a mid-loop throw leaves
     * nothing stuck. 8ms between iterations — 125Hz USB polling cadence.
     */
    async key(keySequence: string, repeat?: number): Promise<void> {
      const input = requireComputerUseInput()
      const parts = keySequence.split('+').filter(p => p.length > 0)
      // Bare-only: the CGEventTap checks event.flags.isEmpty so ctrl+escape
      // etc. pass through without aborting.
      const isEsc = isBareEscape(parts)
      const n = repeat ?? 1
      await drainRunLoop(async () => {
        for (let i = 0; i < n; i++) {
          if (i > 0) {
            await sleep(8)
          }
          if (isEsc) {
            notifyExpectedEscape()
          }
          await input.keys(parts)
        }
      })
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      const input = requireComputerUseInput()
      // Press/release each wrapped in drainRunLoop; the sleep sits outside so
      // durationMs isn't bounded by drainRunLoop's 30s timeout. `pressed`
      // tracks which presses landed so a mid-press throw still releases
      // everything that was actually pressed.
      //
      // `orphaned` guards against a timeout-orphan race: if the press-phase
      // drainRunLoop times out while the esc-hotkey pump-retain keeps the
      // pump running, the orphaned lambda would continue pushing to `pressed`
      // after finally's releasePressed snapshotted the length — leaving keys
      // stuck. The flag stops the lambda at the next iteration.
      const pressed: string[] = []
      let orphaned = false
      try {
        await drainRunLoop(async () => {
          for (const k of keyNames) {
            if (orphaned) return
            // Bare Escape: notify the CGEventTap so it doesn't fire the
            // abort callback for a model-synthesized press. Same as key().
            if (isBareEscape([k])) {
              notifyExpectedEscape()
            }
            await input.key(k, 'press')
            pressed.push(k)
          }
        })
        await sleep(durationMs)
      } finally {
        orphaned = true
        await drainRunLoop(() => releasePressed(input, pressed))
      }
    },

    async type(text: string, opts: { viaClipboard: boolean }): Promise<void> {
      const input = requireComputerUseInput()
      if (opts.viaClipboard) {
        // keys(['command','v']) inside needs the pump.
        await drainRunLoop(() => typeViaClipboard(input, text))
        return
      }
      // `toolCalls.ts` handles the grapheme loop + 8ms sleeps and calls this
      // once per grapheme. typeText doesn't dispatch to the main queue.
      await input.typeText(text)
    },

    readClipboard: readClipboardViaPbpaste,

    writeClipboard: writeClipboardViaPbcopy,

    // ── Mouse ────────────────────────────────────────────────────────────

    async moveMouse(x: number, y: number): Promise<void> {
      await moveAndSettle(requireComputerUseInput(), x, y)
    },

    /**
     * Move, then click. Modifiers are press/release bracketed via withModifiers
     * — same pattern as the upstream Electron app. AppKit computes NSEvent.clickCount from timing
     * + position proximity, so double/triple click work without setting the
     * CGEvent clickState field. key() inside withModifiers needs the pump;
     * the modifier-less path doesn't.
     */
    async click(
      x: number,
      y: number,
      button: 'left' | 'right' | 'middle',
      count: 1 | 2 | 3,
      modifiers?: string[],
    ): Promise<void> {
      const input = requireComputerUseInput()
      await moveAndSettle(input, x, y)
      if (modifiers && modifiers.length > 0) {
        await drainRunLoop(() =>
          withModifiers(input, modifiers, () =>
            input.mouseButton(button, 'click', count),
          ),
        )
      } else {
        await input.mouseButton(button, 'click', count)
      }
    },

    async mouseDown(): Promise<void> {
      await requireComputerUseInput().mouseButton('left', 'press')
    },

    async mouseUp(): Promise<void> {
      await requireComputerUseInput().mouseButton('left', 'release')
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return requireComputerUseInput().mouseLocation()
    },

    /**
     * `from === undefined` → drag from current cursor (training's
     * left_click_drag with start_coordinate omitted). Inner `finally`: the
     * button is ALWAYS released even if the move throws — otherwise the
     * user's left button is stuck-pressed until they physically click.
     * 50ms sleep after press: enigo's move_mouse reads NSEvent.pressedMouseButtons
     * to decide .leftMouseDragged vs .mouseMoved; the synthetic leftMouseDown
     * needs a HID-tap round-trip to show up there.
     */
    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      const input = requireComputerUseInput()
      if (from !== undefined) {
        await moveAndSettle(input, from.x, from.y)
      }
      await input.mouseButton('left', 'press')
      await sleep(MOVE_SETTLE_MS)
      try {
        await animatedMove(input, to.x, to.y, getMouseAnimationEnabled())
      } finally {
        await input.mouseButton('left', 'release')
      }
    },

    /**
     * Move first, then scroll each axis. Vertical-first — it's the common
     * axis; a horizontal failure shouldn't lose the vertical.
     */
    async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
      const input = requireComputerUseInput()
      await moveAndSettle(input, x, y)
      if (dy !== 0) {
        await input.mouseScroll(dy, 'vertical')
      }
      if (dx !== 0) {
        await input.mouseScroll(dx, 'horizontal')
      }
    },

    // ── App management ───────────────────────────────────────────────────

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      // The cross-platform port exposes this on cu.apps (osascript on mac,
      // PowerShell on windows). The sync ComputerUseInput.getFrontmostAppInfo
      // facade in compat/input.ts is a permanent null-stub we don't use.
      return cu.apps.getFrontmostApp()
    },

    async appUnderPoint(
      x: number,
      y: number,
    ): Promise<{ appIdentifier: string; displayName: string } | null> {
      return cu.apps.appUnderPoint(x, y)
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      return drainRunLoop(() => cu.apps.listInstalled())
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return cu.apps.listRunning()
    },

    async openApp(appIdentifier: string): Promise<void> {
      await cu.apps.open(appIdentifier)
    },

    async enumerateVisibleElements(rect, windowOnly?: boolean) {
      if (!cu.enumerateUiElementsInRect) return []
      const raw = await cu.enumerateUiElementsInRect(
        {
          origin: { x: Math.round(rect.x), y: Math.round(rect.y) },
          size: { w: Math.round(rect.w), h: Math.round(rect.h) },
        },
        windowOnly,
      )
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
        uiaSource: e.uiaSource ?? undefined,
      }))
    },

    async elementFromPoint(x: number, y: number) {
      if (!cu.elementFromPoint) return null
      const el = await cu.elementFromPoint(Math.round(x), Math.round(y))
      if (!el) return null
      return {
        name: el.name,
        role: el.role,
      }
    },
  }
}

/**
 * Module-level export (not on the executor object) — called at turn-end from
 * `stopHooks.ts` / `query.ts`, outside the executor lifecycle. Fire-and-forget
 * at the call site; the caller `.catch()`es.
 *
 * Cross-platform dispatch: mac → mac NAPI cu.apps.unhide (NSRunningApplication
 * unhide); win32 → win NAPI unhideApp per bundle (ShowWindow SW_SHOWNOACTIVATE).
 */
export async function unhideComputerUseApps(
  appIdentifiers: readonly string[],
): Promise<void> {
  if (appIdentifiers.length === 0) return
  if (process.platform === 'win32') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const winNapi = require('computer-use-win-napi-axiomate') as {
      unhideApp: (appIdentifier: string) => boolean
    }
    for (const appIdentifier of appIdentifiers) {
      try {
        const ok = winNapi.unhideApp(appIdentifier)
        logForDebugging(
          `[CU-HIDE] win unhideApp appIdentifier="${appIdentifier}" result=${ok}`,
          { level: 'debug' },
        )
      } catch (err) {
        // Best-effort — never let unhide failures wedge cleanup.
        logForDebugging(
          `[CU-HIDE] win unhideApp THREW for "${appIdentifier}": ${errorMessage(err)}`,
          { level: 'debug' },
        )
      }
    }
    return
  }
  const cu = requireComputerUseSwift()
  await cu.apps.unhide([...appIdentifiers])
}
