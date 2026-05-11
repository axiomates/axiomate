import type {
  ComputerExecutor,
  InstalledApp,
  ScreenshotResult,
} from "./executor.js";

/** `ScreenshotResult` without the base64 blob. The shape hosts persist for
 *  cross-respawn `scaleCoord` survival. */
export type ScreenshotDims = Omit<ScreenshotResult, "base64">;

export interface Logger {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
  silly: (message: string, ...args: unknown[]) => void;
}

/**
 * Per-app permission tier. Hardcoded by category at grant time — the
 * approval dialog displays the tier but the user cannot change it (for now).
 *
 *   - `"read"` — visible in screenshots, NO interaction (no clicks, no typing).
 *     Browsers and trading platforms land here: the model can read a page
 *     that's already open, but cannot navigate/click (the model asks the user).
 *   - `"click"` — visible + plain left-click, scroll. NO typing/keys,
 *     NO right/middle-click, NO modifier-clicks, NO drag-drop (all text-
 *     injection vectors). Terminals/IDEs land here: the model can click a
 *     Run button or scroll test output, but `type("rm -rf /")` is blocked
 *     and so is right-click→Paste and dragging text onto the terminal.
 *   - `"full"` — visible + click + type/key/paste. Everything else.
 *
 * Enforced in `runInputActionGates` via the frontmost-app check: keyboard
 * actions require `"full"`, mouse actions require `"click"` or higher.
 */
export type CuAppPermTier = "read" | "click" | "full";

/**
 * A single app the user has approved for the current session. Session-scoped
 * only — there is no "once" or "forever" scope (unlike Chrome's per-domain
 * three-way). CU has no natural "once" unit; one task = hundreds of clicks.
 * Mirrors how `chromeAllowedDomains` is a plain `string[]` with no per-item
 * scope.
 */
export interface AppGrant {
  appIdentifier: string;
  displayName: string;
  /** Epoch ms. For Settings-page display ("Granted 3m ago"). */
  grantedAt: number;
  /** Undefined → `"full"` (back-compat for pre-tier grants persisted in
   *  session state). */
  tier?: CuAppPermTier;
}

/** Orthogonal to the app allowlist. */
export interface CuGrantFlags {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  /**
   * When false, the `key` tool rejects combos in `keyBlocklist.ts`
   * (cmd+q, cmd+tab, cmd+space, cmd+shift+q, ctrl+alt+delete). All other
   * key sequences work regardless.
   */
  systemKeyCombos: boolean;
}

export const DEFAULT_GRANT_FLAGS: CuGrantFlags = {
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
};

/**
 * Coordinate convention baked into tool param descriptions at server-
 * construction time. The model sees ONE convention and never learns the
 * other exists.
 *
 * - `pixels` — AI emits image-pixel coords read from the screenshot.
 *   scaleCoord maps `rawX * (displayWidth / imageWidth) + originX`.
 * - `normalized_0_100` — AI emits percentage (0–100). scaleCoord maps
 *   `rawX / 100 * displayWidth + originX`.
 */
export type CoordinateMode = "pixels" | "normalized_0_100";

/**
 * Independent kill switches for subtle/risky ported behaviors. Read from
 * GrowthBook by the host adapter, consulted in `toolCalls.ts`.
 */
export interface CuSubGates {
  /** Route `type("foo\nbar")` through clipboard instead of keystroke-by-keystroke. */
  clipboardPasteMultiline: boolean;
  /**
   * Ease-out-cubic mouse glide at 60fps, distance-proportional duration
   * (2000 px/sec, capped at 0.5s). Adds up to ~0.5s latency
   * per click. When off, cursor teleports instantly.
   */
  mouseAnimation: boolean;
  /**
   * Pre-action sequence: hide non-allowlisted apps, then defocus us (from the
   * Vercept acquisition). When off, the
   * frontmost gate fires in the normal case and the model gets stuck — this
   * is the A/B-test-the-old-broken-behavior switch.
   */
  hideBeforeAction: boolean;
  /**
   * Auto-resolve the target display before each screenshot when the
   * selected display has no allowed-app windows. When on, `handleScreenshot`
   * uses the atomic Swift path; off → sticks with `selectedDisplayId`.
   */
  autoTargetDisplay: boolean;
  /**
   * Stash+clear the clipboard while a tier-"click" app is frontmost.
   * Closes the gap where a click-tier terminal/IDE has a UI Paste button
   * that's plain-left-clickable — without this, the tier "click"
   * keyboard block can be routed around by clicking Paste. Restored when
   * a non-"click" app becomes frontmost, or at turn end.
   */
  clipboardGuard: boolean;
}

