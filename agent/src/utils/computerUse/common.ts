import { normalizeNameForMCP } from '../../services/mcp/normalization.js'
import { env } from '../env.js'

export const COMPUTER_USE_MCP_SERVER_NAME = 'computer-use'

export const BROWSER_BRIDGE_MCP_SERVER_NAME = 'browser-bridge'

/**
 * Sentinel app identifier for the frontmost gate. Axiomate is a terminal — it
 * has no window. This never matches a real `NSWorkspace.frontmostApplication`,
 * so the package's "host is frontmost" branch (mouse click-through exemption,
 * keyboard safety-net) is dead code for us. `prepareForAction`'s "exempt our
 * own window" is likewise a no-op — there is no window to exempt.
 */
export const CLI_HOST_APP_IDENTIFIER = 'com.axiomate.cli-no-window'

/**
 * Fallback `env.terminal` → CFBundleIdentifier map for when
 * `__CFBundleIdentifier` is unset. Covers the macOS terminals we can
 * distinguish — Linux entries (konsole, gnome-terminal, xterm) are
 * deliberately absent since `createCliExecutor` is darwin-guarded.
 */
const TERMINAL_APP_IDENTIFIER_FALLBACK: Readonly<Record<string, string>> = {
  'iTerm.app': 'com.googlecode.iterm2',
  Apple_Terminal: 'com.apple.Terminal',
  ghostty: 'com.mitchellh.ghostty',
  kitty: 'net.kovidgoyal.kitty',
  WarpTerminal: 'dev.warp.Warp-Stable',
  vscode: 'com.microsoft.VSCode',
}

/**
 * App identifier (CFBundleIdentifier on macOS) of the terminal emulator we're
 * running inside, so `prepareDisplay` can exempt it from hiding and
 * `captureExcluding` can keep it out of screenshots. Returns null when
 * undetectable (ssh, cleared env, unknown terminal) — caller must handle the
 * null case.
 *
 * `__CFBundleIdentifier` is set by LaunchServices when a .app bundle spawns a
 * process and is inherited by children. It's the exact CFBundleIdentifier, no
 * lookup needed — handles terminals the fallback table doesn't know about.
 * Under tmux/screen it reflects the terminal that started the SERVER, which
 * may differ from the attached client. That's harmless here: we exempt A
 * terminal window, and the screenshots exclude it regardless.
 */
export function getTerminalAppIdentifier(): string | null {
  const cfBundleId = process.env.__CFBundleIdentifier
  if (cfBundleId) return cfBundleId
  return TERMINAL_APP_IDENTIFIER_FALLBACK[env.terminal ?? ''] ?? null
}

/**
 * Static capabilities for the macOS CLI executor. `hostAppIdentifier` is
 * not here — `executor.ts` adds it per-instance (`ComputerExecutor.
 * capabilities`). `buildComputerUseTools` takes this shape.
 *
 * `screenshotFiltering: 'none'` reflects current state — SCContentFilter
 * binding in computer-use-mac-napi-axiomate's lib.rs is still a stub
 * (`Ok(None)`). Full-screen screenshot via node-screenshots is unfiltered.
 * Specific-window capture goes through the separate `screenshot_window`
 * tool (osascript + screencapture -l). Flip back to `'native'` when
 * SCContentFilter is wired and capable of compositor-level filtering.
 */
export const MAC_CLI_CAPABILITIES = {
  screenshotFiltering: 'none' as const,
  platform: 'darwin' as const,
}

/**
 * Static capabilities for the Windows CLI executor. Mirrors the mac shape
 * but no `hostAppIdentifier` — Win deliberately doesn't have a "host
 * sentinel" concept because `defocusSelfToPreviousForeground` pushes
 * axiomate's terminal to background before keyboard input lands, so the
 * frontmost-app safety gate never fires on the terminal naturally.
 * (mac needs a sentinel to skip its hide loop.)
 *
 * `screenshotFiltering: 'none'` is permanent on Win — there's no Windows
 * compositor allowlist (Win11 WGC could provide one but Stage 3 is still
 * skeleton). Full-screen capture is unfiltered; per-window capture via
 * `screenshot_window` (PrintWindow + PW_RENDERFULLCONTENT).
 */
export const WIN_CLI_CAPABILITIES = {
  screenshotFiltering: 'none' as const,
  platform: 'win32' as const,
}

export function isComputerUseMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === COMPUTER_USE_MCP_SERVER_NAME
}
