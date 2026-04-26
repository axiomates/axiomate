/**
 * Application management — platform-specific implementations.
 *
 * macOS: osascript / mdfind
 * Windows: PowerShell / WMI
 * Linux: wmctrl / xdotool / desktop files
 */

import { execSync, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface AppInfo {
  bundleId: string
  displayName: string
  path?: string
}

/** Encode a PowerShell script as base64 UTF-16LE for -EncodedCommand. */
function encodePsCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Run a PowerShell script via -EncodedCommand (avoids all quoting issues). */
function runPs(script: string): string {
  const encoded = encodePsCommand(script)
  return execSync(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr from appearing in console
  }).trim()
}

// ── Frontmost app ─────────────────────────────────────────────────────────

export async function getFrontmostApp(): Promise<AppInfo | null> {
  try {
    if (process.platform === 'darwin') {
      const script =
        'tell application "System Events" to get {bundle identifier, name} of first application process whose frontmost is true'
      const out = execSync(`osascript -e '${script}'`, { encoding: 'utf-8' }).trim()
      const [bundleId, name] = out.split(', ')
      if (bundleId && name) return { bundleId, displayName: name }
    } else if (process.platform === 'win32') {
      // Pure PowerShell — no C# compilation (Add-Type) needed.
      // Get-Process with MainWindowHandle > 0 finds the foreground process.
      // This avoids csc.exe temp files, startup cost, and concurrency issues.
      const out = runPs(`
$fw = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Sort-Object -Property @{Expression={$_.Responding}; Descending=$true} | Select-Object -First 1
if ($fw) { $fw.ProcessName }
`)
      if (out) return { bundleId: out, displayName: out }
    } else {
      // Linux: xdotool
      const pid = execSync('xdotool getactivewindow getwindowpid', { encoding: 'utf-8' }).trim()
      if (pid) {
        const name = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf-8' }).trim()
        return { bundleId: name, displayName: name }
      }
    }
  } catch {
    // Tool not available or no window
  }
  return null
}

// ── List running apps ─────────────────────────────────────────────────────

export async function listRunningApps(): Promise<AppInfo[]> {
  try {
    if (process.platform === 'darwin') {
      // Iterate explicitly with try/end-try so processes with `missing value`
      // background-only / bundle-identifier (kernel helpers, some XPC services)
      // don't blow up the whole script with -1728 error.
      const scriptLines = [
        'tell application "System Events"',
        '  set ids to {}',
        '  set ns to {}',
        '  repeat with proc in (every application process)',
        '    try',
        '      if background only of proc is false then',
        '        set end of ids to bundle identifier of proc',
        '        set end of ns to name of proc',
        '      end if',
        '    end try',
        '  end repeat',
        '  return {ids, ns}',
        'end tell',
      ]
      const args: string[] = []
      for (const line of scriptLines) {
        args.push('-e', line)
      }
      const out = execFileSync('osascript', args, { encoding: 'utf-8' }).trim()
      // AppleScript flattens {ids, ns} → "id1, id2, ..., name1, name2, ..."
      const parts = out.split(', ')
      const half = Math.floor(parts.length / 2)
      const ids = parts.slice(0, half)
      const names = parts.slice(half)
      return ids.map((id, i) => ({ bundleId: id!, displayName: names[i] ?? id! }))
    } else if (process.platform === 'win32') {
      const out = runPs(`
$procs = Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object ProcessName
$procs | ConvertTo-Json -Compress
`)
      if (!out) return []
      let parsed: any
      try {
        parsed = JSON.parse(out)
      } catch {
        return []
      }
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list
        .filter((p: any) => p && p.ProcessName)
        .map((p: any) => ({ bundleId: p.ProcessName, displayName: p.ProcessName }))
    } else {
      const out = execSync('wmctrl -l -p 2>/dev/null || xdotool search --onlyvisible --name "" 2>/dev/null', {
        encoding: 'utf-8',
      }).trim()
      return out
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const name = line.split(/\s+/).slice(4).join(' ') || 'unknown'
          return { bundleId: name, displayName: name }
        })
    }
  } catch {
    return []
  }
}

// ── Open app ──────────────────────────────────────────────────────────────

export async function openApp(bundleIdOrName: string): Promise<void> {
  if (process.platform === 'darwin') {
    execSync(`open -b "${bundleIdOrName}" 2>/dev/null || open -a "${bundleIdOrName}"`)
  } else if (process.platform === 'win32') {
    runPs(`Start-Process "${bundleIdOrName}"`)
  } else {
    execSync(`xdg-open "${bundleIdOrName}" 2>/dev/null || "${bundleIdOrName}" &`)
  }
}

// ── List installed apps ───────────────────────────────────────────────────

export async function listInstalledApps(): Promise<Array<AppInfo & { path: string }>> {
  if (process.platform === 'darwin') {
    return listInstalledMacOS()
  }
  // Windows / Linux still TODO:
  //   Windows: Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*
  //   Linux:   parse .desktop files in /usr/share/applications/
  return []
}

/**
 * Enumerate /Applications + ~/Applications + system app dirs via Spotlight,
 * then read each .app's Info.plist for bundleId + display name. Parallel
 * plutil calls bound to PLIST_CONCURRENCY so we don't fork-bomb on machines
 * with hundreds of apps installed.
 *
 * Typical timing: mdfind ~100ms, plist read N × 50ms / 16 concurrency
 * ≈ 700-800ms for 200 apps. Caller's timeout should accommodate this.
 */
const PLIST_CONCURRENCY = 16

async function listInstalledMacOS(): Promise<Array<AppInfo & { path: string }>> {
  let findStdout: string
  try {
    const { stdout } = await execFileP(
      'mdfind',
      ['kMDItemContentType == "com.apple.application-bundle"'],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    findStdout = stdout
  } catch {
    return []
  }

  const paths = findStdout
    .split('\n')
    .map(p => p.trim())
    .filter(Boolean)
  if (paths.length === 0) return []

  const results: Array<AppInfo & { path: string }> = []
  for (let i = 0; i < paths.length; i += PLIST_CONCURRENCY) {
    const batch = paths.slice(i, i + PLIST_CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async appPath => {
        const plistPath = `${appPath}/Contents/Info.plist`
        const { stdout } = await execFileP(
          'plutil',
          ['-convert', 'json', '-o', '-', plistPath],
          { maxBuffer: 1024 * 1024 },
        )
        const info = JSON.parse(stdout) as Record<string, unknown>
        const bundleId =
          typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : ''
        if (!bundleId) return null
        const displayName =
          (typeof info.CFBundleDisplayName === 'string' && info.CFBundleDisplayName) ||
          (typeof info.CFBundleName === 'string' && info.CFBundleName) ||
          appPath.split('/').pop()?.replace(/\.app$/, '') ||
          bundleId
        return { bundleId, displayName, path: appPath }
      }),
    )
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value)
      }
    }
  }

  // Same bundleId can show up in /Applications and ~/Applications. Keep first.
  const seen = new Set<string>()
  return results.filter(a => {
    if (seen.has(a.bundleId)) return false
    seen.add(a.bundleId)
    return true
  })
}

// ── App under point (stub) ────────────────────────────────────────────────

export async function appUnderPoint(
  _x: number,
  _y: number,
): Promise<AppInfo | null> {
  // TODO: platform-specific window-at-point detection
  return null
}