// ----------------------------------------------------------------------------
// Permission request/response (mirror of BridgePermissionRequest, types.ts:77-94)
// ----------------------------------------------------------------------------

/** One entry per app the model asked for, after name → app identifier resolution. */
export interface ResolvedAppRequest {
  /** What the model asked for (e.g. "Slack", "com.tinyspeck.slackmacgap"). */
  requestedName: string;
  /** The resolved InstalledApp if found, else undefined (shown greyed in the UI). */
  resolved?: InstalledApp;
  /** Shell-access-equivalent app identifiers get a UI warning. See sentinelApps.ts. */
  isSentinel: boolean;
  /** Already in the allowlist → skip the checkbox, return in `granted` immediately. */
  alreadyGranted: boolean;
  /** Hardcoded tier for this app (browser→"read", terminal→"click", else "full").
   *  The dialog displays this read-only; the renderer passes it through
   *  verbatim in the AppGrant. */
  proposedTier: CuAppPermTier;
}

/**
 * Payload for the renderer approval dialog. Rides through the existing
 * `ToolPermissionRequest.input: unknown` field
 * (packages/utils/desktop/bridge/common/axiomate.web.ts:1262) — no IPC schema
 * change needed.
 */
export interface CuPermissionRequest {
  requestId: string;
  /** Model-provided reason string. Shown prominently in the approval UI. */
  reason: string;
  apps: ResolvedAppRequest[];
  /** What the model asked for. User can toggle independently of apps. */
  requestedFlags: Partial<CuGrantFlags>;
  /**
   * For the "On Windows, Axiomate can see all apps..." footnote. Taken from
   * `executor.capabilities.screenshotFiltering` so the renderer doesn't
   * need to know about platforms.
   */
  screenshotFiltering: "native" | "none";
  /**
   * Present only when TCC permissions are NOT yet granted. When present,
   * the renderer shows a TCC toggle panel (two rows: Accessibility, Screen
   * Recording) INSTEAD OF the app list. Clicking a row's "Request" button
   * triggers the OS prompt; the store polls on window-focus and flips the
   * toggle when the grant is detected. macOS itself prompts the user to
   * restart after granting Screen Recording — we don't.
   */
  tccState?: {
    accessibility: boolean;
    screenRecording: boolean;
  };
  /**
   * Apps with windows on the CU display that aren't in the requested
   * allowlist. These will be hidden the first time Axiomate takes an action.
   * Computed at request_access time — may be slightly stale by the time the
   * user clicks Allow, but it's a preview, not a contract. Absent when
   * empty so the renderer can skip the section cleanly.
   */
  willHide?: Array<{ appIdentifier: string; displayName: string }>;
  /**
   * `chicagoAutoUnhide` app preference at request time. The renderer picks
   * between "...then restored when Axiomate is done" and "...will be hidden"
   * copy. Absent when `willHide` is absent (same condition).
   */
  autoUnhideEnabled?: boolean;
}

/**
 * What the renderer stuffs into `updatedInput._cuGrants` when the user clicks
 * "Allow for this session" (mirror of the `_allowAllSites` sentinel at
 * LocalAgentModeSessionManager.ts:2794).
 */
export interface CuPermissionResponse {
  granted: AppGrant[];
  /** App identifiers the user unchecked, or apps that weren't installed. */
  denied: Array<{ appIdentifier: string; reason: "user_denied" | "not_installed" }>;
  flags: CuGrantFlags;
  /**
   * Whether the user clicked Allow in THIS dialog. Only set by the
   * teach-mode handler — regular request_access doesn't need it (the
   * session manager's `result.behavior` gates the merge there). Needed
   * because when all requested apps are already granted (skipDialogGrants
   * non-empty, needDialog empty), Allow and Deny produce identical
   * `{granted:[], denied:[]}` payloads and the tool handler can't tell
   * them apart without this. Undefined → legacy/regular path, do not
   * gate on it.
   */
  userConsented?: boolean;
}

