/**
 * Windows non-NAPI fallbacks for `winExecutor.ts`. These are the bits that
 * winExecutor falls through to when its primary `computer-use-win-napi-axiomate`
 * binding can't satisfy a call (display geometry, clipboard write, openApp,
 * frontmost-app probe via PowerShell, etc.) — or simply doesn't expose that
 * function (display enumeration is via `node-screenshots`, not Win NAPI).
 *
 * History: this code used to live in `computer-use-native-axiomate/src/`
 * as the cross-platform `createExecutor()`'s body. Phase D1 dropped that
 * package's `createExecutor` from the Win path and inlined only the parts
 * Win actually exercises here, so the agent owns its own platform glue
 * symmetrically with `winExecutor.ts` ↔ `winNapi`.
 *
 * Import structure parallels the Win NAPI side:
 *   - `node-screenshots` for display info + JPEG capture (pure NAPI, works
 *     on Win without further deps)
 *   - `powershell.exe Set-Clipboard` via execSync stdin for clipboard write
 *     (clipboard-axiomate workspace package handles read only)
 *   - `child_process.execSync` with PowerShell `-EncodedCommand` for app
 *     management (frontmost / listRunning / openApp). The encoded form
 *     avoids all shell-quoting risk for arbitrary bundle ids / app names.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import type { DisplayGeometry, ScreenshotResult, ResolvePrepareCaptureResult } from 'computer-use-mcp-axiomate'

// ─── node-screenshots loader ──────────────────────────────────────────────

type MonitorType = import('node-screenshots').Monitor
type MonitorClass = typeof import('node-screenshots').Monitor

let _MonitorClass: MonitorClass | null = null

function getMonitorClass(): MonitorClass {
  if (_MonitorClass) return _MonitorClass
  // createRequire works around ESM's no-import-of-.node restriction.
  // node-screenshots ships a native binding that load via the package's
  // own loader; we just need its `Monitor` export.
  const req = createRequire(import.meta.url)
  const mod = req('node-screenshots')
  _MonitorClass = mod.Monitor
  return _MonitorClass!
}

// ─── Display info ─────────────────────────────────────────────────────────
// node-screenshots returns physical-pixel coords on Windows (different from
// macOS/Linux). We normalize to logical (DIP) for the agent layer, which
// always works in DIP space — winExecutor multiplies by scaleFactor at the
// SetCursorPos boundary.

function monitorToDisplay(m: MonitorType): DisplayGeometry & { physicalWidth: number; physicalHeight: number } {
  const scale = m.scaleFactor()
  const physW = m.width()    // physical px on Win
  const physH = m.height()
  const logW = Math.round(physW / scale)
  const logH = Math.round(physH / scale)
  const logX = Math.round(m.x() / scale)
  const logY = Math.round(m.y() / scale)
  return {
    displayId: m.id(),
    width: logW,
    height: logH,
    scaleFactor: scale,
    originX: logX,
    originY: logY,
    isPrimary: m.isPrimary(),
    label: m.name() || `Display ${m.id()}`,
    physicalWidth: physW,
    physicalHeight: physH,
  }
}

export function listWinDisplays(): DisplayGeometry[] {
  return getMonitorClass().all().map(m => {
    const { physicalWidth: _pw, physicalHeight: _ph, ...geom } = monitorToDisplay(m)
    return geom
  })
}

export function getWinDisplaySize(displayId?: number): DisplayGeometry & { physicalWidth: number; physicalHeight: number } {
  const monitors = getMonitorClass().all()
  if (displayId !== undefined) {
    const m = monitors.find(m => m.id() === displayId)
    if (m) return monitorToDisplay(m)
  }
  const primary = monitors.find(m => m.isPrimary()) ?? monitors[0]
  if (!primary) throw new Error('No displays found')
  return monitorToDisplay(primary)
}

// ─── Screenshot fallbacks ─────────────────────────────────────────────────
// Used when winNapi.captureDisplayScaled returns null (rare — typically
// transient GDI failure during session lock / DWM restart). Falls back to
// full-screen node-screenshots JPEG without resize.

export async function winFallbackScreenshot(opts: {
  allowedBundleIds: string[]
  displayId?: number
}): Promise<ScreenshotResult> {
  const display = getWinDisplaySize(opts.displayId)
  const monitor = getMonitorClass().all().find(m => m.id() === display.displayId)
  if (!monitor) throw new Error(`Display ${display.displayId} not found in fallback path`)
  const image = await monitor.captureImage()
  const jpeg = await image.toJpeg()
  return {
    base64: Buffer.from(jpeg).toString('base64'),
    width: image.width,
    height: image.height,
    displayId: display.displayId,
    displayWidth: display.width,
    displayHeight: display.height,
  }
}

export async function winFallbackResolvePrepareCapture(opts: {
  allowedBundleIds: string[]
  preferredDisplayId?: number
  autoResolve: boolean
  doHide?: boolean
}): Promise<ResolvePrepareCaptureResult> {
  const display = getWinDisplaySize(opts.preferredDisplayId)
  const shot = await winFallbackScreenshot({
    allowedBundleIds: opts.allowedBundleIds,
    displayId: display.displayId,
  })
  return {
    displayId: display.displayId,
    base64: shot.base64,
    width: shot.width,
    height: shot.height,
    hidden: [],
    displayWidth: display.width,
    displayHeight: display.height,
    originX: display.originX,
    originY: display.originY,
  }
}

/**
 * Capture a region of a display's screenshot. Coordinates are relative to
 * the display's screenshot image (0,0 = top-left of that display). Used by
 * the `zoom` tool to inspect small UI details after a full-screen capture.
 */
