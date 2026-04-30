/**
 * ComputerExecutor interface — the platform-specific contract.
 *
 * This file defines the interface that native implementations must fulfill.
 * The MCP protocol layer (tools, toolCalls, mcpServer) consumes this interface
 * without knowing which platform provides it.
 *
 * Implementations:
 *   - macOS: @ant/computer-use-swift (screenshots, app mgmt) + @ant/computer-use-input (keyboard/mouse)
 *   - Windows/Linux: TODO — nut.js, scrot, xdotool, or platform-native APIs
 */

export interface DisplayGeometry {
  displayId: number;
  width: number;
  height: number;
  isMain?: boolean;
  isPrimary?: boolean;
  originX?: number;
  originY?: number;
  label?: string;
}

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  displayId?: number;
  displayWidth?: number;
  displayHeight?: number;
  originX?: number;
  originY?: number;
}

export interface FrontmostApp {
  appIdentifier: string;
  displayName: string;
}

export interface InstalledApp {
  appIdentifier: string;
  displayName: string;
  path: string;
}

export interface RunningApp {
  appIdentifier: string;
  displayName: string;
}

export interface ResolvePrepareCaptureResult {
  displayId: number;
  base64: string;
  width: number;
  height: number;
  /**
   * App identifiers hidden as part of this atomic resolve+prepare+capture.
   *
   * macOS-only. The mac executor's `prepareForAction` (driven by SCContentFilter
   * compositor allowlist) hides non-allowlisted apps before capture so the
   * screenshot doesn't leak content the user didn't grant. Win does NOT do
   * this — its model is "don't touch other apps; click delivers to wherever
   * it lands and shell handles activation" — and returns this field as
   * undefined (or `[]`). Callers must treat undefined as "no apps were
   * hidden" (i.e., `?? []`). See COORDINATES.md / the platform-divergence
   * note in the executor implementations.
   */
  hidden?: string[];
  captureError?: string;
  displayWidth?: number;
  displayHeight?: number;
  originX?: number;
  originY?: number;
}

export interface ComputerExecutorCapabilities {
  /** Platform identifier (darwin, win32, linux, etc). */
  platform: string;
  /** Host app identifier (sentinel). */
  hostAppIdentifier?: string;
  /** Whether screenshot filtering (exclude apps) is supported. */
  screenshotFiltering: "native" | "none";
  /** Whether teach mode is available. */
  teachMode?: boolean;
}

export interface ComputerExecutor {
  capabilities: ComputerExecutorCapabilities;

  // ── Display ──────────────────────────────────────────────────────────
  getDisplaySize(displayId?: number): Promise<DisplayGeometry>;
  listDisplays(): Promise<DisplayGeometry[]>;
  findWindowDisplays(appIdentifiers: string[]): Promise<Array<{ appIdentifier: string; displayIds: number[] }>>;

  // ── Screenshots ──────────────────────────────────────────────────────
  screenshot(opts: { allowedAppIdentifiers: string[]; displayId?: number; coordinateGrid?: string }): Promise<ScreenshotResult>;
  zoom(
    region: { x: number; y: number; w: number; h: number },
    allowedAppIdentifiers: string[],
    displayId?: number,
  ): Promise<{ base64: string; width: number; height: number }>;
  resolvePrepareCapture(opts: {
    allowedAppIdentifiers: string[];
    preferredDisplayId?: number;
    autoResolve: boolean;
    doHide?: boolean;
    coordinateGrid?: string;
  }): Promise<ResolvePrepareCaptureResult>;
  /**
   * Capture the frontmost window of the given app. macOS uses
   * `screencapture -l <windowID>` (CGWindowID resolved via osascript).
   * Returns null when no window can be found (app not running, no windows,
   * unknown app identifier, platform without per-window capture support).
   * Coordinates in subsequent click calls still refer to the FULL screen
   * — this is for inspection, not click-target setup.
   */
  screenshotWindow(appIdentifier: string): Promise<ScreenshotResult | null>;

  // ── Pre-action (macOS-only) ──────────────────────────────────────────
  /**
   * Hide non-allowlisted apps before an action runs, return the hidden
   * app identifiers so the host can unhide at turn end.
   *
   * **macOS-only.** Mac's compositor (SCContentFilter) needs allowlisted
   * apps to be the only visible top-level windows so the screenshot doesn't
   * leak content. Hide loop is the mechanism. Win deliberately does NOT
   * implement this — Win's model is "don't touch other apps; clicks deliver
   * to wherever they land and Win11 shell handles target activation".
   * Callers must use `?.()` and `?? []` so the undefined-on-Win case
   * propagates as "nothing hidden".
   */
  prepareForAction?(allowlistAppIdentifiers: string[], displayId?: number): Promise<string[]>;
  /**
   * Preview which apps WOULD be hidden by `prepareForAction` for the given
   * allowlist. Used by approval UI to show "if you grant access to X, these
   * 7 apps will be hidden during AI use".
   *
   * **macOS-only.** Same divergence as `prepareForAction` — Win has no hide
   * model, so this is undefined there. Callers use `?.()` and `?? []`.
   */
  previewHideSet?(
    allowlistAppIdentifiers: string[],
    displayId?: number,
  ): Promise<Array<{ appIdentifier: string; displayName: string }>>;

  // ── Keyboard ─────────────────────────────────────────────────────────
  key(keySequence: string, repeat?: number): Promise<void>;
  holdKey(keyNames: string[], durationMs: number): Promise<void>;
  type(text: string, opts: { viaClipboard: boolean }): Promise<void>;

  // ── Mouse ────────────────────────────────────────────────────────────
  moveMouse(x: number, y: number): Promise<void>;
  click(
    x: number,
    y: number,
    button: "left" | "right" | "middle",
    count: 1 | 2 | 3,
    modifiers?: string[],
  ): Promise<void>;
  mouseDown(): Promise<void>;
  mouseUp(): Promise<void>;
  getCursorPosition(): Promise<{ x: number; y: number }>;
  drag(from: { x: number; y: number } | undefined, to: { x: number; y: number }): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;

  // ── App management ───────────────────────────────────────────────────
  getFrontmostApp(): Promise<FrontmostApp | null>;
  appUnderPoint(x: number, y: number): Promise<{ appIdentifier: string; displayName: string } | null>;
  listInstalledApps(): Promise<InstalledApp[]>;
  listRunningApps(): Promise<RunningApp[]>;
  openApp(appIdentifier: string): Promise<void>;

  // ── Clipboard ────────────────────────────────────────────────────────
  readClipboard(): Promise<string>;
  writeClipboard?(text: string): Promise<void>;

  // ── OS Permissions ───────────────────────────────────────────────────
  ensureOsPermissions?(): Promise<{
    granted: boolean;
    accessibility?: boolean;
    screenRecording?: boolean;
  }>;
}