/**
 * Process-lifetime singleton dependencies. Everything that does NOT vary per
 * tool call. Built once by the host's `hostAdapter.ts`.
 * No Electron imports in this package — the host injects everything.
 */
/**
 * Platform-discriminated OS permission state. macOS has TCC (Accessibility +
 * Screen Recording); Windows has no per-app permission model that we gate on
 * (UAC is the boundary, but we don't observe it here). Discriminated by
 * `platform` so consumers TS-narrow correctly and the win32 variant can't
 * accidentally read mac-only fields.
 */
export type OsPermissionState =
  | {
      platform: "darwin";
      granted: boolean;
      accessibility: boolean;
      screenRecording: boolean;
    }
  | { platform: "win32"; granted: true };

export interface ComputerUseHostAdapter {
  serverName: string;
  logger: Logger;
  executor: ComputerExecutor;

  /**
   * TCC state check — Accessibility + Screen Recording on macOS. Pure check,
   * no dialog, no relaunch. When either is missing, `request_access` threads
   * the state through to the renderer which shows a toggle panel; all other
   * tools return a tool error. On Windows always returns
   * `{ platform: 'win32', granted: true }` — UAC is the boundary, not a
   * per-app permission this layer observes.
   */
  ensureOsPermissions(): Promise<OsPermissionState>;

  /** The Settings-page kill switch (`chicagoEnabled` app preference). */
  isDisabled(): boolean;

  /**
   * The `chicagoAutoUnhide` app preference. Consumed by `buildAccessRequest`
   * to populate `CuPermissionRequest.autoUnhideEnabled` so the renderer's
   * "will be hidden" copy can say "then restored" only when true.
   */
  getAutoUnhideEnabled(): boolean;

  /** Whether the high-cost vision-based locate loop is globally enabled. */
  isVisionLocateEnabled(): boolean;

  /** Whether the current session model supports image input. */
  currentModelSupportsImages(): boolean;

  /**
   * Sub-gates re-read on every tool call so GrowthBook flips take effect
   * mid-session without restart.
   */
  getSubGates(): CuSubGates;
}

// ----------------------------------------------------------------------------
// Session context (getter/callback bag for bindSessionContext)
// ----------------------------------------------------------------------------

/**
 * Per-session state binding for `bindSessionContext`. Hosts build this once
 * per session with getters that read fresh from their session store and
 * callbacks that write back. The returned dispatcher builds
 * `ComputerUseOverrides` from these getters on every call.
 *
 * Callbacks must be set at construction time — `bindSessionContext` reads
 * them once at bind, not per call.
 *
 * The lock hooks are **async** — `bindSessionContext` awaits them before
 * `handleToolCall`, then passes `checkCuLock: undefined` in overrides so the
 * sync Gate-3 in `handleToolCall` no-ops. Hosts with in-memory sync locks
 * (typical Electron host) wrap them trivially; hosts with cross-process locks
 * (the CLI's O_EXCL file) call the real async primitive directly.
 */
export interface ComputerUseSessionContext {
  // ── Read state fresh per call ──────────────────────────────────────

  getAllowedApps(): readonly AppGrant[];
  getGrantFlags(): CuGrantFlags;
  /** Per-user auto-deny list (Settings page). Empty array = none. */
  getUserDeniedAppIdentifiers(): readonly string[];
  getSelectedDisplayId(): number | undefined;
  getDisplayPinnedByModel?(): boolean;
  getDisplayResolvedForApps?(): string | undefined;
  getTeachModeActive?(): boolean;

  // ── Write-back callbacks ───────────────────────────────────────────

  /** Shows the approval dialog. Host routes to its UI, awaits user. The
   *  signal is aborted if the tool call finishes before the user answers
   *  (MCP timeout, etc.) — hosts dismiss the dialog on abort. */
  onPermissionRequest?(
    req: CuPermissionRequest,
    signal: AbortSignal,
  ): Promise<CuPermissionResponse>;
  /** Teach-mode sibling of `onPermissionRequest`. */
  onTeachPermissionRequest?(
    req: CuTeachPermissionRequest,
    signal: AbortSignal,
  ): Promise<CuPermissionResponse>;
  /** Called by `bindSessionContext` after merging a permission response into
   *  the allowlist (dedupe on appIdentifier, truthy-only flag spread). Host
   *  persists for resume survival. */
  onAllowedAppsChanged?(apps: readonly AppGrant[], flags: CuGrantFlags): void;
  onAppsHidden?(appIdentifiers: string[]): void;
  /** Reads the session's clipboardGuard stash. undefined → no stash held. */
  getClipboardStash?(): string | undefined;
  /** Writes the clipboardGuard stash. undefined clears it. */
  onClipboardStashChanged?(stash: string | undefined): void;
  onResolvedDisplayUpdated?(displayId: number): void;
  onDisplayPinned?(displayId: number | undefined): void;
  onDisplayResolvedForApps?(sortedAppIdentifiersKey: string): void;
  onTeachModeActivated?(): void;
  onTeachStep?(req: TeachStepRequest): Promise<TeachStepResult>;
  onTeachWorking?(): void;

