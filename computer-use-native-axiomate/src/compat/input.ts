/**
 * Compatibility layer: wraps our cross-platform input functions into
 * the @ant/computer-use-input interface that agent code expects.
 *
 * Agent loads this via: require('computer-use-native-axiomate') as ComputerUseInput
 * Then narrows on isSupported and calls methods directly.
 */

import {
  moveMouse,
  click,
  mouseDown,
  mouseUp,
  getCursorPosition,
  pressKey,
  typeText,
  scroll,
} from '../input.js'
import { getFrontmostApp, type AppInfo } from '../platforms/apps.js'
import { isNativeDisplayAvailable } from '../detect-display.js'
import type { ComputerUseInputAPI } from '../index.js'

const inputAPI: ComputerUseInputAPI = {
  async moveMouse(x: number, y: number, _animate?: boolean): Promise<void> {
    await moveMouse(x, y)
  },

  async key(keyName: string, action: 'press' | 'release'): Promise<void> {
    // Our pressKey does full press+release cycle.
    // For 'press' we do the full cycle (best effort — atomic press/release
    // separation requires native CGEvent-level control we don't have).
    // For 'release' we no-op to avoid double-pressing.
    if (action === 'press') {
      await pressKey(keyName)
    }
    // 'release' is a no-op — pressKey already released
  },

  async keys(keyNames: string[]): Promise<void> {
    // Agent passes array like ['command', 'v']. Our pressKey takes 'command+v'.
    await pressKey(keyNames.join('+'))
  },

  async typeText(text: string): Promise<void> {
    await typeText(text)
  },

  async mouseButton(
    button: string,
    action: 'click' | 'press' | 'release',
    count?: number,
  ): Promise<void> {
    const pos = await getCursorPosition()
    const btn = (button === 'left' || button === 'right' || button === 'middle')
      ? button
      : 'left' as const

    if (action === 'click') {
      const n = (count === 1 || count === 2 || count === 3) ? count : 1
      await click(pos.x, pos.y, btn, n)
    } else if (action === 'press') {
      await mouseDown()
    } else if (action === 'release') {
      await mouseUp()
    }
  },

  async mouseLocation(): Promise<{ x: number; y: number }> {
    return getCursorPosition()
  },

  async mouseScroll(amount: number, direction: 'vertical' | 'horizontal'): Promise<void> {
    const pos = await getCursorPosition()
    if (direction === 'vertical') {
      await scroll(pos.x, pos.y, 0, amount)
    } else {
      await scroll(pos.x, pos.y, amount, 0)
    }
  },

  getFrontmostAppInfo(): { bundleId: string; appName: string; name: string; pid: number } | null {
    // Sync interface inherited from @ant/computer-use-input. axiomate's
    // executor.ts (post commit 1e2339d) routes through the async path
    // `cu.apps.getFrontmostApp()` instead of this sync method, so the
    // null return here is never observed via that path. Kept as a stub
    // for any other consumer that might still reach for the sync API.
    return null
  },
}

/**
 * Creates a ComputerUseInput object (discriminated union).
 * Returns { isSupported: true, ...methods } if display is available,
 * or { isSupported: false } otherwise.
 */
export function createComputerUseInput(): { isSupported: true } & ComputerUseInputAPI | { isSupported: false } {
  if (!isNativeDisplayAvailable()) {
    return { isSupported: false }
  }
  return { isSupported: true, ...inputAPI }
}
