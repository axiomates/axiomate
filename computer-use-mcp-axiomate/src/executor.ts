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
  scaleFactor: number;
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
  bundleId: string;
  displayName: string;
}

export interface InstalledApp {
  bundleId: string;
  displayName: string;
  path: string;
}

export interface RunningApp {
  bundleId: string;
  displayName: string;
}

export interface ResolvePrepareCaptureResult {
  displayId: number;
  base64: string;
  width: number;
  height: number;
  hidden: string[];
  captureError?: string;
  displayWidth?: number;
  displayHeight?: number;
  originX?: number;
  originY?: number;
}

export interface ComputerExecutorCapabilities {
  /** Platform identifier (darwin, win32, linux, etc). */
  platform: string;
  /** Host app bundle ID (sentinel). */
  hostBundleId?: string;
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
  findWindowDisplays(bundleIds: string[]): Promise<Array<{ bundleId: string; displayIds: number[] }>>;

  // ── Screenshots ──────────────────────────────────────────────────────
  screenshot(opts: { allowedBundleIds: string[]; displayId?: number }): Promise<ScreenshotResult>;
  zoom(
    region: { x: number; y: number; w: number; h: number },
    allowedBundleIds: string[],
    displayId?: number,
  ): Promise<{ base64: string; width: number; height: number }>;
  resolvePrepareCapture(opts: {
    allowedBundleIds: string[];
    preferredDisplayId?: number;
    autoResolve: boolean;
    doHide?: boolean;
  }): Promise<ResolvePrepareCaptureResult>;
  /**
   * Capture the frontmost window of the given app. macOS uses
   * `screencapture -l <windowID>` (CGWindowID resolved via osascript).
   * Returns null when no window can be found (app not running, no windows,
   * unknown bundle id, platform without per-window capture support).
   * Coordinates in subsequent click calls still refer to the FULL screen
   * — this is for inspection, not click-target setup.
   */
  screenshotWindow(bundleId: string): Promise<ScreenshotResult | null>;

  // ── Pre-action ───────────────────────────────────────────────────────
  prepareForAction(allowlistBundleIds: string[], displayId?: number): Promise<string[]>;
  previewHideSet(
    allowlistBundleIds: string[],
    displayId?: number,
  ): Promise<Array<{ bundleId: string; displayName: string }>>;

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
  appUnderPoint(x: number, y: number): Promise<{ bundleId: string; displayName: string } | null>;
  listInstalledApps(): Promise<InstalledApp[]>;
  listRunningApps(): Promise<RunningApp[]>;
  openApp(bundleId: string): Promise<void>;

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