export async function winFallbackZoom(
  region: { x: number; y: number; w: number; h: number },
  displayId?: number,
): Promise<{ base64: string; width: number; height: number }> {
  const monitors = getMonitorClass().all()
  let monitor: MonitorType | undefined
  if (displayId !== undefined) {
    monitor = monitors.find(m => m.id() === displayId)
  }
  if (!monitor) {
    monitor = monitors.find(m => m.isPrimary()) ?? monitors[0]
  }
  if (!monitor) throw new Error('No displays found')
  const image = await monitor.captureImage()
  const cropped = await image.crop(region.x, region.y, region.w, region.h)
  const jpeg = await cropped.toJpeg()
  return {
    base64: Buffer.from(jpeg).toString('base64'),
    width: cropped.width,
    height: cropped.height,
  }
}

// ─── PowerShell helper ────────────────────────────────────────────────────
// -EncodedCommand takes UTF-16LE base64. Passing arbitrary script through
// stdin / -Command is fragile because of cmd.exe's quoting rules + the
// nested cases (path with quotes, etc.). Encoded form is the canonical
// PowerShell answer.

function encodePsCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function runPs(script: string): string {
  const encoded = encodePsCommand(script)
  return execSync(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

// ─── App management fallbacks ─────────────────────────────────────────────
// winNapi has its own implementations (registry walk / WindowFromPoint /
// EnumWindows etc.). These are only hit when napi isn't available OR for
// methods winNapi doesn't expose (the ones below).

export interface FrontmostInfo {
  bundleId: string
  displayName: string
}

export function winFallbackGetFrontmostApp(): FrontmostInfo | null {
  try {
    const out = runPs(`
$fw = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Sort-Object -Property @{Expression={$_.Responding}; Descending=$true} | Select-Object -First 1
if ($fw) { $fw.ProcessName }
`)
    if (out) return { bundleId: out, displayName: out }
  } catch {
    // PowerShell missing / blocked — degrade to null
  }
  return null
}

export function winFallbackListRunningApps(): FrontmostInfo[] {
  try {
    const out = runPs(`
$procs = Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object ProcessName
$procs | ConvertTo-Json -Compress
`)
    if (!out) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(out)
    } catch {
      return []
    }
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const out2: FrontmostInfo[] = []
    for (const p of list) {
      if (p && typeof p === 'object' && 'ProcessName' in p) {
        const name = String((p as Record<string, unknown>).ProcessName)
        if (name) out2.push({ bundleId: name, displayName: name })
      }
    }
    return out2
  } catch {
    return []
  }
}

export function winInlineOpenApp(bundleIdOrName: string): void {
  // bundleIdOrName on Windows is either a full exe path (returned by
  // winNapi.listInstalledApps) or a display-name shortcut (App Paths
  // registry resolves "chrome" → real path). Start-Process handles both.
  // The PowerShell string interpolation here is safe because runPs uses
  // -EncodedCommand which doesn't go through cmd.exe quoting.
  try {
    runPs(`Start-Process "${bundleIdOrName.replace(/"/g, '`"')}"`)
  } catch (err) {
    // PowerShell's stderr comes back as CLIXML — a `<Objs>...</Objs>` blob
    // with the actual error string buried in `<S S="Error">...</S>` tags.
    // Bubbling that up to the AI as a tool error gives it ~2KB of XML it
    // can't parse. Translate to plain prose with an actionable hint so
    // the model can self-correct (re-call list_installed_apps, etc).
    const raw = err instanceof Error ? err.message : String(err)
    if (/cannot find the file/i.test(raw)) {
      throw new Error(
        `Could not launch "${bundleIdOrName}" — neither registry walk, Get-StartApps, nor PATH/App-Paths resolved it. ` +
          `Try the app's friendly name (e.g. "Calculator", "Chrome"), the full executable path ` +
          `(e.g. "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), or a UWP launcher URI ` +
          `("shell:AppsFolder\\<AppID>"). For not-yet-running apps with unknown ids, open the Start menu ` +
          `via key("win") and type the name.`,
      )
    }
    // Other failures: keep the first meaningful line of the raw output,
    // drop the CLIXML noise.
    const firstLine = raw.split(/\r?\n/).find(l => l.trim()) ?? 'unknown error'
    throw new Error(
      `Start-Process failed for "${bundleIdOrName}": ${firstLine}`,
    )
  }
}

