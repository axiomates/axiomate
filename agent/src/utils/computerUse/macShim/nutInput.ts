/**
 * Keyboard and mouse input using @nut-tree-fork/nut-js — macOS only.
 *
 * Phase D2 moved this from `computer-use-native-axiomate/src/input.ts`
 * (cross-platform). Phase E stripped the headless-display guard — Win uses
 * Win NAPI SendInput direct (not nut.js, which silent-failed in Bun-compiled
 * exes). Mac always has a display, so loading nut.js is unconditional;
 * any load failure surfaces as a normal require() throw.
 */

import { createRequire } from 'node:module'

type NutJS = typeof import('@nut-tree-fork/nut-js')

let _nut: NutJS | null = null

function nut(): NutJS {
  if (_nut) return _nut
  const req = createRequire(import.meta.url)
  _nut = req('@nut-tree-fork/nut-js')
  return _nut!
}

// ── Mouse ──────────────────────────────────────────────────────────────────

export async function moveMouse(x: number, y: number): Promise<void> {
  const { mouse, Point } = nut()
  await mouse.setPosition(new Point(x, y))
}

export async function click(
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  count: 1 | 2 | 3,
  modifiers?: string[],
): Promise<void> {
  const { mouse, keyboard, Point, Button } = nut()
  await mouse.setPosition(new Point(x, y))

  const btn = button === 'right' ? Button.RIGHT : button === 'middle' ? Button.MIDDLE : Button.LEFT

  if (modifiers && modifiers.length > 0) {
    const keys = modifiers.map(mapKeyName).filter((k): k is number => k !== null)
    for (const k of keys) await keyboard.pressKey(k)
    for (let i = 0; i < count; i++) await mouse.click(btn)
    for (const k of keys.reverse()) await keyboard.releaseKey(k)
  } else {
    for (let i = 0; i < count; i++) await mouse.click(btn)
  }
}

export async function mouseDown(): Promise<void> {
  const { mouse, Button } = nut()
  await mouse.pressButton(Button.LEFT)
}

export async function mouseUp(): Promise<void> {
  const { mouse, Button } = nut()
  await mouse.releaseButton(Button.LEFT)
}

export async function getCursorPosition(): Promise<{ x: number; y: number }> {
  const { mouse } = nut()
  const pos = await mouse.getPosition()
  return { x: pos.x, y: pos.y }
}

export async function drag(
  from: { x: number; y: number } | undefined,
  to: { x: number; y: number },
): Promise<void> {
  const { mouse, straightTo, Point, Button } = nut()
  if (from) {
    await mouse.setPosition(new Point(from.x, from.y))
  }
  await mouse.pressButton(Button.LEFT)
  await mouse.move(straightTo(new Point(to.x, to.y)))
  await mouse.releaseButton(Button.LEFT)
}

export async function scroll(
  x: number,
  y: number,
  dx: number,
  dy: number,
): Promise<void> {
  const { mouse, Point } = nut()
  await mouse.setPosition(new Point(x, y))
  if (dy !== 0) await mouse.scrollDown(dy > 0 ? dy : -dy)
  if (dx !== 0) await mouse.scrollRight(dx > 0 ? dx : -dx)
}

// ── Keyboard ───────────────────────────────────────────────────────────────

export async function pressKey(keySequence: string, repeat?: number): Promise<void> {
  const { keyboard } = nut()
  const parts = keySequence.split('+').filter(p => p.length > 0)
  const keys = parts.map(mapKeyName).filter((k): k is number => k !== null)

  const n = repeat ?? 1
  for (let i = 0; i < n; i++) {
    if (keys.length === 1) {
      await keyboard.pressKey(keys[0]!)
      await keyboard.releaseKey(keys[0]!)
    } else {
      for (const k of keys) await keyboard.pressKey(k)
      for (const k of [...keys].reverse()) await keyboard.releaseKey(k)
    }
  }
}

export async function holdKey(keyNames: string[], durationMs: number): Promise<void> {
  const { keyboard } = nut()
  const keys = keyNames.map(mapKeyName).filter((k): k is number => k !== null)
  for (const k of keys) await keyboard.pressKey(k)
  await new Promise(resolve => setTimeout(resolve, durationMs))
  for (const k of [...keys].reverse()) await keyboard.releaseKey(k)
}

export async function typeText(text: string): Promise<void> {
  const { keyboard } = nut()
  await keyboard.type(text)
}

// ── Key name mapping (lazy — Key enum accessed only at call time) ──────────

let _keyMap: Record<string, number> | null = null

function getKeyMap(): Record<string, number> {
  if (_keyMap) return _keyMap
  const { Key } = nut()
  _keyMap = {
    command: Key.LeftCmd, cmd: Key.LeftCmd, meta: Key.LeftCmd, super: Key.LeftCmd,
    control: Key.LeftControl, ctrl: Key.LeftControl,
    alt: Key.LeftAlt, option: Key.LeftAlt,
    shift: Key.LeftShift,
    return: Key.Return, enter: Key.Return,
    tab: Key.Tab,
    escape: Key.Escape, esc: Key.Escape,
    space: Key.Space,
    backspace: Key.Backspace,
    delete: Key.Delete,
    up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
    f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4,
    f5: Key.F5, f6: Key.F6, f7: Key.F7, f8: Key.F8,
    f9: Key.F9, f10: Key.F10, f11: Key.F11, f12: Key.F12,
    home: Key.Home, end: Key.End, pageup: Key.PageUp, pagedown: Key.PageDown,
  }
  return _keyMap
}

function mapKeyName(name: string): number | null {
  const lower = name.toLowerCase()
  const keyMap = getKeyMap()
  if (keyMap[lower] !== undefined) return keyMap[lower]!

  if (lower.length === 1) {
    const { Key } = nut()
    const key = (Key as any)[lower.toUpperCase()]
    if (key !== undefined) return key
  }

  return null
}