  // ── Lock (async) ───────────────────────────────────────────────────

  /** At most one session uses CU at a time. Awaited by `bindSessionContext`
   *  before dispatch. Undefined → no lock gating (proceed). */
  checkCuLock?(): Promise<{ holder: string | undefined; isSelf: boolean }>;
  /** Take the lock. Called when `checkCuLock` returned `holder: undefined`
   *  on a non-deferring tool. Host emits enter-CU signals here. */
  acquireCuLock?(): Promise<void>;
  /** Host-specific lock-held error text. Default is the package's generic
   *  message. The CLI host includes the holder session-ID prefix. */
  formatLockHeldMessage?(holder: string): string;

  /** User-abort signal. Passed through to `ComputerUseOverrides.isAborted`
   *  for the mid-loop checks in handleComputerBatch / handleType. See that
   *  field for semantics. */
  isAborted?(): boolean;

  // ── VL query (click_target visual search) ──────────────────────────

  /**
   * Lightweight VL inference for the click_target visual search loop.
   * Host implements via getVlModel() + sideQuery(). Returns structured
   * JSON when a schema is provided, free-form text otherwise.
   *
   * Undefined → click_target returns a tool error (VL not configured).
   */
  vlQuery?(opts: {
    images: string[];
    prompt: string;
    schema?: object;
  }): Promise<{ text: string; parsed?: unknown }>;
}

// ----------------------------------------------------------------------------
// Per-call overrides (mirror of PermissionOverrides, types.ts:97-102)
// ----------------------------------------------------------------------------

/**
 * Built FRESH on every tool call by `bindSessionContext` from
 * `ComputerUseSessionContext` getters. This is what lets a singleton MCP
 * server carry per-session state — the state lives on the host's session
 * store, not the server.
 *
 * Discriminated by `platform` (Phase B1): `allowedApps` and
 * `userDeniedAppIdentifiers` are SCContentFilter-shaped concepts that only
 * carry meaning on macOS. On Windows the type system literally doesn't
 * have those fields — read them via the helpers below to get `[]`
 * cross-platform without a narrow at every call site.
 */
interface BaseComputerUseOverrides {
  grantFlags: CuGrantFlags;
  coordinateMode: CoordinateMode;

  /**
   * Display CU operates on; read fresh per call. `scaleCoord` uses the
   * `originX/Y` snapshotted in `lastScreenshot`, so mid-session switches
   * only affect the NEXT screenshot/prepare call.
   */
  selectedDisplayId?: number;

  /**
   * The `request_access` tool handler calls this and awaits. The wrapper
   * closure in serverDef.ts (mirroring InternalMcpServerManager.ts:131-177)
   * routes through `handleToolPermission` → IPC → renderer ChicagoApproval.
   * When it resolves, the wrapper side-effectfully mutates
   * `InternalServerContext.cuAllowedApps` BEFORE returning here.
   *
   * Undefined when the session wasn't wired with a permission handler (e.g.
   * a future headless mode). `request_access` returns a tool error in that case.
   */
  onPermissionRequest?: (req: CuPermissionRequest) => Promise<CuPermissionResponse>;

  /**
   * For the pixel-validation staleness guard. The model's-last-screenshot,
  /**
   * Fired after every `prepareForAction` with the app identifiers it just hid.
   * The wrapper closure in serverDef.ts accumulates these into
   * `Session.cuHiddenDuringTurn` via a write-through callback (same pattern
   * as `onCuPermissionUpdated`). At turn end (`sdkMessage.type === "result"`),
   * if the `chicagoAutoUnhide` setting is on, everything in the set is
   * unhidden. Set is cleared regardless of the setting so it doesn't leak
   * across turns.
   *
   * Undefined when the session wasn't wired with a tracker — unhide just
   * doesn't happen.
   */
  onAppsHidden?: (appIdentifiers: string[]) => void;

