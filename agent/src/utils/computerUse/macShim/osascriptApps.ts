/**
 * App management — macOS only. AppleScript / mdfind / plutil snippets used by
 * `swiftShim.ts` (createComputerUseSwift) when the mac NAPI binding isn't
 * loaded, and by `inputShim.ts` for `getFrontmostAppInfo`.
 *
 * Phase D2 moved this file from `computer-use-native-axiomate/src/platforms/`
 * (cross-platform with win32 / linux branches). Phase E stripped those —
 * macShim/ is mac-only territory; Win uses winFallbacks.ts + win NAPI.
 */

import { execSync, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface AppInfo {
  bundleId: string
  displayName: string
  path?: string
}

// ── Frontmost app ─────────────────────────────────────────────────────────

export async function getFrontmostApp(): Promise<AppInfo | null> {
  try {
    const script =
      'tell application "System Events" to get {bundle identifier, name} of first application process whose frontmost is true'
    const out = execSync(`osascript -e '${script}'`, { encoding: 'utf-8' }).trim()
    const [bundleId, name] = out.split(', ')
    if (bundleId && name) return { bundleId, displayName: name }
  } catch {
    // osascript missing / no frontmost (lock screen, secure desktop)
  }
  return null
}

// ── List running apps ─────────────────────────────────────────────────────

export async function listRunningApps(): Promise<AppInfo[]> {
  try {
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
  } catch {
    return []
  }
}

// ── Open app ──────────────────────────────────────────────────────────────

export async function openApp(bundleIdOrName: string): Promise<void> {
  // Try `open -b` (bundle id) first, falling back to `open -a` (name) so
  // either of `com.apple.finder` / `Finder` works.
  execSync(`open -b "${bundleIdOrName}" 2>/dev/null || open -a "${bundleIdOrName}"`)
}

// ── List installed apps ───────────────────────────────────────────────────

export async function listInstalledApps(): Promise<Array<AppInfo & { path: string }>> {
  return listInstalledMacOS()
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
  // The mac NAPI binding (computer-use-mac-napi-axiomate) provides the real
  // CGWindowListCopyWindowInfo hit-test; this stub is the fallback when the
  // binding isn't loaded (returns null → click safety gate degrades to
  // frontmost-only check, see toolCalls.ts:runHitTestGate).
  return null
}
