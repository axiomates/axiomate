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
  /** Physical / logical pixel ratio (e.g. 2 for 200% DPI). */
  scaleFactor?: number;
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

/**
 * One element from the Phase 1.5 bulk-pull path. Mirrors the Rust napi
 * struct (`BulkUiElement` on both win + mac), normalized into a single
 * shape so the TS pipeline doesn't need platform-specific extraction.
 *
 * Fields not exposed by a given platform get sensible defaults:
 * - `controlTypeId` is `0` on Mac (no UIA-style integer id; use `role`).
 * - `frameworkId` / `localizedControlType` / `className` are empty on Mac
 *   (no direct AX equivalents).
 * - `subrole` / `roleDescription` / `value` / `help` / `description` /
 *   `enabled` / `focused` / `selected` are only populated on Mac.
 *
 * `parentIndex = -1` for the root. Children always come after their
 * parent in the returned array (pre-order traversal).
 */
export interface BulkUiElement {
  bbox: { x: number; y: number; w: number; h: number };
  name: string;
  role: string;
  controlTypeId: number;
  className: string;
  automationId?: string;
  frameworkId: string;
  localizedControlType: string;
  isOffscreen: boolean;
  nativeWindowHandle: number;
  parentIndex: number;
  depth: number;
  // Mac-only extensions
  subrole?: string;
  roleDescription?: string;
  value?: string;
  help?: string;
  description?: string;
  identifier?: string;
  enabled?: boolean;
  hidden?: boolean;
  focused?: boolean;
  selected?: boolean;
}

export interface BulkEnumerationResult {
  elements: BulkUiElement[];
  /** Web-content viewport rects discovered during the platform's
   *  Phase 1 prune scan (Win RawView Document, Mac AXWebArea). */
  browserViewportBboxes: Array<{ x: number; y: number; w: number; h: number }>;
  elapsedMs: number;
  truncatedByWalltime: boolean;
}

export interface ComputerExecutor {
  capabilities: ComputerExecutorCapabilities;

  // ── Display ──────────────────────────────────────────────────────────
  getDisplaySize(displayId?: number): Promise<DisplayGeometry>;
  listDisplays(): Promise<DisplayGeometry[]>;
  findWindowDisplays(appIdentifiers: string[]): Promise<Array<{ appIdentifier: string; displayIds: number[] }>>;

  // ── Screenshots ──────────────────────────────────────────────────────
  screenshot(opts: {
    allowedAppIdentifiers: string[];
    displayId?: number;
    coordinateGrid?: string;
    /** Optional SoM marks — see resolvePrepareCapture's `marks` for semantics. */
    marks?: Array<{ id: number; x: number; y: number }>;
  }): Promise<ScreenshotResult>;

  /**
   * Mac-only post-capture SoM overlay. After the executor returns the
   * raw JPEG with ruler/cursor annotations, toolCalls.ts builds marks
   * via post-capture UIA and re-runs them through this method to draw
   * red circles + IDs. Win plumbs marks through the native capture
   * call directly and never invokes this.
   */
  drawMarksOnScreenshot?(opts: {
    base64: string;
    imageWidth: number;
    imageHeight: number;
    marks: Array<{ id: number; x: number; y: number }>;
  }): Promise<string>;
  zoom(
    region: { x: number; y: number; w: number; h: number },
    allowedAppIdentifiers: string[],
    displayId?: number,
    coordinateGrid?: string,
    /**
     * SoM (Set-of-Mark) overlay markers to draw on top of the zoomed image.
     * Coords are in the SAME virtual-coord space as `region` (not image
     * pixels). Drawn as semi-transparent red filled circles + numbered
     * labels. Optional — when omitted the image is returned without marks.
     */
    marks?: Array<{ id: number; x: number; y: number }>,
  ): Promise<{ base64: string; width: number; height: number }>;
  resolvePrepareCapture(opts: {
    allowedAppIdentifiers: string[];
    preferredDisplayId?: number;
    autoResolve: boolean;
    doHide?: boolean;
    coordinateGrid?: string;
    /**
     * Optional SoM red-circle overlay marks. Coords are in image-local
     * virtual pixels (same coord space as the screenshot's returned
     * width/height). Used by Win, where pre-capture UIA produces marks
     * before the screenshot is taken. Mac's UIA is post-capture so it
     * ignores this param and applies marks via `drawMarksOnScreenshot`
     * after computing them.
     */
    marks?: Array<{ id: number; x: number; y: number }>;
  }): Promise<ResolvePrepareCaptureResult>;
  /**
   * Capture the frontmost window of the given app. macOS uses
   * `screencapture -l <windowID>` (CGWindowID resolved via osascript).
   * Returns null when no window can be found (app not running, no windows,
   * unknown app identifier, platform without per-window capture support).
   * Coordinates in subsequent click calls still refer to the FULL screen
   * — this is for inspection, not click-target setup.
   *
   * `gridMode` — 0 = none (default), 1 = edge rulers, 2+ = full grid.
   * When > 0, coordinate rulers are drawn on the window image using the
   * window's virtual-screen position so the returned numbers match the
   * global screenshot coordinate space.
   *
   * `marks` — optional SoM (Set-of-Mark) overlays to draw as red numbered
   * circles. Coords are in the window's virtual-screen coordinate space.
   */
  screenshotWindow(
    appIdentifier: string,
    gridMode?: number,
    marks?: Array<{ id: number; x: number; y: number }>,
  ): Promise<ScreenshotResult | null>;

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
  contentAppUnderPoint?(
    x: number,
    y: number,
  ): Promise<{ appIdentifier: string; displayName: string } | null>;
  listInstalledApps(): Promise<InstalledApp[]>;
  listRunningApps(): Promise<RunningApp[]>;
  openApp(appIdentifier: string): Promise<void>;