  /**
   * Reads the clipboardGuard stash from session state. `undefined` means no
   * stash is held — `syncClipboardStash` stashes on first entry to click-tier
   * and clears on restore. Sibling of the `cuHiddenDuringTurn` getter pattern
   * — state lives on the host's session, not module-level here.
   */
  getClipboardStash?: () => string | undefined;

  /**
   * Writes the clipboardGuard stash to session state. `undefined` clears.
   * Sibling of `onAppsHidden` — the wrapper closure writes through to
   * `Session.cuClipboardStash`. At turn end the host reads + clears it
   * directly and restores via Electron's `clipboard.writeText` — no extra
   * import surface needed from this package.
   */
  onClipboardStashChanged?: (stash: string | undefined) => void;

  /**
   * Write the resolver's picked display back to session so teach overlay
   * positioning and subsequent non-resolver calls use the same display.
   * Fired by `handleScreenshot` in the atomic `autoTargetDisplay` path when
   * `resolvePrepareCapture`'s pick differs from `selectedDisplayId`.
   * Fire-and-forget.
   */
  onResolvedDisplayUpdated?: (displayId: number) => void;

  /**
   * Set when the model explicitly picked a display via `switch_display`.
   * When true, `handleScreenshot` passes `autoResolve: false` so the Swift
   * resolver honors `selectedDisplayId` directly (straight cuDisplayInfo
   * passthrough) instead of running the co-location/chase chain. The
   * resolver's Step 2 ("host + allowed co-located → host") otherwise
   * overrides any `selectedDisplayId` whenever an allowed app shares the
   * host's monitor.
   */
  displayPinnedByModel?: boolean;

  /**
   * Write the model's explicit display pick to session. `displayId:
   * undefined` clears both `selectedDisplayId` and the pin (back to auto).
   * Sibling of `onResolvedDisplayUpdated` but also sets the pin flag —
   * the two are semantically distinct (resolver-picked vs model-picked).
   */
  onDisplayPinned?: (displayId: number | undefined) => void;

  /**
   * Sorted comma-joined app-identifier set the display was last auto-resolved
   * for. `handleScreenshot` compares this to the current allowed set and
   * only passes `autoResolve: true` when they differ — so the resolver
   * doesn't yank the display on every screenshot, only when the app set
   * has changed since the last resolve (or manual switch).
   */
  displayResolvedForApps?: string;

  /**
   * Records which app set the current display selection was made for. Fired
   * alongside `onResolvedDisplayUpdated` when the resolver picks, so the next
   * screenshot sees a matching set and skips auto-resolve.
   */
  onDisplayResolvedForApps?: (sortedAppIdentifiersKey: string) => void;

  /**
   * Global CU lock — at most one session actively uses CU at a time. Checked
   * in `handleToolCall` after kill-switch/TCC, before dispatch. Every CU tool
   * including `request_access` goes through it.
   *
   * - `holder === undefined` → lock is free, safe to acquire
   * - `isSelf === true` → this session already holds it (no-op, proceed)
   * - `holder !== undefined && !isSelf` → blocked, return tool error
   *
   * `undefined` callback → lock system not wired. Proceed without
   * gating — absence of the mechanism ≠ locked out.
   *
   * The host manages release (on session idle/stop/archive) — this package
   * never releases.
   */
  checkCuLock?: () => { holder: string | undefined; isSelf: boolean };

  /**
   * Take the lock for this session. `handleToolCall` calls this exactly once
   * per turn, on the FIRST CU tool call when `checkCuLock().holder` is
   * undefined. No-op if already held (defensive — the check should have
   * short-circuited). Host emits an event the overlay listens to.
   */
  acquireCuLock?: () => void;

  /**
   * User-abort signal. Checked mid-iteration inside `handleComputerBatch`
   * and `handleType`'s grapheme loop so an in-flight batch/type stops
   * promptly on overlay Stop instead of running to completion after the
   * host has already abandoned the tool result.
   *
   * Undefined → never aborts (e.g. unwired host). Live per-check read —
   * same lazy-getter pattern as `checkCuLock`.
   */
  isAborted?: () => boolean;

  // ── VL query (click_target visual search) ──────────────────────────

