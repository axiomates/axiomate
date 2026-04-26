/**
 * Cross-platform ComputerExecutor implementation.
 *
 * Wires together:
 *   - node-screenshots (display/screenshot)
 *   - @nut-tree/nut-js (keyboard/mouse)
 *   - platform-specific app management
 *   - clipboard-axiomate (clipboard)
 */

import type {
  ComputerExecutor,
  ComputerExecutorCapabilities,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from 'computer-use-mcp-axiomate'

import { execSync } from 'node:child_process'
import * as screenshot from './screenshot.js'
import * as input from './input.js'
import * as apps from './platforms/apps.js'

async function readFromClipboard(): Promise<string> {
  try {
    const clip = await import('clipboard-axiomate')
    const text = await clip.readClipboardText()
    return text ?? ''
  } catch {
    return ''
  }
}

async function writeToClipboard(text: string): Promise<void> {
  if (process.platform === 'darwin') {
    execSync('pbcopy', { input: text })
  } else if (process.platform === 'win32') {
    execSync('powershell.exe -Command "Set-Clipboard -Value $input"', { input: text })
  } else {
    execSync('xclip -selection clipboard', { input: text })
  }
}

/**
 * Convert screenshot-pixel coordinates to logical coordinates for nut.js.
 *
 * AI sees a screenshot of a specific display (physical pixels, e.g. 3840x2160).
 * Screenshot coordinates are relative to that display's top-left (0,0).
 * nut.js operates in the Windows virtual desktop logical coordinate system.
 *
 * Conversion: logical = screenshotPixel / scaleFactor + displayLogicalOrigin
 *
 * displayId identifies which display the screenshot came from. If not provided,
 * falls back to the primary display.
 */
function screenshotToLogical(x: number, y: number, displayId?: number): { x: number; y: number } {
  const display = screenshot.getDisplaySize(displayId)
  return {
    x: Math.round(x / display.scaleFactor + display.originX),
    y: Math.round(y / display.scaleFactor + display.originY),
  }
}

function displayInfoToGeometry(d: screenshot.DisplayInfo): DisplayGeometry {
  return {
    displayId: d.displayId,
    width: d.width,         // logical
    height: d.height,       // logical
    scaleFactor: d.scaleFactor,
    originX: d.originX,     // logical
    originY: d.originY,     // logical
    isPrimary: d.isPrimary,
    label: d.label,
  }
}

function getPlatformName(): string {
  switch (process.platform) {
    case 'darwin': return 'darwin'
    case 'win32': return 'win32'
    default: return 'linux'
  }
}

export function createExecutor(): ComputerExecutor {
  return {
    capabilities: {
      platform: getPlatformName(),
      screenshotFiltering: 'none', // node-screenshots doesn't support excluding apps
      hostBundleId: undefined,
    } satisfies ComputerExecutorCapabilities,

    // ── Display ────────────────────────────────────────────────────────

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      const d = screenshot.getDisplaySize(displayId)
      return displayInfoToGeometry(d)
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      return screenshot.listDisplays().map(displayInfoToGeometry)
    },

    async findWindowDisplays(
      _bundleIds: string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>> {
      // TODO: per-platform window-to-display mapping
      return []
    },

    // ── Screenshots ────────────────────────────────────────────────────

    async screenshot(opts: {
      allowedBundleIds: string[]
      displayId?: number
    }): Promise<ScreenshotResult> {
      const result = await screenshot.captureDisplay(opts.displayId)
      const display = screenshot.getDisplaySize(opts.displayId)
      return {
        base64: result.base64,
        width: result.width,           // physical pixels (image dimensions)
        height: result.height,         // physical pixels
        displayId: display.displayId,
        displayWidth: display.width,   // logical (for coordinate mapping)
        displayHeight: display.height, // logical
      }
    },

    async screenshotWindow(_bundleId: string): Promise<ScreenshotResult | null> {
      // Per-app window capture — macOS-only via `screencapture -l <CGWindowID>`.
      // The cross-platform executor in this workspace doesn't implement it
      // (no equivalent CLI on win/linux); the agent's CLI executor delegates
      // to compat/swift.ts:captureWindow which does the real work on darwin.
      return null
    },

    async zoom(
      region: { x: number; y: number; w: number; h: number },
      _allowedBundleIds: string[],
      displayId?: number,
    ): Promise<{ base64: string; width: number; height: number }> {
      return screenshot.captureRegion(region.x, region.y, region.w, region.h, displayId)
    },

    async resolvePrepareCapture(opts: {
      allowedBundleIds: string[]
      preferredDisplayId?: number
      autoResolve: boolean
      doHide?: boolean
    }): Promise<ResolvePrepareCaptureResult> {
      const display = screenshot.getDisplaySize(opts.preferredDisplayId)
      const result = await screenshot.captureDisplay(display.displayId)
      return {
        displayId: display.displayId,
        base64: result.base64,
        width: result.width,            // physical pixels
        height: result.height,          // physical pixels
        hidden: [],
        displayWidth: display.width,    // logical
        displayHeight: display.height,  // logical
        originX: display.originX,       // logical
        originY: display.originY,       // logical
      }
    },

    // ── Pre-action (no-op — we can't hide/unhide apps cross-platform) ─

    async prepareForAction(
      _allowlistBundleIds: string[],
      _displayId?: number,
    ): Promise<string[]> {
      return []
    },

    async previewHideSet(
      _allowlistBundleIds: string[],
      _displayId?: number,
    ): Promise<Array<{ bundleId: string; displayName: string }>> {
      return []
    },

    // ── Keyboard ────────────��──────────────────────────────────────────

    async key(keySequence: string, repeat?: number): Promise<void> {
      await input.pressKey(keySequence, repeat)
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      await input.holdKey(keyNames, durationMs)
    },

    async type(text: string, opts: { viaClipboard: boolean }): Promise<void> {
      if (opts.viaClipboard) {
        // Write to clipboard then paste
        try {
          await writeToClipboard(text)
          const mod = process.platform === 'darwin' ? 'command' : 'control'
          await input.pressKey(`${mod}+v`)
        } catch {
          await input.typeText(text)
        }
      } else {
        await input.typeText(text)
      }
    },

    // ── Mouse ───────────────────────────────────────────��──────────────

    async moveMouse(x: number, y: number): Promise<void> {
      const logical = screenshotToLogical(x, y)
      await input.moveMouse(logical.x, logical.y)
    },

    async click(
      x: number,
      y: number,
      button: 'left' | 'right' | 'middle',
      count: 1 | 2 | 3,
      modifiers?: string[],
    ): Promise<void> {
      const logical = screenshotToLogical(x, y)
      await input.click(logical.x, logical.y, button, count, modifiers)
    },

    async mouseDown(): Promise<void> {
      await input.mouseDown()
    },

    async mouseUp(): Promise<void> {
      await input.mouseUp()
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return input.getCursorPosition()
    },

    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      const logicalFrom = from ? screenshotToLogical(from.x, from.y) : undefined
      const logicalTo = screenshotToLogical(to.x, to.y)
      await input.drag(logicalFrom, logicalTo)
    },

    async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
      const logical = screenshotToLogical(x, y)
      await input.scroll(logical.x, logical.y, dx, dy)
    },

    // ── App management ─────────────────────────────────────────────────

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      const app = await apps.getFrontmostApp()
      return app ? { bundleId: app.bundleId, displayName: app.displayName } : null
    },

    async appUnderPoint(
      x: number,
      y: number,
    ): Promise<{ bundleId: string; displayName: string } | null> {
      return apps.appUnderPoint(x, y)
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      const list = await apps.listInstalledApps()
      return list.map(a => ({
        bundleId: a.bundleId,
        displayName: a.displayName,
        path: a.path,
      }))
    },

    async getAppIcon(_path: string): Promise<string | undefined> {
      // TODO: extract app icon per platform
      return undefined
    },

    async listRunningApps(): Promise<RunningApp[]> {
      const list = await apps.listRunningApps()
      return list.map(a => ({ bundleId: a.bundleId, displayName: a.displayName }))
    },

    async openApp(bundleId: string): Promise<void> {
      await apps.openApp(bundleId)
    },

    // ── Clipboard ────��─────────────────────────────────────────────────

    async readClipboard(): Promise<string> {
      return readFromClipboard()
    },

    async writeClipboard(text: string): Promise<void> {
      await writeToClipboard(text)
    },
  }
}