  // ── Clipboard ────────────────────────────────────────────────────────
  readClipboard(): Promise<string>;
  writeClipboard?(text: string): Promise<void>;


  /**
   * Hit-test: return the UI element at a physical-pixel coordinate.
   * Used by click_target's cursor confirmation step. Optional — callers
   * gracefully skip when undefined.
   * Win32: IUIAutomation::ElementFromPoint.
   */
  elementFromPoint?(
    x: number,
    y: number,
  ): Promise<{ name?: string; role?: string } | null>;

  // ── Foreground management ────────────────────────────────────────────
  /**
   * If axiomate (or its terminal host) is foreground, switch to the
   * previous visible non-host window so the target app is active for
   * screenshot capture and UIA enumeration. Returns true if a switch
   * occurred. No-op on non-Windows platforms.
   */
  defocusSelf?(): Promise<boolean>;

  /**
   * Windows-only: after `hideSelf()` moved axiomate away, foreground the
   * visible non-host window currently under a screen point.
   */
  focusNonHostWindowAtPoint?(point: { x: number; y: number }): Promise<boolean>;

  listVisibleWindows?(): Promise<Array<{
    appIdentifier: string;
    displayName: string;
    hwnd?: number;
    rect: { x: number; y: number; w: number; h: number };
    zRank: number;
    isForeground: boolean;
    isHost?: boolean;
  }>>;

  focusAppWindow?(appIdentifier: string): Promise<boolean>;
  focusWindowHandle?(hwnd: number): Promise<boolean>;

  /**
   * Win diagnostic helper: returns the exe paths of our ancestor
   * processes (16-hop PPID walk via Toolhelp32Snapshot). Logged from
   * `captureWinForegroundRestoreToken` so debug traces include the
   * chain that produced any host-detection oddities (notably bun's
   * tendency to drop the visible terminal from our ancestor chain).
   */
  getHostAncestorPaths?(): Promise<string[]>;


  listVisibleMacWindows?(): Promise<Array<{
    windowId: number;
    appIdentifier: string;
    displayName: string;
    rect: { x: number; y: number; w: number; h: number };
    layer: number;
    zRank: number;
  }>>;


  /**
   * Phase 1.5 bulk-pull. Returns the entire ControlView (Win) / AX (Mac)
   * subtree rooted at the given window/app in one IPC, with all properties
   * the TS pipeline needs. NO filtering at the executor layer — every node
   * comes back; `enumeration/filter.ts` step 8 decides what's meaningful.
   *
   * `browserViewportBboxes` carries the web-content rects discovered via
   * the platform's RawView pre-scan (Win) or AXWebArea hits (Mac) — Phase 1
   * prune semantics preserved.
   *
   * `truncatedByWalltime` is a per-call wall-time backstop firing flag.
   * The pipeline reports the window as "enumeration timed out" but the
   * partial `elements` are still usable.
   */
  enumerateUiElementsBulkForWindow?(windowHandle: number): Promise<BulkEnumerationResult>;

  /** Mac analog by bundle id (no specific window). */
  enumerateUiElementsBulkForApp?(bundleId: string): Promise<BulkEnumerationResult>;

  /** Mac analog rooted at a specific CGWindowID. */
  enumerateUiElementsBulkForMacWindow?(
    windowId: number,
    bundleId: string,
  ): Promise<BulkEnumerationResult>;

  /**
   * Snapshot the current non-host foreground window so screenshot/zoom paths
   * can restore it after temporary probe/activation side effects.
   */
  captureForegroundRestoreToken?(): Promise<{
    appIdentifier: string;
    hwnd?: number;
    centerX: number;
    centerY: number;
    isHost?: boolean;
  } | null>;

  /**
   * Best-effort restore of a foreground window captured by
   * captureForegroundRestoreToken().
   */
  restoreForegroundFromToken?(token: {
    appIdentifier: string;
    hwnd?: number;
    centerX: number;
    centerY: number;
    isHost?: boolean;
  }): Promise<boolean>;

  /**
   * Move axiomate's own host-chain windows off-screen before a
   * screenshot/zoom capture. Returns true if any windows were moved.
   * Caller MUST pair with `showSelf()` in a try/finally.
   *
   * Only implemented on Windows — optional (?.()) so non-Windows
   * platforms gracefully skip.
   */
  hideSelf?(restoreHwnd?: number): Promise<boolean>;
  /**
   * Restore windows previously moved by `hideSelf()`. Idempotent.
   *
   * Only implemented on Windows — optional (?.()) so non-Windows
   * platforms gracefully skip.
   */
  showSelf?(): Promise<void>;

  // ── OS Permissions ───────────────────────────────────────────────────
  ensureOsPermissions?(): Promise<{
    granted: boolean;
    accessibility?: boolean;
    screenRecording?: boolean;
  }>;
}
