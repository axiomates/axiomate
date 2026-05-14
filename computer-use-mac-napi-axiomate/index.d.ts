/** Whether the .node module loaded successfully. False on non-darwin or
 *  when the build artifact is missing. */
export function isAvailable(): boolean

/** When isAvailable() returns false, this returns a human-readable string
 *  describing why the native binding could not be loaded — e.g. "not
 *  darwin", or the underlying require() error message (file not found,
 *  arch mismatch, dyld failure). Returns null while load hasn't been
 *  attempted yet, or after a successful load. */
export function getLoadError(): string | null

/** AXIsProcessTrusted() — does this process have Accessibility permission?
 *  When false, AX queries (AXUIElementCopyAttributeValue, etc.) silently
 *  return empty/kAXErrorAPIDisabled — the typical cause of empty bulk
 *  enumeration on mac. macOS-only; returns false on other platforms or
 *  when the native binding failed to load. */
export function isAccessibilityTrusted(): boolean

/** NSRunningApplication.hide() — sends the app to background, removing its
 *  windows from screen. Returns true if at least one running instance with
 *  the given bundle id was hidden. macOS-only. */
export function hideApp(bundleId: string): Promise<boolean>

/** NSRunningApplication.unhide(). Returns true if at least one running
 *  instance was unhidden. macOS-only. */
export function unhideApp(bundleId: string): Promise<boolean>

/** NSRunningApplication.activate(). Brings the app to the front. macOS-only. */
export function activateApp(bundleId: string): Promise<boolean>

/** Register a global Esc-key callback via CGEventTap. The callback fires
 *  on every Escape keydown, EXCEPT when `notifyExpectedEscape` was called
 *  within the last 100ms (filters out model-synthesized escapes). Returns
 *  true on success. macOS-only; idempotent (re-registering is a no-op). */
export function registerEscapeHotkey(callback: () => void): boolean

/** Tear down the CGEventTap registered by `registerEscapeHotkey`. */
export function unregisterEscapeHotkey(): void

/** Decay-gate: the next Esc keypress within ~100ms is ignored by the
 *  registered callback. Used by the executor right before sending a
 *  synthesized "escape" key so the agent doesn't abort itself. */
export function notifyExpectedEscape(): void

export interface CaptureExcludingOpts {
  /** Bundle IDs to KEEP visible. Apps not in this list are excluded by the
   *  ScreenCaptureKit filter at the compositor level. */
  allowedBundleIds: string[]
  /** CGDirectDisplayID of the display to capture. */
  displayId: number
  /** Output JPEG quality 0.0-1.0. */
  quality?: number
  /** Output target dimensions (image will be resized to fit). */
  width?: number
  height?: number
}

export interface CaptureExcludingResult {
  /** Base64-encoded JPEG. */
  base64: string
  /** Image pixel dimensions. */
  width: number
  height: number
}

/** SCContentFilter screenshot — captures the display with non-allowlisted
 *  apps removed at the compositor level (not just hidden, but never composed
 *  into the captured frame). macOS 12.3+. Returns null on non-darwin. */
export function captureExcluding(
  opts: CaptureExcludingOpts,
): Promise<CaptureExcludingResult | null>

export interface CaptureWindowImage {
  /** Base64-encoded JPEG of the targeted window only. */
  base64: string
  /** Image pixel dimensions (matches the captured window's pixel bounds). */
  width: number
  height: number
  /** Window origin in global screenshot coordinate space. */
  originX: number
  originY: number
  /** Window size in global screenshot coordinate space. */
  displayWidth: number
  displayHeight: number
}

export interface CaptureWindowOutcome {
  /** JPEG image when capture succeeded; null when any step failed. */
  image: CaptureWindowImage | null
  /** Human-readable description of the path taken. "ok" on success;
   *  otherwise names the failed step and includes pid / candidate windowIDs
   *  / layers / TCC hints. Always logged via logForDebugging on the agent
   *  side so failures land in ~/.axiomate/debug/latest. */
  diagnostic: string
}

/** Per-window screenshot via CGWindowListCreateImage. Resolves the bundle
 *  id to a running app's pid, picks its frontmost on-screen window
 *  (preferring layer 0, falling back to any layer), captures it, and
 *  returns JPEG base64. The returned outcome always includes a diagnostic
 *  string explaining the path taken. macOS-only. */
export function captureWindow(
  bundleId: string,
): Promise<CaptureWindowOutcome>

export interface VPoint {
  x: number
  y: number
}

export interface VSize {
  w: number
  h: number
}

export interface VRect {
  origin: VPoint
  size: VSize
}

export interface VisibleMacWindowInfo {
  windowId: number
  appIdentifier: string
  displayName: string
  rect: VRect
  layer: number
  zRank: number
}

export function listVisibleWindowsDetailed(): Promise<VisibleMacWindowInfo[]>

/** Force-load the .node binary. No-op if already loaded. */
export function prewarm(): void