  /**
   * VL inference callback for click_target's visual search loop.
   * Wired by `bindSessionContext` from `ComputerUseSessionContext.vlQuery`.
   */
  vlQuery?: (opts: {
    images: string[];
    prompt: string;
    schema?: object;
  }) => Promise<{ text: string; parsed?: unknown }>;

  // ── Click-target loop state (SoM enrichment) ──────────────────────────
  // Wired by `bindSessionContext`. The loop state lives in the dispatcher's
  // closure (`activeClickLoop`); these two callbacks are the ONLY way handlers
  // (handleZoom, handleMoveMouse) can read or mutate it. Both undefined means
  // the dispatcher isn't wired (no loop tracking) — handlers fall back to
  // their pre-SoM behavior (no marks attached, mark_id resolution errors).

  /**
   * Read the currently-active vision_locate loop state, or null if no loop
   * is in progress.
   */
  getActiveLocate?: () => import("./clickTarget.js").LocateState | null;

  /**
   * Replace the active locate loop's `marks` with a new list. Called by
   * handleZoom after a SoM detection pass; the new marks become the
   * resolution target for the next `mouse_move(mark_id)`. No-op when no
   * loop is active.
   *
   * `marks` is REPLACED (not appended) so id numbering on the wire matches
   * what the AI just saw drawn on the zoomed image.
   */
  onLocateMarksUpdated?: (
    marks: import("./clickTarget.js").Mark[],
  ) => void;

  /**
   * Global SoM marks from the most recent zoom — NOT gated by
   * vision_locate loop state. Updated on every zoom that runs detection,
   * cleared on `som: false` or when detection returns zero elements.
   * Read by handleMoveMouse for `mark_id` resolution outside a loop.
   */
  getLastZoomMarks?: () => import("./clickTarget.js").Mark[];

  // ── Teach mode ───────────────────────────────────────────────────────
  // Wired only when the host's teachModeEnabled gate is on. All five
  // undefined → `request_teach_access` / `teach_step` return tool errors
  // and teach mode is effectively off.

  /**
   * Sibling of `onPermissionRequest`. Same blocking-await-on-renderer-dialog
   * semantics, but routes to ComputerUseTeachApproval.tsx (which explains
   * the window-hides-during-guide behavior) instead of ComputerUseApproval.
   * The wrapper closure in serverDef.ts writes grants through to session state
   * via `onCuPermissionUpdated` exactly as `onPermissionRequest` does.
   */
  onTeachPermissionRequest?: (
    req: CuTeachPermissionRequest,
  ) => Promise<CuPermissionResponse>;

  /**
   * Called by `handleRequestTeachAccess` after the user approves and at least
   * one app was granted. Host sets `session.teachModeActive = true`, emits
   * `teachModeChanged` → teach controller hides the main window and shows the
   * fullscreen overlay. Cleared by the host on turn end (`transitionTo("idle")`)
   * alongside the CU lock release.
   */
  onTeachModeActivated?: () => void;

  /**
   * Read by `handleRequestAccess` and `handleRequestTeachAccess` to
   * short-circuit with a clear tool error when teach mode is active. The
   * main window is hidden during teach mode, so permission dialogs render
   * invisibly and handleToolPermission blocks forever on an invisible
   * prompt. Better to tell the model to exit teach mode first. Getter
   * (not a boolean field) because teach mode state lives on the session,
   * not on this per-call overrides object.
   */
  getTeachModeActive?: () => boolean;

  /**
   * Called by `handleTeachStep` with the scaled anchor + text. Host stores
   * the resolver, emits `teachStepRequested` → teach controller pushes the
   * payload to the overlay → user reads, clicks Next → IPC → host calls the
   * stored resolver → this promise resolves. `{action: "exit"}` when the user
   * clicks Exit (or the turn is interrupted) — `handleTeachStep` short-circuits
   * without executing actions.
   *
   * Same blocking-promise pattern as `onPermissionRequest`, but resolved by
   * the teach overlay's own preload (not the main renderer's tool-approval UI).
   */
  onTeachStep?: (req: TeachStepRequest) => Promise<TeachStepResult>;

  /**
   * Called immediately after `onTeachStep` resolves with "next", before
   * action dispatch begins. Host emits `teachStepWorking` → overlay flips to
   * the spinner state (Next button gone, Exit stays, "Working…" + rotating
   * notch). The next `onTeachStep` call replaces the spinner with the new
   * tooltip content.
   */
  onTeachWorking?: () => void;
}

