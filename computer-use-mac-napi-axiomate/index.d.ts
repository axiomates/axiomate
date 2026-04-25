/** Whether the .node module loaded successfully. False on non-darwin or
 *  when the build artifact is missing. */
export function isAvailable(): boolean

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

/** Force-load the .node binary. No-op if already loaded. */
export function prewarm(): void
