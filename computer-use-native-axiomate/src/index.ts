export { createExecutor } from './executor.js'
export { isNativeDisplayAvailable } from './detect-display.js'
export * from './screenshot.js'
export * from './input.js'
export * from './platforms/apps.js'

// Compatibility layers for @ant/computer-use-input and @ant/computer-use-swift
export { createComputerUseInput } from './compat/input.js'
export { createComputerUseSwift } from './compat/swift.js'

// ---------------------------------------------------------------------------
// Type definitions for the original @ant/computer-use-input & @ant/computer-use-swift
// native module interfaces. These are consumed by the agent's loader/executor code.
// ---------------------------------------------------------------------------

/** API surface of the @ant/computer-use-input Rust NAPI module (macOS) */
export interface ComputerUseInputAPI {
  moveMouse(x: number, y: number, animate?: boolean): Promise<void>
  key(key: string, action: 'press' | 'release'): Promise<void>
  keys(keys: string[]): Promise<void>
  typeText(text: string): Promise<void>
  mouseButton(button: string, action: 'click' | 'press' | 'release', count?: number): Promise<void>
  mouseLocation(): Promise<{ x: number; y: number }>
  mouseScroll(amount: number, direction: 'vertical' | 'horizontal'): Promise<void>
  getFrontmostAppInfo(): { bundleId: string; appName: string; name: string; pid: number } | null
}

/** Discriminated union: the module may or may not be supported on this platform */
export type ComputerUseInput =
  | ({ isSupported: true } & ComputerUseInputAPI)
  | { isSupported: false }

/** API surface of the @ant/computer-use-swift Swift NAPI module (macOS).
 *  This is a complex native module with many methods — we type the known ones
 *  and use [key: string]: any for the rest to allow compilation. */
export interface ComputerUseAPI {
  hotkey: {
    register(callback: () => void): void
    registerEscape(callback: () => void): any
    unregister(): void
    notifyExpectedEscape(): void
    [key: string]: any
  }
  apps: {
    listInstalled(): Promise<any[]>
    listRunning(): Promise<any[]>
    getFrontmostApp(): Promise<{ bundleId: string; displayName: string } | null>
    prepareDisplay(...args: any[]): any
    previewHideSet(...args: any[]): any
    findWindowDisplays(...args: any[]): any
    appUnderPoint(...args: any[]): any
    open(...args: any[]): any
    unhide(...args: any[]): any
    [key: string]: any
  }
  display: {
    captureExcluding(...args: any[]): any
    captureRegion(...args: any[]): any
    getSize(...args: any[]): any
    listAll(...args: any[]): any
    [key: string]: any
  }
  screenshot: {
    capture(...args: any[]): any
    captureExcluding(...args: any[]): any
    captureRegion(...args: any[]): any
    [key: string]: any
  }
  tcc: {
    checkScreenRecording(): boolean
    checkAccessibility(): boolean
    requestScreenRecording(): void
    [key: string]: any
  }
  captureExcluding(...args: any[]): any
  captureRegion(...args: any[]): any
  resolvePrepareCapture(...args: any[]): any
  /** Capture the frontmost window of `bundleId`. macOS-only — uses native
   *  CGWindowListCreateImage via the mac NAPI binding. Always returns an
   *  outcome: `image` is set on success, otherwise `diagnostic` describes
   *  which step failed (no running app / no on-screen window / TCC denied /
   *  fallback layer). The diagnostic is logged via logForDebugging on the
   *  agent side so failures show up in ~/.axiomate/debug/latest. */
  captureWindow?(bundleId: string): Promise<{
    image: { base64: string; width: number; height: number } | null
    diagnostic: string
  }>
  _drainMainRunLoop?(): void
  [key: string]: any
}