// ─── Start menu / UWP enumeration ────────────────────────────────────────
//
// `Get-StartApps` is the canonical way to enumerate everything in the Start
// menu — both classic shortcuts and UWP / Microsoft Store apps — with stable
// AppIDs. UWP entries have an AppID like
//     Microsoft.WindowsCalculator_8wekyb3d8bbwe!App
// (PackageFamilyName + ! + ApplicationId from the manifest). Those can be
// launched via `Start-Process "shell:AppsFolder\<AppID>"`.
//
// Classic Start menu shortcuts have AppIDs like
//     {GUID}\Some Shortcut.lnk
// which we filter out — `winNapi.listInstalledApps` already covers classic
// apps via the Uninstall registry walk, with full exe paths.
//
// Special protocol entries (`MSEdge`, `MicrosoftEdge`, `RealEnvironments` …)
// are also filtered out — they're protocol stubs, not real launchable apps.

export interface StartMenuApp {
  /** Friendly display name from the Start menu. */
  name: string
  /** AppID — for UWP this is `<PackageFamilyName>!<AppID>` and the canonical
   *  launcher form is `shell:AppsFolder\<AppID>`. */
  appId: string
  /** Whether this is a UWP / Microsoft Store app (AppID contains `!`). */
  isUwp: boolean
}

/**
 * Enumerate Start menu entries via PowerShell Get-StartApps.
 * Cost: ~200-500ms first call (powershell startup); cached for the process
 * lifetime since installed apps don't change mid-CU-session.
 *
 * Returns only UWP entries (filters out classic .lnk shortcuts and protocol
 * stubs). Classic apps are already enumerated via winNapi.listInstalledApps.
 */
let _startMenuCache: StartMenuApp[] | null = null

export function winListStartMenuApps(): StartMenuApp[] {
  if (_startMenuCache !== null) return _startMenuCache
  try {
    const out = runPs(`Get-StartApps | ConvertTo-Json -Compress`)
    if (!out) {
      _startMenuCache = []
      return _startMenuCache
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(out)
    } catch {
      _startMenuCache = []
      return _startMenuCache
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    const apps: StartMenuApp[] = []
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue
      const rec = x as Record<string, unknown>
      const name = rec.Name
      const appId = rec.AppID
      if (typeof name !== 'string' || typeof appId !== 'string') continue
      // Filter to only UWP entries — `!` is the PackageFamilyName separator.
      // Classic shortcuts (`.lnk`) and protocol stubs lack it.
      if (!appId.includes('!')) continue
      apps.push({ name, appId, isUwp: true })
    }
    _startMenuCache = apps
    return apps
  } catch {
    _startMenuCache = []
    return _startMenuCache
  }
}

// ─── Clipboard ────────────────────────────────────────────────────────────

export async function winFallbackReadClipboard(): Promise<string> {
  // clipboard-axiomate's readClipboardText handles the win NAPI fast path
  // + a powershell fallback internally. Returns null when no text is
  // present; we surface as empty string to match ComputerExecutor contract.
  try {
    const clip = await import('clipboard-axiomate')
    const text = await clip.readClipboardText()
    return text ?? ''
  } catch {
    return ''
  }
}

export function winFallbackWriteClipboard(text: string): void {
  // PowerShell `$input` automatic variable receives stdin, then Set-Clipboard
  // writes it. Passing through stdin avoids shell-quoting issues for
  // arbitrary text content (newlines, quotes, $ signs, etc.).
  // clipboard-axiomate handles read but not write — write needs PowerShell.
  execSync('powershell.exe -NoProfile -Command "Set-Clipboard -Value $input"', {
    input: text,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}
