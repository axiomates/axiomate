import { logForDebugging } from '../debug.js'
import { releasePump, retainPump } from './drainRunLoop.js'
import { requireComputerUseSwift } from './swiftLoader.js'

/**
 * Global Escape → abort. Mirrors the upstream Electron `escAbort.ts` but without Electron:
 * CGEventTap via `computer-use-native-axiomate`. While registered, Escape is
 * consumed system-wide (PI defense — a prompt-injected action can't dismiss
 * a dialog with Escape).
 *
 * Lifecycle: register on fresh lock acquire (`wrapper.tsx` `acquireCuLock`),
 * unregister on lock release (`cleanup.ts`). The tap's CFRunLoopSource sits
 * in .defaultMode on CFRunLoopGetMain(), so we hold a drainRunLoop pump
 * retain for the registration's lifetime — same refcounted setInterval as
 * the `@MainActor` methods.
 *
 * `notifyExpectedEscape()` punches a hole for model-synthesized Escapes: the
 * executor's `key("escape")` calls it before posting the CGEvent. Swift
 * schedules a 100ms decay so a CGEvent that never reaches the tap callback
 * doesn't eat the next user ESC.
 */

let registered = false

// mac-only feature. Caller (wrapper.tsx) is expected to branch on platform
// and not call us on win. These guards are defense in depth: a future caller
// that forgets the platform check still gets a silent no-op instead of a
// `[cu-esc] registerEscape returned false` warn-log per CU action.
const IS_MAC = process.platform === 'darwin'

export function registerEscHotkey(onEscape: () => void): boolean {
  if (!IS_MAC) return false
  if (registered) return true
  const cu = requireComputerUseSwift()
  if (!cu.hotkey.registerEscape(onEscape)) {
    // CGEvent.tapCreate failed — typically missing Accessibility permission.
    // CU still works, just without ESC abort.
    logForDebugging('[cu-esc] registerEscape returned false', { level: 'warn' })
    return false
  }
  retainPump()
  registered = true
  logForDebugging('[cu-esc] registered')
  return true
}

export function unregisterEscHotkey(): void {
  if (!IS_MAC) return
  if (!registered) return
  try {
    requireComputerUseSwift().hotkey.unregister()
  } finally {
    releasePump()
    registered = false
    logForDebugging('[cu-esc] unregistered')
  }
}

export function notifyExpectedEscape(): void {
  if (!IS_MAC) return
  if (!registered) return
  requireComputerUseSwift().hotkey.notifyExpectedEscape()
}