/**
 * Per-call overrides — platform-discriminated union (Phase B1).
 *
 * Mac variant carries `allowedApps` (SCContentFilter compositor allowlist) and
 * `userDeniedAppIdentifiers` (Settings auto-deny). Win variant has neither — those
 * concepts have no Windows analog. Use the `allowedAppsOf()` /
 * `userDeniedAppIdentifiersOf()` helpers for cross-platform reads that should
 * see empty arrays on Win.
 */
export type ComputerUseOverrides =
  | (BaseComputerUseOverrides & {
      platform: "darwin";
      allowedApps: AppGrant[];
      /**
       * User-configured auto-deny list (Settings → Desktop app → Computer
       * Use). App identifiers here are stripped from request_access BEFORE the
       * approval dialog — they never reach the user for approval regardless
       * of tier. The response tells the agent to ask the user to remove the
       * app from their deny list in Settings if access is genuinely needed.
       *
       * Per-USER, persists across restarts (read from appPreferences per
       * call, not session state). Contrast with `allowedApps` which is
       * per-session. Empty array = no user-configured denies.
       */
      userDeniedAppIdentifiers: readonly string[];
    })
  | (BaseComputerUseOverrides & {
      platform: "win32";
    });

/**
 * Cross-platform reader for `allowedApps`. Returns `[]` on Win since the
 * concept has no analog there. Lets handlers running on both platforms
 * iterate uniformly — the empty-array semantics yield the same "no
 * allowlist set" code path Win was already taking at runtime before B1
 * type-narrowed the field.
 */
export function allowedAppsOf(o: ComputerUseOverrides): AppGrant[] {
  return o.platform === "darwin" ? o.allowedApps : [];
}

/**
 * Cross-platform reader for `userDeniedAppIdentifiers`. Returns `[]` on Win.
 * Used by the request_access flow (mac-only tool) — present in shared
 * helpers for completeness.
 */
export function userDeniedAppIdentifiersOf(
  o: ComputerUseOverrides,
): readonly string[] {
  return o.platform === "darwin" ? o.userDeniedAppIdentifiers : [];
}

// ----------------------------------------------------------------------------
// Teach mode (guided-tour tooltips with Next-button action execution)
// ----------------------------------------------------------------------------

/**
 * Payload the host pushes to the teach overlay BrowserWindow. Built by
 * `handleTeachStep` in toolCalls.ts from the model's `teach_step` args.
 *
 * `anchorLogical` here is POST-`scaleCoord` — **full-display** logical
 * macOS points (origin = monitor top-left, menu bar included, since
 * cuDisplayInfo returns CGDisplayBounds). The overlay window is positioned
 * at `workArea.{x,y}` (excludes menu bar/Dock), so `updateTeachStep` in
 * teach/window.ts subtracts the workArea offset before IPC so the HTML's
 * CSS coords match.
 */
export interface TeachStepRequest {
  explanation: string;
  nextPreview: string;
  /** Full-display logical points. Undefined → overlay centers the tooltip, hides the arrow. */
  anchorLogical?: { x: number; y: number };
}

export type TeachStepResult = { action: "next" } | { action: "exit" };

/**
 * Payload for the renderer's ComputerUseTeachApproval dialog. Rides through
 * `ToolPermissionRequest.input: unknown` same as `CuPermissionRequest`.
 * Separate type (not a flag on `CuPermissionRequest`) so the two approval
 * components can narrow independently and the teach dialog is free to drop
 * fields it doesn't render (no grant-flag checkboxes in teach mode).
 */
export interface CuTeachPermissionRequest {
  requestId: string;
  /** Model-provided reason. Shown in the dialog headline ("guide you through {reason}"). */
  reason: string;
  apps: ResolvedAppRequest[];
  screenshotFiltering: "native" | "none";
  /** Present only when TCC is ungranted — same semantics as `CuPermissionRequest.tccState`. */
  tccState?: {
    accessibility: boolean;
    screenRecording: boolean;
  };
  willHide?: Array<{ appIdentifier: string; displayName: string }>;
  /** Same semantics as `CuPermissionRequest.autoUnhideEnabled`. */
  autoUnhideEnabled?: boolean;
}
