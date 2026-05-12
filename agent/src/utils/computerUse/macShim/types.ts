/**
 * Type definitions for the macOS native shim layer.
 *
 * Originally from `computer-use-native-axiomate/src/index.ts`. Moved here as
 * part of Phase D2 — the cross-platform `computer-use-native-axiomate`
 * package was deleted; its mac-relevant TS shims live in agent now,
 * symmetric with `winFallbacks.ts` for the Win path.
 */

/** API surface of the @ant/computer-use-input Rust NAPI module (macOS) */
export interface ComputerUseInputAPI {
  moveMouse(x: number, y: number, animate?: boolean): Promise<void>
  key(key: string, action: 'press' | 'release'): Promise<void>
  keys(keys: string[]): Promise<void>
  typeText(text: string): Promise<void>
  mouseButton(button: string, action: 'click' | 'press' | 'release', count?: number): Promise<void>
  mouseLocation(): Promise<{ x: number; y: number }>
  mouseScroll(amount: number, direction: 'vertical' | 'horizontal'): Promise<void>
  getFrontmostAppInfo(): { appIdentifier: string; appName: string; name: string; pid: number } | null
}

/** Discriminated union: the module may or may not be supported on this platform */
export type ComputerUseInput =
  | ({ isSupported: true } & ComputerUseInputAPI)
  | { isSupported: false }

/** API surface of the @ant/computer-use-swift Swift NAPI module (macOS).
 *  This is a complex native module with many methods — we type the known ones
 *  and use [key: string]: any for the rest to allow compilation. */
export interface ComputerUseAPI {
  getFrontmostApp?(): Promise<{ appIdentifier: string; displayName: string } | null>
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
    getFrontmostApp(): Promise<{ appIdentifier: string; displayName: string } | null>
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
  hideApp?(appIdentifier: string): Promise<boolean>
  unhideApp?(appIdentifier: string): Promise<boolean>
  activateApp?(appIdentifier: string): Promise<boolean>
  /** Capture the frontmost window of `appIdentifier`. macOS-only — uses native
   *  CGWindowListCreateImage via the mac NAPI binding. Always returns an
   *  outcome: `image` is set on success, otherwise `diagnostic` describes
   *  which step failed (no running app / no on-screen window / TCC denied /
   *  fallback layer). The diagnostic is logged via logForDebugging on the
   *  agent side so failures show up in ~/.axiomate/debug/latest. */
  captureWindow?(appIdentifier: string): Promise<{
    image: {
      base64: string
      width: number
      height: number
      originX: number
      originY: number
      displayWidth: number
      displayHeight: number
    } | null
    diagnostic: string
  }>
  enumerateUiElementsInRect?(
    rect: {
      origin: { x: number; y: number }
      size: { w: number; h: number }
    },
    windowOnly?: boolean,
  ): Promise<Array<{
    bbox: { origin: { x: number; y: number }; size: { w: number; h: number } }
    name: string
    role: string
    automationId?: string | null
    uiaSource?: string | null
  }>>
  enumerateUiElementsInRectDetailed?(
    rect: {
      origin: { x: number; y: number }
      size: { w: number; h: number }
    },
    windowOnly?: boolean,
  ): Promise<{
    elements: Array<{
      bbox: { origin: { x: number; y: number }; size: { w: number; h: number } }
      name: string
      role: string
      automationId?: string | null
      uiaSource?: string | null
    }>
    traversedCount: number
    matchedCount: number
    returnedCount: number
    truncated: boolean
    truncationReason?: 'traversal_budget' | 'output_budget' | null
  }>
  enumerateUiElementsForAppInRect?(
    appIdentifier: string,
    rect: {
      origin: { x: number; y: number }
      size: { w: number; h: number }
    },
  ): Promise<Array<{
    bbox: { origin: { x: number; y: number }; size: { w: number; h: number } }
    name: string
    role: string
    automationId?: string | null
    uiaSource?: string | null
  }>>
  enumerateUiElementsForAppInRectDetailed?(
    appIdentifier: string,
    rect: {
      origin: { x: number; y: number }
      size: { w: number; h: number }
    },
  ): Promise<{
    elements: Array<{
      bbox: { origin: { x: number; y: number }; size: { w: number; h: number } }
      name: string
      role: string
      automationId?: string | null
      uiaSource?: string | null
    }>
    traversedCount: number
    matchedCount: number
    returnedCount: number
    truncated: boolean
    truncationReason?: 'traversal_budget' | 'output_budget' | null
  }>
  listVisibleWindowsDetailed?(): Promise<Array<{
    windowId: number
    appIdentifier: string
    displayName: string
    rect: { origin: { x: number; y: number }; size: { w: number; h: number } }
    layer: number
    zRank: number
  }>>
  enumerateUiElementsForWindowInRectDetailed?(
    windowId: number,
    appIdentifier: string,
    rect: {
      origin: { x: number; y: number }
      size: { w: number; h: number }
    },
  ): Promise<{
    elements: Array<{
      bbox: { origin: { x: number; y: number }; size: { w: number; h: number } }
      name: string
      role: string
      automationId?: string | null
      uiaSource?: string | null
    }>
    traversedCount: number
    matchedCount: number
    returnedCount: number
    truncated: boolean
    truncationReason?: 'traversal_budget' | 'output_budget' | null
  }>
  elementFromPoint?(
    x: number,
    y: number,
  ): Promise<{
    bbox: { origin: { x: number; y: number }; size: { w: number; h: number } }
    name: string
    role: string
    automationId?: string | null
    uiaSource?: string | null
  } | null>
  _drainMainRunLoop?(): void
  [key: string]: any
}
