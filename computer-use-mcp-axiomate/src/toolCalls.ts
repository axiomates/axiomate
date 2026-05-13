/**
 * Tool dispatch. Every security decision from plan §2 is enforced HERE,
 * before any executor method is called.
 *
 * Enforcement order, every call:
 *   1. Kill switch (`adapter.isDisabled()`).
 *   2. TCC gate (`adapter.ensureOsPermissions()`). `request_access` is
 *      exempted — it threads the ungranted state to the renderer so the
 *      user can grant TCC perms from inside the approval dialog.
 *   3. Tool-specific gates (see dispatch table) — ANY exception in a gate
 *      returns a tool error, executor never called.
 *   4. Executor call.
 *
 * For input actions (click/type/key/scroll/drag/move_mouse) the tool-specific
 * gates are, in order:
 *   a. `prepareForAction` — hide every non-allowlisted app, then defocus us
 *      (battle-tested pre-action sequence from the Vercept acquisition).
 *      Sub-gated via `hideBeforeAction`. After this runs the screenshot is
 *      TRUE (what the
 *      model sees IS what's at each pixel) and we are not keyboard-focused.
 *   b. Frontmost gate — branched by actionKind:
 *        mouse:    frontmost ∈ allowlist ∪ {hostAppIdentifier, Finder} → pass.
 *                  hostAppIdentifier passes because the executor's
 *                  `withClickThrough` bracket makes us click-through.
 *        keyboard: frontmost ∈ allowlist ∪ {Finder} → pass.
 *                  hostAppIdentifier → ERROR (safety net — defocus should have
 *                  moved us off; if it didn't, typing would go into our
 *                  own chat box).
 *      After step (a) this gate fires RARELY — only when something popped
 *      up between prepare and action, or the 5-try hide loop gave up.
 *      Checked FRESH on every call, not cached across calls.
 *
 * For click variants only, AFTER the above gates but BEFORE the executor call:
 *   c. Pixel-validation staleness check (sub-gated).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

import { handleVisionLocate } from "./clickTarget.js";
import type { Mark } from "./clickTarget.js";
import { computeDynamicOverlayCap, detectElementsMultiSource, detectElementsMultiSourceDetailed, selectSpatiallyDistributedMarks, summarizeMarks } from "./detection.js";
import { getDefaultTierForApp, getDeniedCategoryForApp, isPolicyDenied } from "./deniedApps.js";

/**
 * Allowlist enforcement is fully default-open. The `AXIOMATE_CU_BYPASS_ALLOWLIST`
 * env var and the `getAllowlistBypassed` host getter were retired; the user
 * explicitly determined that allowlist-as-security provides no value (window-
 * level visibility control is not a security boundary). All gates
 * (runInputActionGates, runHitTestGate, handleOpenApplication pre-launch,
 * handleScreenshot empty-allowlist auto-trigger) early-return as bypassed.
 *
 * Helper retained as a single rename point so a future "strict mode" flag
 * (per-session opt-in) can re-enable enforcement without re-touching every
 * call site.
 */
function isAllowlistBypassed(): boolean {
  return true;
}
import type {
  ComputerExecutor,
  DisplayGeometry,
  InstalledApp,
  ScreenshotResult,
} from "./executor.js";
import { isSystemKeyCombo } from "./keyBlocklist.js";

import { SENTINEL_APP_IDENTIFIERS } from "./sentinelApps.js";
import type {
  AppGrant,
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CoordinateMode,
  CuAppPermTier,
  CuGrantFlags,
  CuPermissionRequest,
  CuSubGates,
  CuTeachPermissionRequest,
  Logger,
  ResolvedAppRequest,
  TeachStepRequest,
} from "./types.js";
import { allowedAppsOf, userDeniedAppIdentifiersOf } from "./types.js";

/**
 * Finder is never hidden by the hide loop (hiding Finder kills the Desktop),
 * so it's always a valid frontmost.
 */
const FINDER_APP_IDENTIFIER = "com.apple.finder";

/**
 * Categorical error classes for the cu_tool_call telemetry event. Never
 * free text — error messages may contain file paths / app content (PII).
 */
export type CuErrorKind =
  | "allowlist_empty"
  | "tcc_not_granted"
  | "cu_lock_held"
  | "teach_mode_conflict"
  | "teach_mode_not_active"
  | "executor_threw"
  | "capture_failed"
  | "app_denied" // no longer emitted (tiered model replaced hard-deny); kept for schema compat
  | "bad_args" // malformed tool args (type/shape/range/unknown value)
  | "app_not_granted" // target app not in session allowlist (distinct from allowlist_empty)
  | "tier_insufficient" // app in allowlist but at a tier too low for the action
  | "feature_unavailable" // tool callable but session not wired for it
  | "state_conflict" // wrong state for action (call sequence, mouse already held)
  | "grant_flag_required" // action needs a grant flag (systemKeyCombos, clipboard*) from request_access
  | "display_error" // display enumeration failed (platform)
  | "other";

/**
 * Telemetry payload piggybacked on the result — populated by handlers,
 * consumed and stripped by the host wrapper (serverDef.ts) before the
 * result goes to the SDK. Same pattern as `screenshot`.
 */
export interface CuCallTelemetry {
  /** request_access / request_teach_access: apps NEWLY granted in THIS call
   *  (does NOT include idempotent re-grants of already-allowed apps). */
  granted_count?: number;
  /** request_access / request_teach_access: apps denied in THIS call */
  denied_count?: number;
  /** request_access / request_teach_access: apps safety-denied (browser) this call */
  denied_browser_count?: number;
  /** request_access / request_teach_access: apps safety-denied (terminal) this call */
  denied_terminal_count?: number;
  /** Categorical error class (only set when isError) */
  error_kind?: CuErrorKind;
}

/**
 * `CallToolResult` augmented with the screenshot payload. `bindSessionContext`
 * reads `result.screenshot` after a `screenshot` tool call and stashes it in a
 * closure cell for the next pixel-validation. MCP clients never see this
 * field — the host wrapper strips it before returning to the SDK.
 */
export type CuCallToolResult = CallToolResult & {
  screenshot?: ScreenshotResult;
  /** Piggybacked telemetry — stripped by the host wrapper before SDK return. */
  telemetry?: CuCallTelemetry;
};

// ---------------------------------------------------------------------------
// Small result helpers (mirror of chrome-mcp's inline `{content, isError}`)
// ---------------------------------------------------------------------------

function errorResult(text: string, errorKind?: CuErrorKind): CuCallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    telemetry: errorKind ? { error_kind: errorKind } : undefined,
  };
}

function okText(text: string): CuCallToolResult {
  return { content: [{ type: "text", text }] };
}

function okJson(obj: unknown, telemetry?: CuCallTelemetry): CuCallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    telemetry,
  };
}

function supportsVisionForFeedback(adapter: ComputerUseHostAdapter): boolean {
  return adapter.currentModelSupportsImages();
}

type VisibleWindowContext = {
  name: string;
  /** Virtual coords (image-space), clipped to the surrounding region if a scope was applied. */
  rect: { x: number; y: number; w: number; h: number };
  isForeground?: boolean;
  /** taskbar / desktop / menu_bar / Dock — shell-owned chrome */
  isChrome?: boolean;
  /** Number of `marks` whose (x, y) center falls inside `rect`. */
  markCount: number;
};

function buildTextFirstSoMBlock(
  marks: Mark[],
  shownCount: number,
  rect: { x: number; y: number; w: number; h: number },
  opts?: {
    query?: string;
    includePriorityHint?: boolean;
    stats?: {
      traversedCount: number;
      matchedCount: number;
      returnedCount: number;
      truncated: boolean;
      truncationReason?: "traversal_budget" | "output_budget";
    };
    /**
     * Visible normal-sized windows in the captured region. Surfaced as
     * an explicit listing so the model knows what apps are on screen
     * (in addition to the marks themselves) and which apps have marks
     * that didn't make the shownCount cut.
     */
    windows?: VisibleWindowContext[];
  },
): string {
  if (marks.length === 0) return "";
  const shownMarks = marks.slice(0, shownCount);
  const summary = summarizeMarks(marks, rect, {
    shownCount,
    query: opts?.query,
  });

  let text =
    `\n\nText SoM summary: ${summary.shownCount} of ${summary.totalCount} detected UI elements are listed below. `;
  if (summary.hiddenCount > 0) {
    text += `${summary.hiddenCount} additional elements were not listed directly. `;
  }
  if (opts?.includePriorityHint) {
    text += `Use text SoM + mark_id; do not guess screen coordinates.`;
  }
  if (opts?.stats?.truncated) {
    const reason = opts.stats.truncationReason === "traversal_budget"
      ? "Traversal budget stopped native enumeration early."
      : "Output budget limited how many items are surfaced directly.";
    text += ` ${reason}`;
  }

  if (opts?.windows && opts.windows.length > 0) {
    text += `\n\nVisible windows (${opts.windows.length}):`;
    for (const w of opts.windows) {
      const labels: string[] = [];
      if (w.isForeground) labels.push("foreground");
      if (w.isChrome) labels.push("chrome");
      const labelStr = labels.length > 0 ? ` (${labels.join("/")})` : " (background)";
      const x1 = w.rect.x + w.rect.w;
      const y1 = w.rect.y + w.rect.h;
      text += `\n  - ${w.name}${labelStr} rect=[${w.rect.x},${w.rect.y},${x1},${y1}] — ${w.markCount} marks`;
    }
  }

  // Group shownMarks by sourceWindowName so the model can quickly see
  // which app contributes which controls. Marks without attribution
  // (point-in-rect didn't match any tracked window) fall into "(no
  // window)". Group order follows mark order — group label appears at
  // the position of its first mark, preserving overall priority.
  const groupOrder: string[] = [];
  const groups = new Map<string, Mark[]>();
  for (const m of shownMarks) {
    const key = m.sourceWindowName ?? "(no window)";
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key)!.push(m);
  }
  if (groupOrder.length <= 1) {
    // All marks share one source (or none) — skip the group headers
    // since they'd just add noise.
    for (const m of shownMarks) {
      const nameLabel = m.name ? `"${m.name}"` : "(unnamed)";
      const idLabel = m.automationId ? ` id=${m.automationId}` : "";
      text += `\n  #${m.id} ${m.role || "?"} ${nameLabel}${idLabel} center=(${m.x}, ${m.y})`;
    }
  } else {
    for (const key of groupOrder) {
      text += `\n  ${key}:`;
      for (const m of groups.get(key)!) {
        const nameLabel = m.name ? `"${m.name}"` : "(unnamed)";
        const idLabel = m.automationId ? ` id=${m.automationId}` : "";
        text += `\n    #${m.id} ${m.role || "?"} ${nameLabel}${idLabel} center=(${m.x}, ${m.y})`;
      }
    }
  }

  if (summary.queryHits.length > 0) {
    text += `\n\nQuery-relevant elements:`;
    for (const m of summary.queryHits.slice(0, 5)) {
      const nameLabel = m.name ? `"${m.name}"` : "(unnamed)";
      text += `\n  #${m.id} ${m.role || "?"} ${nameLabel}`;
    }
  }

  if (summary.roleCounts.length > 0) {
    text += `\n\nRole groups: ${summary.roleCounts
      .slice(0, 6)
      .map(({ role, count }) => `${role}=${count}`)
      .join(", ")}.`;
  }

  if (summary.tiles.length > 0 && summary.hiddenCount > 0) {
    text += `\n\nDense regions (for follow-up zoom or narrower inspection):`;
    for (const tile of summary.tiles.slice(0, 4)) {
      const names = tile.sampleNames.length > 0 ? ` names=${tile.sampleNames.map(n => `"${n}"`).join(",")}` : "";
      const roles = tile.roleCounts.length > 0
        ? ` roles=${tile.roleCounts.map(r => `${r.role}:${r.count}`).join(",")}`
        : "";
      text += `\n  ${tile.id} rect=[${tile.x},${tile.y},${tile.x + tile.w},${tile.y + tile.h}] count=${tile.count}${roles}${names}`;
    }
  }

  text += `\nPass \`mark_id: N\` to mouse_move to jump cursor to mark N's center.`;
  return text;
}

function buildToolModeHint(
  adapter: ComputerUseHostAdapter,
  tool: "screenshot" | "screenshot_window" | "zoom",
): string {
  if (supportsVisionForFeedback(adapter)) return "";

  switch (tool) {
    case "screenshot":
      return "\n\nCurrent model does not use image content directly here. Focus on text SoM, grouped summaries, and `mark_id`. Do not guess coordinates from rulers.";
    case "screenshot_window":
      return "\n\nCurrent model should treat this as a text-first inspection result. Prefer listed SoM items and `mark_id`; ignore ruler-oriented visual guidance.";
    case "zoom":
      return "\n\nCurrent model should use the text SoM list and dense-region summary below. Do not infer coordinates from the zoom image or rulers.";
  }
}

type VisibleWindowSnapshot = {
  appIdentifier: string;
  displayName: string;
  hwnd?: number;
  rect: { x: number; y: number; w: number; h: number };
  zRank: number;
  isForeground: boolean;
  isHost?: boolean;
  /// Shell-owned system chrome (taskbar / desktop on Win). Used by the zoom
  /// candidate selector to force-include even when its visible area share
  /// is below the area-based threshold — mirrors the full-screen path's
  /// hardcoded Shell_TrayWnd + Progman/WorkerW search roots.
  isSystemChrome?: boolean;
};

type ZoomWindowSnapshot = VisibleWindowSnapshot & {
  visibleRects: Array<{ x: number; y: number; w: number; h: number }>;
  visibleAreaInTarget: number;
  rawIntersectArea: number;
  totalArea: number;
};

type MacVisibleWindowSnapshot = {
  windowId: number;
  appIdentifier: string;
  displayName: string;
  rect: { x: number; y: number; w: number; h: number };
  layer: number;
  zRank: number;
};

async function listWinVisibleWindows(
  adapter: ComputerUseHostAdapter,
): Promise<VisibleWindowSnapshot[]> {
  const anyExecutor = adapter.executor as typeof adapter.executor & {
    listVisibleWindows?: () => Promise<Array<{
      appIdentifier: string;
      displayName: string;
      hwnd?: number;
      rect: { x: number; y: number; w: number; h: number };
      zRank: number;
      isForeground: boolean;
      isHost?: boolean;
      isSystemChrome?: boolean;
    }>>;
  };
  return (await anyExecutor.listVisibleWindows?.()) ?? [];
}

async function listMacVisibleWindows(
  adapter: ComputerUseHostAdapter,
): Promise<MacVisibleWindowSnapshot[]> {
  const anyExecutor = adapter.executor as typeof adapter.executor & {
    listVisibleMacWindows?: () => Promise<Array<{
      windowId: number;
      appIdentifier: string;
      displayName: string;
      rect: { x: number; y: number; w: number; h: number };
      layer: number;
      zRank: number;
    }>>;
  };
  return (await anyExecutor.listVisibleMacWindows?.()) ?? [];
}

async function captureWinForegroundRestoreToken(
  adapter: ComputerUseHostAdapter,
): Promise<{ appIdentifier: string; hwnd?: number; centerX: number; centerY: number; isHost?: boolean } | null> {
  if (adapter.executor.capabilities.platform !== "win32") return null;
  const token = (await (adapter.executor as typeof adapter.executor & {
    captureForegroundRestoreToken?: () => Promise<{
      appIdentifier: string;
      hwnd?: number;
      centerX: number;
      centerY: number;
      isHost?: boolean;
    } | null>;
  }).captureForegroundRestoreToken?.()) ?? null;
  adapter.logger.debug?.(
    `[computer-use] win snapshot foreground token=${token ? JSON.stringify(token) : "<none>"}`,
  );
  // Diagnostic: dump axiomate's own host ancestor chain so we can see
  // whether the visible WindowsTerminal / VS Code is actually in our
  // process tree.
  const getHostPaths = (adapter.executor as typeof adapter.executor & {
    getHostAncestorPaths?: () => Promise<string[]>;
  }).getHostAncestorPaths;
  if (getHostPaths) {
    try {
      const paths = await getHostPaths();
      adapter.logger.debug?.(
        `[computer-use] win host ancestors (${paths.length}): ${paths.join(" -> ")}`,
      );
    } catch {}
  }
  return token;
}

async function restoreWinForegroundToken(
  adapter: ComputerUseHostAdapter,
  token: { appIdentifier: string; hwnd?: number; centerX: number; centerY: number; isHost?: boolean } | null,
): Promise<void> {
  if (!token || adapter.executor.capabilities.platform !== "win32") return;
  try {
    const restored = await (adapter.executor as typeof adapter.executor & {
      restoreForegroundFromToken?: (token: {
        appIdentifier: string;
        hwnd?: number;
        centerX: number;
        centerY: number;
        isHost?: boolean;
      }) => Promise<boolean>;
    }).restoreForegroundFromToken?.(token);
    adapter.logger.debug?.(
      `[computer-use] win restore foreground token=${JSON.stringify(token)} restored=${restored}`,
    );
    await sleep(150);
  } catch {
    // best-effort
  }
}

/**
 * Win-only: run the full UIA enumeration + system-chrome aware probe +
 * z-order restore BEFORE the screenshot is captured. Lets the screenshot
 * reflect the final post-restore state (no focus-side-effect leakage),
 * at the cost of computing display dims independently of the capture.
 *
 * Returns null when getDisplaySize / UIA failed catastrophically — caller
 * falls back to the post-capture path.
 *
 * `winTouched` is mutated by collectWinContextAwareMarks (each probed
 * candidate's appIdentifier gets added). Caller passes it through so the
 * finally block sees the same set the restore step used.
 */
async function runWinPreCaptureUIA(
  adapter: ComputerUseHostAdapter,
  preferredDisplayId: number | undefined,
  winBaseline: VisibleWindowSnapshot[],
  winTouched: Set<string>,
): Promise<{
  marks: Mark[];
  somStats: { traversedCount?: number; matchedCount?: number; returnedCount?: number; truncated?: boolean; truncationReason?: string };
  dims: { width: number; height: number; originX: number; originY: number; displayId: number; virtualW: number; virtualH: number };
} | null> {
  let dims: { displayId: number; width: number; height: number; originX?: number; originY?: number };
  try {
    dims = await adapter.executor.getDisplaySize(preferredDisplayId);
  } catch (e) {
    adapter.logger.debug?.(
      `[computer-use] win pre-capture getDisplaySize failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  const [virtualW, virtualH] = computeImageDim(dims.width, dims.height);
  const ratioX = dims.width / virtualW;
  const ratioY = dims.height / virtualH;
  const originX = dims.originX ?? 0;
  const originY = dims.originY ?? 0;
  const targetPhysicalRect = { x: originX, y: originY, w: dims.width, h: dims.height };

  let marks: Mark[] = [];
  let somStats: any = {};
  try {
    const detection = await detectElementsMultiSourceDetailed(
      adapter.executor,
      { x: 0, y: 0, w: virtualW, h: virtualH },
      { ratioX, ratioY, originX, originY },
      ["uia"],
    );
    marks = detection.marks;
    somStats = detection.stats;
    marks = await collectWinContextAwareMarks(
      adapter, marks, targetPhysicalRect, ratioX, ratioY, originX, originY,
      undefined, winTouched,
    );
  } catch (e) {
    adapter.logger.debug?.(
      `[computer-use] win pre-capture UIA failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Continue to restore + return whatever we got — z-order still needs
    // undoing if any probe ran before the throw.
  }

  if (winTouched.size > 0 && winBaseline.length > 0) {
    try {
      await restoreWinVisibleWindowOrder(adapter, winBaseline, [...winTouched]);
    } catch (e) {
      adapter.logger.debug?.(
        `[computer-use] win pre-capture restore failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Settle DWM compose + per-app focus-out repaints before the screenshot.
  await sleep(80);

  // Layout re-check: if the user moved/resized/closed a window during
  // the ~few-second probe loop, the visibleRects used during UIA are
  // stale and the marks point to where things WERE — drop them.
  // Display-geometry drift is checked separately post-screenshot via
  // `winPreCaptureDimsStable`; this catches the in-display window drift.
  if (marks.length > 0) {
    try {
      const winBaselineAfter = await listWinVisibleWindows(adapter);
      const layoutDelta = winLayoutRectStable(winBaseline, winBaselineAfter);
      if (layoutDelta) {
        adapter.logger.warn(
          `[computer-use] window layout drifted during pre-capture: ${layoutDelta} — discarding SoM marks`,
        );
        marks = [];
        somStats = {};
      }
    } catch (e) {
      adapter.logger.debug?.(
        `[computer-use] win pre-capture layout re-check failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    marks,
    somStats,
    dims: {
      width: dims.width,
      height: dims.height,
      originX,
      originY,
      displayId: dims.displayId ?? 0,
      virtualW,
      virtualH,
    },
  };
}

/**
 * Detect window layout drift between two `listVisibleWindows` snapshots.
 * Returns a short reason string when the layout changed in a way that
 * could invalidate previously-computed mark coordinates (window
 * moved/resized/closed, or a new window appeared somewhere we didn't
 * account for). Returns `null` when stable.
 *
 * Used to invalidate SoM marks when the user dragged/resized/closed a
 * window during the ~5-second screenshot pipeline. Without this check
 * marks reference the t0 layout but the screenshot reflects t1.
 *
 * Host + system-chrome windows are excluded:
 * - Host (axiomate) gets moved off-screen by hideSelf; we restore its
 *   position in `showSelf`, but its rect IN the listVisibleWindows
 *   result during the pipeline is the off-screen rect, not the real
 *   one — comparing it would always trip.
 * - System chrome (Shell_TrayWnd, Progman, WorkerW) — the shell may
 *   resize these in response to DPI / wallpaper events and we don't
 *   want such noise to drop marks. The marks for chrome elements come
 *   from Rust's discover_search_roots which is independent.
 */
function winLayoutRectStable(
  before: VisibleWindowSnapshot[],
  after: VisibleWindowSnapshot[],
  scope?: { x: number; y: number; w: number; h: number },
): string | null {
  const filter = (wins: VisibleWindowSnapshot[]) =>
    wins.filter(w =>
      w.isHost !== true &&
      w.isSystemChrome !== true &&
      // Optional scope: only care about windows whose rect intersects
      // the given region. zoom passes the zoom region's physical rect
      // so unrelated screen-corner window movements don't trigger a
      // false-positive mark drop. screenshot passes no scope (full
      // display matters).
      (!scope || rectsIntersect(w.rect, scope)),
    );
  const b = filter(before);
  const a = filter(after);
  // Index by hwnd — appIdentifier alone collides (two File Explorer
  // windows share the explorer.exe path). hwnd identifies the exact
  // top-level window we tracked.
  const ai = new Map(a.map(w => [w.hwnd ?? -1, w]));
  for (const bw of b) {
    const aw = ai.get(bw.hwnd ?? -1);
    if (!aw) return `closed: ${bw.displayName} hwnd=${bw.hwnd ?? "?"}`;
    if (
      bw.rect.x !== aw.rect.x ||
      bw.rect.y !== aw.rect.y ||
      bw.rect.w !== aw.rect.w ||
      bw.rect.h !== aw.rect.h
    ) {
      return `moved/resized: ${bw.displayName} ${bw.rect.x},${bw.rect.y} ${bw.rect.w}x${bw.rect.h} → ${aw.rect.x},${aw.rect.y} ${aw.rect.w}x${aw.rect.h}`;
    }
  }
  const bi = new Map(b.map(w => [w.hwnd ?? -1, w]));
  for (const aw of a) {
    if (!bi.has(aw.hwnd ?? -1)) {
      return `new: ${aw.displayName} hwnd=${aw.hwnd ?? "?"}`;
    }
  }
  return null;
}

/**
 * Validate that display geometry didn't drift between the pre-capture
 * UIA pass (which used `pre`) and the screenshot's captured dimensions
 * (`shot`). When they disagree the marks reference stale coordinates;
 * caller should drop them and warn.
 */
function winPreCaptureDimsStable(
  pre: { width: number; height: number; originX: number; originY: number; displayId: number; virtualW: number; virtualH: number },
  shot: { displayWidth?: number; displayHeight?: number; originX?: number; originY?: number; displayId?: number; width: number; height: number },
): boolean {
  return (
    pre.width === shot.displayWidth &&
    pre.height === shot.displayHeight &&
    pre.originX === (shot.originX ?? 0) &&
    pre.originY === (shot.originY ?? 0) &&
    pre.displayId === (shot.displayId ?? 0) &&
    pre.virtualW === shot.width &&
    pre.virtualH === shot.height
  );
}

async function restoreWinVisibleWindowOrder(
  adapter: ComputerUseHostAdapter,
  baseline: VisibleWindowSnapshot[],
  touchedAppIdentifiers: string[],
): Promise<void> {
  if (adapter.executor.capabilities.platform !== "win32") return;
  const focusApp = (adapter.executor as typeof adapter.executor & {
    focusAppWindow?: (appIdentifier: string) => Promise<boolean>;
  }).focusAppWindow;
  if (!focusApp) return;
  const touched = new Set(touchedAppIdentifiers.filter(Boolean));
  if (touched.size === 0) return;
  // Ensure the original foreground (user-side OR host) ends up on top after
  // restoring. Without this, focusing only the probed apps leaves the
  // lowest-zRank probed window foreground — and the originally-foreground
  // window stays buried. Host is treated the same as user apps here; the
  // caller is responsible for adding host appIdentifiers to `touched` when
  // it has manipulated host placement (i.e. after hideSelf).
  const originalFg = baseline.find(w => w.isForeground);
  if (originalFg) touched.add(originalFg.appIdentifier);
  // Focusing a touched window during probing brings it from its baseline
  // zRank=k up to zRank=0, pushing every window that was at zRank<k down
  // by 1. So the disturbed range is [0..max(touched zRank)] — windows at
  // zRank > max_touched stayed put. To undo, re-focus the WHOLE disturbed
  // range in baseline zRank-desc order (deepest first, originally-fg last).
  // Touching only the explicitly-touched windows is not enough: an untouched
  // window sandwiched between two touched ones at different zRanks ends up
  // in the wrong slot (it was displaced by the deeper-touched window but
  // we never put it back).
  //
  // Exclude `isSystemChrome` windows (taskbar, desktop) entirely: the OS
  // manages their position, focusAppWindow("explorer.exe") is ambiguous
  // when both Shell_TrayWnd and an open File Explorer window share the
  // exe path, and probing chrome doesn't actually displace user-window
  // z-order in a way that needs undoing.
  const nonChrome = baseline.filter(w => w.isSystemChrome !== true);
  const touchedZRanks = nonChrome
    .filter(w => touched.has(w.appIdentifier))
    .map(w => w.zRank);
  if (touchedZRanks.length === 0) return;
  const maxTouchedZRank = Math.max(...touchedZRanks);
  const restoreOrder = nonChrome
    .filter(w => w.zRank <= maxTouchedZRank)
    .sort((a, b) => b.zRank - a.zRank);
  adapter.logger.debug?.(
    `[computer-use] win restore window order touched=${JSON.stringify([...touched])} order=${restoreOrder.map(w => `${w.displayName}@${w.zRank}`).join(" -> ")}`,
  );
  for (const win of restoreOrder) {
    try {
      adapter.logger.debug?.(
        `[computer-use] win restore focusAppWindow app=${win.appIdentifier} display=${win.displayName} zRank=${win.zRank}`,
      );
      await focusApp(win.appIdentifier);
      await sleep(80);
    } catch {
      // best-effort
    }
  }
}

function rectIntersection(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function subtractRect(
  base: { x: number; y: number; w: number; h: number },
  occluder: { x: number; y: number; w: number; h: number },
): Array<{ x: number; y: number; w: number; h: number }> {
  const overlap = rectIntersection(base, occluder);
  if (!overlap) return [base];
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (overlap.y > base.y) {
    out.push({ x: base.x, y: base.y, w: base.w, h: overlap.y - base.y });
  }
  if (overlap.y + overlap.h < base.y + base.h) {
    out.push({
      x: base.x,
      y: overlap.y + overlap.h,
      w: base.w,
      h: base.y + base.h - (overlap.y + overlap.h),
    });
  }
  if (overlap.x > base.x) {
    out.push({
      x: base.x,
      y: overlap.y,
      w: overlap.x - base.x,
      h: overlap.h,
    });
  }
  if (overlap.x + overlap.w < base.x + base.w) {
    out.push({
      x: overlap.x + overlap.w,
      y: overlap.y,
      w: base.x + base.w - (overlap.x + overlap.w),
      h: overlap.h,
    });
  }
  return out.filter(r => r.w > 0 && r.h > 0);
}

function visibleRegionsForWindow(
  target: VisibleWindowSnapshot,
  all: VisibleWindowSnapshot[],
): Array<{ x: number; y: number; w: number; h: number }> {
  let regions = [target.rect];
  for (const win of all) {
    if (win.zRank >= target.zRank) continue;
    if (win.appIdentifier === target.appIdentifier && win.rect.x === target.rect.x && win.rect.y === target.rect.y && win.rect.w === target.rect.w && win.rect.h === target.rect.h) {
      continue;
    }
    const next: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const region of regions) {
      next.push(...subtractRect(region, win.rect));
    }
    regions = next;
    if (regions.length === 0) break;
  }
  return regions;
}

function pointInRects(
  x: number,
  y: number,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): boolean {
  return rects.some(r => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
}

function filterMarksByVisibleRegions(
  marks: Mark[],
  visibleRects: Array<{ x: number; y: number; w: number; h: number }>,
): Mark[] {
  if (visibleRects.length === 0) return [];
  return marks.filter(mark => pointInRects(mark.x, mark.y, visibleRects));
}

function physicalRectToVirtualRect(
  rect: { x: number; y: number; w: number; h: number },
  ratioX: number,
  ratioY: number,
  originX: number,
  originY: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round((rect.x - originX) / ratioX),
    y: Math.round((rect.y - originY) / ratioY),
    w: Math.round(rect.w / ratioX),
    h: Math.round(rect.h / ratioY),
  };
}

/**
 * Count how many marks have their center inside `rect`. Used to attribute
 * shown marks back to source windows for the "Visible windows" SoM block.
 *
 * Approximate — a mark could legitimately overlap two windows at their
 * boundary (e.g., a button straddling a docked sidebar). Point-in-rect
 * gives reasonable per-window counts without per-mark source tracking
 * (which would require new fields on Mark + tagging in the probe loops).
 */

/**
 * Compute per-window mark counts in priority order, assigning each mark
 * to AT MOST one window (the first whose effective rect contains the
 * mark's center). Replaces the previous raw point-in-rect counting in
 * buildWinVisibleWindowsContext / buildMacVisibleWindowsContext where
 * buried windows could claim overlapping foreground marks and the same
 * mark could be double-counted across overlapping windows.
 *
 * `entries` MUST already be sorted in priority order (foreground first,
 * non-chrome before chrome, area desc) — caller's responsibility.
 */
function attributeMarksToEntries(
  marks: Mark[],
  entries: Array<{ name: string; rect: { x: number; y: number; w: number; h: number } }>,
): { counts: number[]; attributed: Mark[] } {
  const counts = entries.map(() => 0);
  const assignedIdx = new Array<number>(marks.length).fill(-1);
  // Map from entry name → first-occurrence index for honoring pre-tagged
  // marks (Win zoom's per-candidate probe pre-sets sourceWindowName).
  const nameToFirstIdx = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const n = entries[i]!.name;
    if (!nameToFirstIdx.has(n)) nameToFirstIdx.set(n, i);
  }
  for (let mi = 0; mi < marks.length; mi++) {
    const m = marks[mi]!;
    // Honor pre-tag from the probe loop when the tag matches a listed
    // window — this is more accurate than point-in-rect for overlapping
    // windows. Falls back to point-in-rect when no pre-tag (or pre-tag
    // names a window outside the current scope).
    if (m.sourceWindowName !== undefined) {
      const ei = nameToFirstIdx.get(m.sourceWindowName);
      if (ei !== undefined) {
        counts[ei]++;
        assignedIdx[mi] = ei;
        continue;
      }
    }
    for (let ei = 0; ei < entries.length; ei++) {
      const r = entries[ei]!.rect;
      if (
        m.x >= r.x &&
        m.x < r.x + r.w &&
        m.y >= r.y &&
        m.y < r.y + r.h
      ) {
        counts[ei]++;
        assignedIdx[mi] = ei;
        break;
      }
    }
  }
  const attributed = marks.map((m, mi) => {
    const ei = assignedIdx[mi]!;
    if (ei < 0) return m;
    const name = entries[ei]!.name;
    return m.sourceWindowName === name ? m : { ...m, sourceWindowName: name };
  });
  return { counts, attributed };
}

/**
 * Compute the set of marks to draw as red circles on a screenshot.
 *
 * Invariant: circle count ≤ text-list count (TEXT_SOM_CAP). The text
 * list shows marks in priority order (UIA walk order); circles are a
 * spatially-distributed subset of that same list so every circled id
 * appears in the text. Dynamic cap scales with image area (sparse on
 * full-screen, dense on small zoom regions), bounded [5..50].
 *
 * Marks outside the image bounds are dropped before sampling so the
 * overlay cap isn't wasted on pixels the native blend_px silently clips.
 *
 * Returns undefined when there's nothing to draw.
 */
const TEXT_SOM_CAP = 50;

function computePreCaptureOverlayMarks(
  marks: Mark[],
  imgW: number,
  imgH: number,
): Array<{ id: number; x: number; y: number }> | undefined {
  const filtered = imgW > 0 && imgH > 0
    ? marks.filter(m => m.x >= 0 && m.x < imgW && m.y >= 0 && m.y < imgH)
    : marks;
  if (filtered.length === 0) return undefined;
  // Never exceed the text-list cap — circles are a subset of the text list.
  const textSlice = filtered.slice(0, TEXT_SOM_CAP);
  const dynCap = computeDynamicOverlayCap(imgW, imgH);
  const circleCap = Math.min(textSlice.length, dynCap);
  const sampled = selectSpatiallyDistributedMarks(textSlice, circleCap);
  if (sampled.length === 0) return undefined;
  return sampled.map(m => ({ id: m.id, x: m.x, y: m.y }));
}

async function applyMacMarkOverlay(
  executor: ComputerExecutor,
  shot: { base64: string; width: number; height: number },
  attributedMarks: Mark[],
  shownCount: number,
  logger: ComputerUseHostAdapter["logger"],
): Promise<void> {
  if (!executor.drawMarksOnScreenshot) return;
  try {
    // Circles are a spatially-distributed subset of the text-list slice
    // (marks[0..shownCount]). shownCount ≤ TEXT_SOM_CAP so circles
    // never exceed the text listing.
    const textSlice = attributedMarks.slice(0, shownCount);
    const circleCap = Math.min(textSlice.length, computeDynamicOverlayCap(shot.width, shot.height));
    const sampled = selectSpatiallyDistributedMarks(textSlice, circleCap);
    if (sampled.length === 0) return;
    const overlayMarks = sampled.map(m => ({ id: m.id, x: m.x, y: m.y }));
    shot.base64 = await executor.drawMarksOnScreenshot({
      base64: shot.base64,
      imageWidth: shot.width,
      imageHeight: shot.height,
      marks: overlayMarks,
    });
  } catch (e) {
    logger.debug?.(
      `[computer-use] mac drawMarksOnScreenshot failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

const VISIBLE_WINDOWS_CAP = 8;
const VISIBLE_WINDOWS_MIN_SIDE = 100;

/**
 * Build per-window context + attribute marks. Returns the contexts (with
 * accurate markCount) AND the attributed marks array (each mark's
 * sourceWindowName matches the window it was credited to). Caller should
 * use the returned attributed marks for downstream text rendering so the
 * "Visible windows" totals match the per-window group listings.
 */
function buildWinVisibleWindowsContext(
  baseline: VisibleWindowSnapshot[],
  marks: Mark[],
  ratioX: number,
  ratioY: number,
  originX: number,
  originY: number,
  scope?: { x: number; y: number; w: number; h: number },
  /**
   * If supplied, restrict the output to windows whose displayName is in
   * this set. Used by `zoom` where only a bounded candidate set is
   * actually UIA-probed — windows we didn't probe can't honestly report
   * a mark count, so we omit them entirely rather than claim
   * `markCount=0` (which falsely implies "no interactive elements here").
   */
  probedWindowNames?: Set<string>,
): { contexts: VisibleWindowContext[]; attributed: Mark[] } {
  // Step 1: filter + map to effective rect, drop windows that don't
  // intersect scope.
  const stage1 = baseline
    .filter(
      w =>
        w.isHost !== true &&
        w.rect.w >= VISIBLE_WINDOWS_MIN_SIDE &&
        w.rect.h >= VISIBLE_WINDOWS_MIN_SIDE &&
        (probedWindowNames ? probedWindowNames.has(w.displayName) : true),
    )
    .map(w => {
      const virtual = physicalRectToVirtualRect(w.rect, ratioX, ratioY, originX, originY);
      const effective = scope ? rectIntersection(virtual, scope) : virtual;
      return { snapshot: w, effective };
    })
    .filter((e): e is { snapshot: VisibleWindowSnapshot; effective: { x: number; y: number; w: number; h: number } } =>
      e.effective !== null,
    );

  // Step 2: sort in priority order so attribution credits foreground /
  // normal windows BEFORE buried / chrome ones for marks in overlap regions.
  stage1.sort((a, b) => {
    if (a.snapshot.isForeground !== b.snapshot.isForeground) {
      return a.snapshot.isForeground ? -1 : 1;
    }
    const aChrome = a.snapshot.isSystemChrome === true;
    const bChrome = b.snapshot.isSystemChrome === true;
    if (aChrome !== bChrome) return aChrome ? 1 : -1;
    return windowRectArea(b.effective) - windowRectArea(a.effective);
  });

  // Step 3: attribute marks (each mark → at most one window) and count.
  const entries = stage1.map(s => ({ name: s.snapshot.displayName, rect: s.effective }));
  const { counts, attributed } = attributeMarksToEntries(marks, entries);

  // Step 4: build contexts using the attributed counts, cap to N.
  const contexts: VisibleWindowContext[] = stage1.map((s, i) => ({
    name: s.snapshot.displayName,
    rect: s.effective,
    isForeground: s.snapshot.isForeground,
    isChrome: s.snapshot.isSystemChrome === true,
    markCount: counts[i]!,
  })).slice(0, VISIBLE_WINDOWS_CAP);

  return { contexts, attributed };
}

function buildMacVisibleWindowsContext(
  baseline: MacVisibleWindowSnapshot[],
  marks: Mark[],
  ratioX: number,
  ratioY: number,
  originX: number,
  originY: number,
  scope?: { x: number; y: number; w: number; h: number },
  /** See buildWinVisibleWindowsContext for semantics. */
  probedWindowNames?: Set<string>,
): { contexts: VisibleWindowContext[]; attributed: Mark[] } {
  const stage1 = baseline
    .filter(
      w =>
        // layer 0 = normal app windows; menu bar / Dock / status items
        // are higher layers and surface separately as "chrome" marks
        // already (via discover_search_roots' hardcoded roots).
        w.layer === 0 &&
        w.rect.w >= VISIBLE_WINDOWS_MIN_SIDE &&
        w.rect.h >= VISIBLE_WINDOWS_MIN_SIDE &&
        (probedWindowNames ? probedWindowNames.has(w.displayName) : true),
    )
    .map(w => {
      const virtual = physicalRectToVirtualRect(w.rect, ratioX, ratioY, originX, originY);
      const effective = scope ? rectIntersection(virtual, scope) : virtual;
      return { snapshot: w, effective };
    })
    .filter((e): e is { snapshot: MacVisibleWindowSnapshot; effective: { x: number; y: number; w: number; h: number } } =>
      e.effective !== null,
    );

  stage1.sort((a, b) => {
    const aFg = a.snapshot.zRank === 0;
    const bFg = b.snapshot.zRank === 0;
    if (aFg !== bFg) return aFg ? -1 : 1;
    return windowRectArea(b.effective) - windowRectArea(a.effective);
  });

  const entries = stage1.map(s => ({ name: s.snapshot.displayName, rect: s.effective }));
  const { counts, attributed } = attributeMarksToEntries(marks, entries);

  const contexts: VisibleWindowContext[] = stage1.map((s, i) => ({
    name: s.snapshot.displayName,
    rect: s.effective,
    isForeground: s.snapshot.zRank === 0,
    isChrome: false,
    markCount: counts[i]!,
  })).slice(0, VISIBLE_WINDOWS_CAP);

  return { contexts, attributed };
}

function dedupeMarks(marks: Mark[]): Mark[] {
  const seen = new Set<string>();
  const out: Mark[] = [];
  for (const mark of marks) {
    const key = [
      mark.automationId ?? "",
      mark.role ?? "",
      mark.name ?? "",
      Math.round(mark.x),
      Math.round(mark.y),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...mark, id: out.length + 1 });
  }
  return out;
}

function windowRectArea(rect: { x: number; y: number; w: number; h: number }): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function rectIntersectionArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const hit = rectIntersection(a, b);
  return hit ? windowRectArea(hit) : 0;
}

function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return rectIntersection(a, b) !== null;
}

function visibleAreaWithinTarget(
  visibleRects: Array<{ x: number; y: number; w: number; h: number }>,
  target: { x: number; y: number; w: number; h: number },
): number {
  let total = 0;
  for (const rect of visibleRects) {
    const hit = rectIntersection(rect, target);
    if (hit) total += windowRectArea(hit);
  }
  return total;
}

function sortZoomWindowCandidates<T extends ZoomWindowSnapshot>(
  windows: T[],
  cursor: { x: number; y: number } | null,
): T[] {
  const ownsCursor = (win: T): boolean => {
    if (!cursor) return false;
    return win.visibleRects.some(
      r => cursor.x >= r.x && cursor.x < r.x + r.w && cursor.y >= r.y && cursor.y < r.y + r.h,
    );
  };
  return [...windows].sort((a, b) => {
    // Cursor first: "what the user is pointing at" is the strongest
    // intent signal — mirrors selectWinProbeCandidates' ranking for the
    // full-screen probe path (toolCalls.ts:670-693).
    const aCursor = ownsCursor(a);
    const bCursor = ownsCursor(b);
    if (aCursor !== bCursor) return aCursor ? -1 : 1;
    return (
      b.visibleAreaInTarget - a.visibleAreaInTarget ||
      b.rawIntersectArea - a.rawIntersectArea ||
      a.zRank - b.zRank ||
      b.totalArea - a.totalArea
    );
  });
}

function selectZoomWindowCandidates<T extends ZoomWindowSnapshot>(
  windows: T[],
  cursor: { x: number; y: number } | null = null,
  cap = 4,
): T[] {
  if (windows.length === 0) return [];
  const sorted = sortZoomWindowCandidates(windows, cursor);

  // Take top-`cap` by sort order (no area-ratio gate — zoom is meant to
  // surface every interactable thing in a small region, so a 70%-of-the-
  // primary secondary still matters).
  const picked: T[] = [];
  const pickedSet = new Set<T>();
  for (const win of sorted) {
    if (picked.length >= cap) break;
    if (win.visibleAreaInTarget <= 0) continue;
    picked.push(win);
    pickedSet.add(win);
  }

  // Force-include any system chrome (taskbar / desktop on Win) that has
  // any visible share in the zoom region but didn't make the cap-limited
  // cut. Without this, "zoom to the bottom-right corner and tell me what
  // that tray icon is" silently misses Shell_TrayWnd / Progman entirely
  // when a foreground window dominates the area.
  for (const win of sorted) {
    if (win.isSystemChrome !== true) continue;
    if (win.visibleAreaInTarget <= 0) continue;
    if (pickedSet.has(win)) continue;
    picked.push(win);
    pickedSet.add(win);
  }

  return picked;
}

function buildWinZoomWindowCandidates(
  baseline: VisibleWindowSnapshot[],
  targetRect: { x: number; y: number; w: number; h: number },
): ZoomWindowSnapshot[] {
  return baseline
    .filter(win =>
      win.isHost !== true &&
      win.rect.w > 0 &&
      win.rect.h > 0 &&
      rectsIntersect(win.rect, targetRect),
    )
    .map(win => {
      const visibleRects = visibleRegionsForWindow(win, baseline);
      return {
        ...win,
        visibleRects,
        visibleAreaInTarget: visibleAreaWithinTarget(visibleRects, targetRect),
        rawIntersectArea: rectIntersectionArea(win.rect, targetRect),
        totalArea: windowRectArea(win.rect),
      };
    })
    .filter(win => win.visibleAreaInTarget > 0);
}

function buildMacZoomWindowCandidates(
  baseline: MacVisibleWindowSnapshot[],
  targetRect: { x: number; y: number; w: number; h: number },
): Array<ZoomWindowSnapshot & { windowId: number; layer: number }> {
  let regions = baseline.map(win => ({
    ...win,
    visibleRects: [win.rect],
  }));
  for (let idx = 0; idx < regions.length; idx += 1) {
    const target = regions[idx]!;
    let visibleRects = [target.rect];
    for (let ahead = 0; ahead < idx; ahead += 1) {
      const occluder = regions[ahead]!;
      const next: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const rect of visibleRects) {
        next.push(...subtractRect(rect, occluder.rect));
      }
      visibleRects = next;
      if (visibleRects.length === 0) break;
    }
    target.visibleRects = visibleRects;
  }
  return regions
    .filter(win => rectsIntersect(win.rect, targetRect))
    .map(win => ({
      appIdentifier: win.appIdentifier,
      displayName: win.displayName,
      hwnd: undefined,
      rect: win.rect,
      zRank: win.zRank,
      isForeground: win.zRank === 0,
      isHost: false,
      visibleRects: win.visibleRects,
      visibleAreaInTarget: visibleAreaWithinTarget(win.visibleRects, targetRect),
      rawIntersectArea: rectIntersectionArea(win.rect, targetRect),
      totalArea: windowRectArea(win.rect),
      windowId: win.windowId,
      layer: win.layer,
    }))
    .filter(win => win.visibleAreaInTarget > 0);
}

function selectWinProbeCandidates(
  baseline: VisibleWindowSnapshot[],
  targetRect: { x: number; y: number; w: number; h: number },
  cap = 4,
  cursor: { x: number; y: number } | null = null,
): Array<VisibleWindowSnapshot & { visibleRects: Array<{ x: number; y: number; w: number; h: number }> }> {
  // A window "owns the cursor" if the pointer falls inside any of its
  // visible regions. The cursor is preserved through hideSelf (SetWindowPos
  // only moves windows, not the pointer), so this remains the strongest
  // "what is the user actually pointing at" signal even after axiomate
  // jumped off-screen. It dominates the area + z-rank fallback so that
  // probing a small but hovered widget wins over a large unattended pane.
  const ownsCursor = (
    win: { visibleRects: Array<{ x: number; y: number; w: number; h: number }> },
  ): boolean => {
    if (!cursor) return false;
    return win.visibleRects.some(
      r => cursor.x >= r.x && cursor.x < r.x + r.w && cursor.y >= r.y && cursor.y < r.y + r.h,
    );
  };
  return baseline
    .filter(win =>
      !win.isForeground &&
      // Skip system chrome (taskbar / desktop). Rust's discover_search_roots
      // already enumerates Shell_TrayWnd + Progman/WorkerW as hardcoded
      // roots in the initial full-screen UIA pass, so probing them via
      // screenshotWindow(app) would be redundant work AND would consume a
      // probe-cap slot that a real user window needs.
      win.isSystemChrome !== true &&
      win.rect.w >= 100 &&
      win.rect.h >= 100 &&
      rectsIntersect(win.rect, targetRect),
    )
    .map(win => {
      const visibleRects = visibleRegionsForWindow(win, baseline);
      return { ...win, visibleRects };
    })
    .filter(win => visibleAreaWithinTarget(win.visibleRects, targetRect) > 0)
    .sort((a, b) => {
      const aCursor = ownsCursor(a);
      const bCursor = ownsCursor(b);
      if (aCursor !== bCursor) return aCursor ? -1 : 1;
      const areaDelta = visibleAreaWithinTarget(b.visibleRects, targetRect) - visibleAreaWithinTarget(a.visibleRects, targetRect);
      if (areaDelta !== 0) return areaDelta;
      return a.zRank - b.zRank;
    })
    .slice(0, cap);
}

async function enumerateWinAppMarksDetailed(
  adapter: ComputerUseHostAdapter,
  appIdentifier: string,
  physicalRect: { x: number; y: number; w: number; h: number },
  ratioX: number,
  ratioY: number,
  originX: number,
  originY: number,
): Promise<{ marks: Mark[]; stats?: { traversedCount: number; matchedCount: number; returnedCount: number; truncated: boolean; truncationReason?: "traversal_budget" | "output_budget" } }> {
  const anyExecutor = adapter.executor as typeof adapter.executor & {
    enumerateVisibleElementsForAppDetailed?: (
      appIdentifier: string,
      rect: { x: number; y: number; w: number; h: number },
    ) => Promise<{
      elements: Array<{
        bbox: { x: number; y: number; w: number; h: number };
        name?: string;
        role?: string;
        automationId?: string;
        uiaSource?: string;
      }>;
      traversedCount: number;
      matchedCount: number;
      returnedCount: number;
      truncated: boolean;
      truncationReason?: "traversal_budget" | "output_budget";
    }>;
  };
  const detailed = await anyExecutor.enumerateVisibleElementsForAppDetailed?.(
    appIdentifier,
    physicalRect,
  );
  if (!detailed) return { marks: [] };
  const marks = detailed.elements.map((el, i) => {
    const vx = (el.bbox.x - originX) / ratioX;
    const vy = (el.bbox.y - originY) / ratioY;
    const vw = el.bbox.w / ratioX;
    const vh = el.bbox.h / ratioY;
    return {
      id: i + 1,
      x: Math.round(vx + vw / 2),
      y: Math.round(vy + vh / 2),
      name: el.name ?? "",
      role: el.role ?? "",
      automationId: el.automationId,
      source: "uia" as const,
      confidence: 1.0,
      uiaSource: el.uiaSource ?? "foreground",
    };
  });
  return {
    marks,
    stats: {
      traversedCount: detailed.traversedCount,
      matchedCount: detailed.matchedCount,
      returnedCount: detailed.returnedCount,
      truncated: detailed.truncated,
      truncationReason: detailed.truncationReason,
    },
  };
}

async function enumerateWinWindowMarksDetailed(
  adapter: ComputerUseHostAdapter,
  windowHandle: number,
  physicalRect: { x: number; y: number; w: number; h: number },
  ratioX: number,
  ratioY: number,
  originX: number,
  originY: number,
): Promise<{ marks: Mark[]; stats?: { traversedCount: number; matchedCount: number; returnedCount: number; truncated: boolean; truncationReason?: "traversal_budget" | "output_budget" } }> {
  const anyExecutor = adapter.executor as typeof adapter.executor & {
    enumerateVisibleElementsForWindowDetailed?: (
      windowHandle: number,
      rect: { x: number; y: number; w: number; h: number },
    ) => Promise<{
      elements: Array<{
        bbox: { x: number; y: number; w: number; h: number };
        name?: string;
        role?: string;
        automationId?: string;
        uiaSource?: string;
      }>;
      traversedCount: number;
      matchedCount: number;
      returnedCount: number;
      truncated: boolean;
      truncationReason?: "traversal_budget" | "output_budget";
    }>;
  };
  const detailed = await anyExecutor.enumerateVisibleElementsForWindowDetailed?.(
    windowHandle,
    physicalRect,
  );
  if (!detailed) return { marks: [] };
  const marks = detailed.elements.map((el, i) => {
    const vx = (el.bbox.x - originX) / ratioX;
    const vy = (el.bbox.y - originY) / ratioY;
    const vw = el.bbox.w / ratioX;
    const vh = el.bbox.h / ratioY;
    return {
      id: i + 1,
      x: Math.round(vx + vw / 2),
      y: Math.round(vy + vh / 2),
      name: el.name ?? "",
      role: el.role ?? "",
      automationId: el.automationId,
      source: "uia" as const,
      confidence: 1.0,
      uiaSource: el.uiaSource ?? "foreground",
    };
  });
  return {
    marks,
    stats: {
      traversedCount: detailed.traversedCount,
      matchedCount: detailed.matchedCount,
      returnedCount: detailed.returnedCount,
      truncated: detailed.truncated,
      truncationReason: detailed.truncationReason,
    },
  };
}

async function enumerateMacWindowMarksDetailed(
  adapter: ComputerUseHostAdapter,
  windowId: number,
  appIdentifier: string,
  physicalRect: { x: number; y: number; w: number; h: number },
  ratioX: number,
  ratioY: number,
  originX: number,
  originY: number,
): Promise<{ marks: Mark[]; stats?: { traversedCount: number; matchedCount: number; returnedCount: number; truncated: boolean; truncationReason?: "traversal_budget" | "output_budget" } }> {
  const anyExecutor = adapter.executor as typeof adapter.executor & {
    enumerateVisibleElementsForMacWindowDetailed?: (
      windowId: number,
      appIdentifier: string,
      rect: { x: number; y: number; w: number; h: number },
    ) => Promise<{
      elements: Array<{
        bbox: { x: number; y: number; w: number; h: number };
        name?: string;
        role?: string;
        automationId?: string;
        uiaSource?: string;
      }>;
      traversedCount: number;
      matchedCount: number;
      returnedCount: number;
      truncated: boolean;
      truncationReason?: "traversal_budget" | "output_budget";
    }>;
  };
  const detailed = await anyExecutor.enumerateVisibleElementsForMacWindowDetailed?.(
    windowId,
    appIdentifier,
    physicalRect,
  );
  if (!detailed) return { marks: [] };
  const marks = detailed.elements.map((el, i) => {
    const vx = (el.bbox.x - originX) / ratioX;
    const vy = (el.bbox.y - originY) / ratioY;
    const vw = el.bbox.w / ratioX;
    const vh = el.bbox.h / ratioY;
    return {
      id: i + 1,
      x: Math.round(vx + vw / 2),
      y: Math.round(vy + vh / 2),
      name: el.name ?? "",
      role: el.role ?? "",
      automationId: el.automationId,
      source: "uia" as const,
      confidence: 1.0,
      uiaSource: el.uiaSource ?? "foreground",
    };
  });
  return {
    marks,
    stats: {
      traversedCount: detailed.traversedCount,
      matchedCount: detailed.matchedCount,
      returnedCount: detailed.returnedCount,
      truncated: detailed.truncated,
      truncationReason: detailed.truncationReason,
    },
  };
}

async function collectWinContextAwareMarks(
  adapter: ComputerUseHostAdapter,
  baseMarks: Mark[],
  targetPhysicalRect: { x: number; y: number; w: number; h: number },
  ratioX: number,
  ratioY: number,
  originX: number,
  originY: number,
  probeCap = 3,
  touched?: Set<string>,
): Promise<Mark[]> {
  const baseline = await listWinVisibleWindows(adapter);
  if (baseline.length === 0) return baseMarks;
  adapter.logger.debug?.(
    `[computer-use] win probe baseline windows=${baseline.slice(0, 8).map(w => `${w.displayName}@${w.zRank}${w.isForeground ? "[fg]" : ""}${w.isHost ? "[host]" : ""}${w.isSystemChrome ? "[chrome]" : ""}`).join(", ")}`,
  );

  const originalForeground = baseline.find(w => w.isForeground);
  // Read cursor for the probe-candidate ranker — best signal we have for
  // "which window does the user actually care about right now". Failure is
  // not fatal: ranker falls back to area + z-rank only.
  let cursor: { x: number; y: number } | null = null;
  try {
    cursor = await adapter.executor.getCursorPosition();
  } catch {
    cursor = null;
  }
  const candidates = selectWinProbeCandidates(baseline, targetPhysicalRect, probeCap, cursor);
  if (candidates.length === 0) return baseMarks;
  adapter.logger.debug?.(
    `[computer-use] win probe candidates=${candidates.map(c => `${c.displayName}@${c.zRank} rects=${c.visibleRects.length}`).join(", ")}`,
  );

  const merged: Mark[] = [...baseMarks];
  for (const candidate of candidates) {
    try {
      const probeRect = [...candidate.visibleRects]
        .sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
      if (probeRect && adapter.executor.focusNonHostWindowAtPoint) {
        adapter.logger.debug?.(
          `[computer-use] win probe focus visible-region app=${candidate.displayName} point=(${probeRect.x + Math.round(probeRect.w / 2)},${probeRect.y + Math.round(probeRect.h / 2)}) rect=${JSON.stringify(probeRect)}`,
        );
        await adapter.executor.focusNonHostWindowAtPoint({
          x: probeRect.x + Math.round(probeRect.w / 2),
          y: probeRect.y + Math.round(probeRect.h / 2),
        });
        await sleep(150);
      }
      if (candidate.appIdentifier) touched?.add(candidate.appIdentifier);
      await adapter.executor.screenshotWindow(candidate.appIdentifier, 0);
      adapter.logger.debug?.(
        `[computer-use] win probe screenshotWindow app=${candidate.displayName}`,
      );
      const detailed = await enumerateWinAppMarksDetailed(
        adapter,
        candidate.appIdentifier,
        targetPhysicalRect,
        ratioX,
        ratioY,
        originX,
        originY,
      );
      const visibleVirtualRects = candidate.visibleRects.map(rect =>
        physicalRectToVirtualRect(rect, ratioX, ratioY, originX, originY),
      );
      const kept = filterMarksByVisibleRegions(detailed.marks, visibleVirtualRects);
      // Direct attribution: we know each kept mark came from this
      // candidate's UIA tree. Pre-tagging here is more accurate than
      // the post-hoc point-in-rect attribution in
      // attributeMarksToEntries — overlapping windows can shadow each
      // other's marks under point-in-rect.
      for (const m of kept) m.sourceWindowName = candidate.displayName;
      adapter.logger.debug?.(
        `[computer-use] win probe app=${candidate.displayName} rawMarks=${detailed.marks.length} kept=${kept.length}`,
      );
      merged.push(...kept);
    } catch {
      // best-effort
    }
  }

  return dedupeMarks(merged);
}

/**
 * Mac analogue of selectWinProbeCandidates: pick top-N windows that
 * overlap the target rect and have visible (non-occluded) area.
 *
 * Differences from the Win version:
 * - No isHost / isSystemChrome filter — Mac windows don't carry those
 *   flags. Filter system chrome by layer instead (layer 0 = normal app
 *   windows; menu bar / Dock / status items sit at higher layers).
 * - No foreground filter — Mac uses `zRank === 0` as the foreground
 *   convention. Skipping that one is consistent with Win's
 *   `!isForeground` (foreground already enumerated by the main pass).
 * - Cursor-owner ranking matches Win.
 */
function selectMacProbeCandidates(
  baseline: MacVisibleWindowSnapshot[],
  targetRect: { x: number; y: number; w: number; h: number },
  cap = 3,
  cursor: { x: number; y: number } | null = null,
): Array<MacVisibleWindowSnapshot & { visibleRects: Array<{ x: number; y: number; w: number; h: number }> }> {
  // Manual occlusion subtraction by zRank order. listMacVisibleWindows
  // returns zRank 0 = frontmost. Lower-zRank windows occlude higher-zRank.
  type Annotated = MacVisibleWindowSnapshot & {
    visibleRects: Array<{ x: number; y: number; w: number; h: number }>;
  };
  const sortedByZ = [...baseline].sort((a, b) => a.zRank - b.zRank);
  const annotated: Annotated[] = sortedByZ.map(win => ({ ...win, visibleRects: [win.rect] }));
  for (let i = 0; i < annotated.length; i += 1) {
    const target = annotated[i]!;
    let regions = [target.rect];
    for (let j = 0; j < i; j += 1) {
      const occluder = annotated[j]!;
      const next: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const r of regions) next.push(...subtractRect(r, occluder.rect));
      regions = next;
      if (regions.length === 0) break;
    }
    target.visibleRects = regions;
  }

  const ownsCursor = (
    win: { visibleRects: Array<{ x: number; y: number; w: number; h: number }> },
  ): boolean => {
    if (!cursor) return false;
    return win.visibleRects.some(
      r => cursor.x >= r.x && cursor.x < r.x + r.w && cursor.y >= r.y && cursor.y < r.y + r.h,
    );
  };

  return annotated
    .filter(win =>
      // layer 0 only — strips out menu bar / Dock / status items / etc.
      // (those are already enumerated as hardcoded roots in Rust's
      // discover_search_roots after the menu_bar/dock additions).
      win.layer === 0 &&
      // Skip the frontmost; the main detection pass already covered it.
      win.zRank !== 0 &&
      win.rect.w >= 100 &&
      win.rect.h >= 100 &&
      rectsIntersect(win.rect, targetRect),
    )
    .filter(win => visibleAreaWithinTarget(win.visibleRects, targetRect) > 0)
    .sort((a, b) => {
      const aCursor = ownsCursor(a);
      const bCursor = ownsCursor(b);
      if (aCursor !== bCursor) return aCursor ? -1 : 1;
      const areaDelta =
        visibleAreaWithinTarget(b.visibleRects, targetRect) -
        visibleAreaWithinTarget(a.visibleRects, targetRect);
      if (areaDelta !== 0) return areaDelta;
      return a.zRank - b.zRank;
    })
    .slice(0, cap);
}

/**
 * Mac analogue of collectWinContextAwareMarks. Probes top-N non-frontmost
 * normal-layer windows, enumerates their UIA subtrees via the per-windowId
 * native call, filters to each window's un-occluded visible regions, and
 * merges with the base marks. No focus needed — Mac AX is
 * foreground-independent — so this is strictly cheaper than the Win path
 * (no SetForegroundWindow dance, no z-order disturbance, no settle sleep).
 */
async function collectMacContextAwareMarks(
  adapter: ComputerUseHostAdapter,
  baseMarks: Mark[],
  targetPhysicalRect: { x: number; y: number; w: number; h: number },
  ratioX: number,
  ratioY: number,
  originX: number,
  originY: number,
  probeCap = 4,
): Promise<Mark[]> {
  const baseline = await listMacVisibleWindows(adapter);
  if (baseline.length === 0) return baseMarks;
  adapter.logger.debug?.(
    `[computer-use] mac probe baseline windows=${baseline.slice(0, 8).map(w => `${w.displayName}@${w.zRank}/L${w.layer}`).join(", ")}`,
  );

  let cursor: { x: number; y: number } | null = null;
  try {
    cursor = await adapter.executor.getCursorPosition();
  } catch {
    cursor = null;
  }
  const candidates = selectMacProbeCandidates(baseline, targetPhysicalRect, probeCap, cursor);
  if (candidates.length === 0) return baseMarks;
  adapter.logger.debug?.(
    `[computer-use] mac probe candidates=${candidates.map(c => `${c.displayName}@${c.zRank} rects=${c.visibleRects.length}`).join(", ")}`,
  );

  const merged: Mark[] = [...baseMarks];
  for (const candidate of candidates) {
    try {
      const detailed = await enumerateMacWindowMarksDetailed(
        adapter,
        candidate.windowId,
        candidate.appIdentifier,
        targetPhysicalRect,
        ratioX,
        ratioY,
        originX,
        originY,
      );
      const visibleVirtualRects = candidate.visibleRects.map(rect =>
        physicalRectToVirtualRect(rect, ratioX, ratioY, originX, originY),
      );
      const kept = filterMarksByVisibleRegions(detailed.marks, visibleVirtualRects);
      adapter.logger.debug?.(
        `[computer-use] mac probe app=${candidate.displayName} rawMarks=${detailed.marks.length} kept=${kept.length}`,
      );
      merged.push(...kept);
    } catch {
      // best-effort
    }
  }

  return dedupeMarks(merged);
}

// ---------------------------------------------------------------------------
// Arg validation — lightweight, no zod (mirrors chrome-mcp's cast-and-check)
// ---------------------------------------------------------------------------

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args === "object" && args !== null) {
    return args as Record<string, unknown>;
  }
  return {};
}

function requireNumber(
  args: Record<string, unknown>,
  key: string,
): number | Error {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return new Error(`"${key}" must be a finite number.`);
  }
  return v;
}

function requireString(
  args: Record<string, unknown>,
  key: string,
): string | Error {
  const v = args[key];
  if (typeof v !== "string") {
    return new Error(`"${key}" must be a string.`);
  }
  return v;
}

/**
 * Extract (x, y) from `coordinate: [x, y]` tuple.
 * array of length 2, both non-negative numbers.
 */
function extractCoordinate(
  args: Record<string, unknown>,
  paramName: string = "coordinate",
): [number, number] | Error {
  const coord = args[paramName];
  if (coord === undefined) {
    return new Error(`${paramName} is required`);
  }
  if (!Array.isArray(coord) || coord.length !== 2) {
    return new Error(`${paramName} must be an array of length 2`);
  }
  const [x, y] = coord;
  if (typeof x !== "number" || typeof y !== "number" || x < 0 || y < 0) {
    return new Error(`${paramName} must be a tuple of non-negative numbers`);
  }
  return [x, y];
}

/**
 * `extractCoordinate` variant that treats an absent param as a valid
 * "click-in-place" signal rather than an error. Returns `null` when the
 * AI deliberately omitted the coordinate (intent: "click at the current
 * cursor position"). Used by the click tools so AI can do the closed-loop
 * pattern: `mouse_move(estimated)` → `screenshot` → see cursor in image →
 * `mouse_move(refined)` if needed → `left_click()` (no coord) to commit.
 *
 * Type validation on a present coord stays identical to extractCoordinate.
 */
function extractOptionalCoordinate(
  args: Record<string, unknown>,
  paramName: string = "coordinate",
): [number, number] | null | Error {
  if (args[paramName] === undefined) {
    return null;
  }
  return extractCoordinate(args, paramName);
}

// ---------------------------------------------------------------------------
// Coordinate scaling
// ---------------------------------------------------------------------------

/**
 * Scale context for coordinate transforms. Derived from the display geometry
 * (physical pixel dims) and the 1920-long-edge image-resize rule so model
 * image-space pixel coords can be mapped to physical virtual-screen coords
 * without a stored screenshot blob.
 */
interface ScaleContext {
  ratioX: number;
  ratioY: number;
  originX: number;
  originY: number;
}

/** Long-edge cap for screenshot JPEGs — same constant as winExecutor. */
const LONG_EDGE_CAP = 1920;

/**
 * Compute the image dimensions after the 1920-long-edge Lanczos resize.
 */
function computeImageDim(w: number, h: number): [number, number] {
  const longEdge = Math.max(w, h);
  if (longEdge <= LONG_EDGE_CAP) return [w, h];
  const ratio = LONG_EDGE_CAP / longEdge;
  return [Math.round(w * ratio), Math.round(h * ratio)];
}

/** Derive ScaleContext from display geometry. */
function screenScaleCtx(d: DisplayGeometry): ScaleContext {
  const [iw, ih] = computeImageDim(d.width, d.height);
  return {
    ratioX: d.width / iw,
    ratioY: d.height / ih,
    originX: d.originX ?? 0,
    originY: d.originY ?? 0,
  };
}

/**
 * Convert model-space coordinates to the logical points that enigo expects.
 *
 *   - `normalized_0_100`: (x / 100) * display.width. `display` is fetched
 *     fresh per tool call — never cached across calls —
 *     so a mid-session display-settings change doesn't leave us stale.
 *   - `pixels`: the model sent image-space pixel coords (it read them off the
 *     last screenshot). With the 1568-px long-edge downsample, the
 *     screenshot-px → logical-pt ratio is `displayWidth / screenshotWidth`,
 *     NOT `1/scaleFactor`. Uses the display geometry stashed at CAPTURE time
 *     (`lastScreenshot.displayWidth`), not fresh — so the transform matches
 *     what the model actually saw even if the user changed display settings
 *     since. (Chrome's ScreenshotContext pattern — CDPService.ts:1486-1493.)
 */
function scaleCoord(
  rawX: number,
  rawY: number,
  mode: CoordinateMode,
  display: DisplayGeometry,
  ctx: ScaleContext | undefined,
  logger: Logger,
): { x: number; y: number } {
  if (mode === "normalized_0_100") {
    return {
      x: Math.round((rawX / 100) * display.width) + display.originX,
      y: Math.round((rawY / 100) * display.height) + display.originY,
    };
  }

  // mode === "pixels": model sent image-space pixel coords.
  if (ctx) {
    const result = {
      x: Math.round(rawX * ctx.ratioX) + ctx.originX,
      y: Math.round(rawY * ctx.ratioY) + ctx.originY,
    };
    logger.debug(
      `[CU-COORD] scaleCoord: in=(${rawX},${rawY}) ` +
        `ratio=(${ctx.ratioX},${ctx.ratioY}) ` +
        `origin=(${ctx.originX},${ctx.originY}) ` +
        `→ out=(${result.x},${result.y}) (display coords)`,
    );
    return result;
  }

  // No ctx in pixels mode — model sent pixel coords without scale context.
  const scale = (display as { scaleFactor?: number }).scaleFactor ?? 1;
  return {
    x: Math.round(rawX * scale) + (display.originX ?? 0),
    y: Math.round(rawY * scale) + (display.originY ?? 0),
  };
}

/**
 * Resolve the target display for an action tool. When the AI passes
 * `display_id` (from a prior `accept()`), find that display's geometry.
 * Falls back to the implicit `selectedDisplayId`.
 */
async function resolveDisplay(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
): Promise<DisplayGeometry> {
  if (typeof args.display_id === "number") {
    const displays = await adapter.executor.listDisplays();
    const match = displays.find((d) => d.displayId === args.display_id);
    if (match) return match;
  }
  return adapter.executor.getDisplaySize(overrides.selectedDisplayId);
}

// ---------------------------------------------------------------------------
// Shared input-action gates
// ---------------------------------------------------------------------------

/**
 * Tier needed to perform a given action class. `undefined` → `"full"`.
 *
 *   - `"mouse_position"` — mouse_move only. Passes at any tier including
 *     `"read"`. Pure cursor positioning, no app interaction. Still runs
 *     prepareForAction (hide non-allowed apps).
 *   - `"mouse"` — plain left click, double/triple, scroll, drag-from.
 *     Requires tier `"click"` or `"full"`.
 *   - `"mouse_full"` — right/middle click, any click with modifiers,
 *     drag-drop (the `to` endpoint of left_click_drag). Requires tier
 *     `"full"`. Right-click → context menu Paste, modifier chords →
 *     keystrokes before click, drag-drop → text insertion at the drop
 *     point. All escalate a click-tier grant to keyboard-equivalent input.
 *     Blunt: also rejects same-app drags (scrollbar, panel resize) onto
 *     click-tier apps; `scroll` is the tier-"click" way to scroll.
 *   - `"keyboard"` — type, key, hold_key. Requires tier `"full"`.
 */
type CuActionKind = "mouse_position" | "mouse" | "mouse_full" | "keyboard";

function tierSatisfies(
  grantTier: CuAppPermTier | undefined,
  actionKind: CuActionKind,
): boolean {
  const tier = grantTier ?? "full";
  if (actionKind === "mouse_position") return true;
  if (actionKind === "keyboard" || actionKind === "mouse_full") {
    return tier === "full";
  }
  // mouse
  return tier === "click" || tier === "full";
}

// Appended to every tier_insufficient error. The model may try to route
// around the gate (osascript, System Events, cliclick via Bash) — this
// closes that door explicitly. Leading space so it concatenates cleanly.
const TIER_ANTI_SUBVERSION =
  " Do not attempt to work around this restriction — never use AppleScript, " +
  "System Events, shell commands, or any other method to send clicks or " +
  "keystrokes to this app.";

// ---------------------------------------------------------------------------
// Clipboard guard — stash+clear while a click-tier app is frontmost
// ---------------------------------------------------------------------------
//
// Threat: tier "click" blocks type/key/right-click-Paste, but a click-tier
// terminal/IDE may have a UI Paste button that's plain-left-clickable. If the
// clipboard holds `rm -rf /` — from the user, from a prior full-tier paste,
// OR from the agent's own write_clipboard call (which doesn't route through
// runInputActionGates) — a left_click on that button injects it.
//
// Mitigation: stash the user's clipboard on first entry to click-tier, then
// RE-CLEAR before every input action while click-tier stays frontmost. The
// re-clear is the load-bearing part — a stash-on-transition-only design
// leaves a gap between an agent write_clipboard and the next left_click.
// When frontmost becomes anything else, restore. Turn-end restore is inlined
// in the host's result-handler + leavingRunning (same dual-location as
// cuHiddenDuringTurn unhide) — reads `session.cuClipboardStash` directly and
// writes via Electron's `clipboard.writeText`, so no extra import from here.
//
// State lives on the session (via `overrides.getClipboardStash` /
// `onClipboardStashChanged`), not module-level. The CU lock still guarantees
// one session at a time, but session-scoped state means the host's turn-end
// restore doesn't need to reach back into this package.

async function syncClipboardStash(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  frontmostIsClickTier: boolean,
): Promise<void> {
  const current = overrides.getClipboardStash?.();
  if (!frontmostIsClickTier) {
    // Restore + clear. Idempotent — if nothing is stashed, no-op.
    if (current === undefined) return;
    try {
      await adapter.executor.writeClipboard(current);
      // Clear only after a successful write — a transient pasteboard
      // failure must not irrecoverably drop the stash.
      overrides.onClipboardStashChanged?.(undefined);
    } catch {
      // Best effort — stash held, next non-click action retries.
    }
    return;
  }
  // Stash the user's clipboard on FIRST entry to click-tier only.
  if (current === undefined) {
    try {
      const read = await adapter.executor.readClipboard();
      overrides.onClipboardStashChanged?.(read);
    } catch {
      // readClipboard failed — use empty sentinel so we don't retry the stash
      // on the next action; restore becomes a harmless writeClipboard("").
      overrides.onClipboardStashChanged?.("");
    }
  }
  // Re-clear on EVERY click-tier action, not just the first. Defeats the
  // bypass where the agent calls write_clipboard (which doesn't route
  // through runInputActionGates) between stash and a left_click on a UI
  // Paste button — the next action's clear clobbers the agent's write
  // before the click lands.
  try {
    await adapter.executor.writeClipboard("");
  } catch {
    // Transient pasteboard failure. The tier-"click" right-click/modifier
    // block still holds; this is a net, not a promise.
  }
}

/** Every click/type/key/scroll/drag/move_mouse runs through this before
 * touching the executor. Returns null on pass, error-result on block.
 * Any throw inside → caught by handleToolCall's outer try → tool error.
 *
 * mac-only by design: the gate enforces an SCContentFilter-shaped allowlist
 * model (frontmost-app tier check + non-allowlisted-app block) that has no
 * Windows analog. On non-darwin we early-return null without even logging
 * the entry — Win callers pay zero cost for a check that has nothing to
 * enforce. Future Linux support would need its own gate strategy here. */
async function runInputActionGates(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
  actionKind: CuActionKind,
): Promise<CuCallToolResult | null> {
  if (overrides.platform !== "darwin") return null;
  // After this guard, TypeScript narrows `overrides` to the darwin variant
  // and `overrides.allowedApps` is typed as AppGrant[] (not optional).
  const bypassed = isAllowlistBypassed();
  adapter.logger.debug(
    `[CU-GATE] runInputActionGates entry: actionKind=${actionKind} bypass=${bypassed} ` +
      `allowedApps.length=${overrides.allowedApps.length} hideBeforeAction=${subGates.hideBeforeAction}`,
  );
  // Bypass: skip the entire pre-action gate stack. prepareForAction hide
  // also skipped because we early-return before line 425. The clipboard
  // guard inside is bypass-skipped too, which is fine — bypass mode means
  // "I trust the AI, do not inject safety tape mid-operation."
  if (bypassed) return null;

  // Step A+B — hide non-allowlisted apps + defocus us. Sub-gated. After this
  // runs, the frontmost gate below becomes a rare edge-case detector (something
  // popped up between prepare and action) rather than a normal-path blocker.
  // ALL grant tiers stay visible — visibility is the baseline (tier "read").
  if (subGates.hideBeforeAction) {
    const hidden = (await adapter.executor.prepareForAction?.(
      overrides.allowedApps.map((a) => a.appIdentifier),
      overrides.selectedDisplayId,
    )) ?? [];
    // Empty-check so we don't spam the callback on every action when nothing
    // was hidden (the common case after the first action of a turn). On
    // platforms without a hide model (Win) prepareForAction is undefined
    // and we fall through to [] — no callback fires.
    if (hidden.length > 0) {
      overrides.onAppsHidden?.(hidden);
    }
  }

  // Frontmost gate. Check FRESH on every call.
  const frontmost = await adapter.executor.getFrontmostApp();

  const tierByAppIdentifier = new Map(
    overrides.allowedApps.map((a) => [a.appIdentifier, a.tier] as const),
  );

  // After handleToolCall's tier backfill, every grant has a concrete tier —
  // .get() returning undefined means the app is not in the allowlist at all.
  const frontmostTier = frontmost
    ? tierByAppIdentifier.get(frontmost.appIdentifier)
    : undefined;

  // Clipboard guard. Per-action, not per-tool-call — runs for every sub-action
  // inside computer_batch and teach_step/teach_batch, so clicking into a
  // click-tier app mid-batch stashes+clears before the next click lands.
  // Lives here (not in handleToolCall) so deferAcquire tools (request_access,
  // list_granted_applications), `wait`, and the teach_step blocking-dialog
  // phase don't trigger a sync — only input actions do.
  if (subGates.clipboardGuard) {
    await syncClipboardStash(adapter, overrides, frontmostTier === "click");
  }

  if (!frontmost) {
    // No frontmost app (rare — login window?). Let it through; the click
    // will land somewhere.
    adapter.logger.debug(
      `[CU-GATE] runInputActionGates PASS: no frontmost app (lock screen / UAC / nothing focused) — letting click through`,
    );
    return null;
  }

  const { hostAppIdentifier } = adapter.executor.capabilities;

  if (frontmostTier !== undefined) {
    if (tierSatisfies(frontmostTier, actionKind)) {
      adapter.logger.debug(
        `[CU-GATE] runInputActionGates PASS: frontmost="${frontmost.displayName}" (${frontmost.appIdentifier}) tier="${frontmostTier}" satisfies actionKind="${actionKind}"`,
      );
      return null;
    }
    adapter.logger.debug(
      `[CU-GATE] runInputActionGates BLOCK: frontmost="${frontmost.displayName}" (${frontmost.appIdentifier}) tier="${frontmostTier}" insufficient for actionKind="${actionKind}" — returning tier_insufficient error`,
    );
    // In the allowlist but tier doesn't cover this action. Tailor the
    // guidance to the actual tier — at "read", suggesting left_click or Bash
    // is wrong (nothing is allowed; use Chrome MCP). At "click", the
    // mouse_full/keyboard-specific messages apply.
    if (frontmostTier === "read") {
      return errorResult(
        `"${frontmost.displayName}" is granted at tier "read" — ` +
          `visible in screenshots only, no clicks or typing.` +
          " No interaction is permitted; ask the user to take any " +
          "actions in this app themselves." +
          TIER_ANTI_SUBVERSION,
        "tier_insufficient",
      );
    }
    // frontmostTier === "click" (tier === "full" would have passed tierSatisfies)
    if (actionKind === "keyboard") {
      return errorResult(
        `"${frontmost.displayName}" is granted at tier "click" — ` +
          `typing, key presses, and paste require tier "full". The keys ` +
          `would go to this app's text fields or integrated terminal. To ` +
          `type into a different app, click it first to bring it forward. ` +
          `For shell commands, use the Bash tool.` + TIER_ANTI_SUBVERSION,
        "tier_insufficient",
      );
    }
    // actionKind === "mouse_full" ("mouse" and "mouse_position" pass at "click")
    return errorResult(
      `"${frontmost.displayName}" is granted at tier "click" — ` +
        `right-click, middle-click, and clicks with modifier keys require ` +
        `tier "full". Right-click opens a context menu with Paste/Cut, and ` +
        `modifier chords fire as keystrokes before the click. Plain ` +
        `left_click is allowed here.` + TIER_ANTI_SUBVERSION,
      "tier_insufficient",
    );
  }
  // Finder is never-hide, always allowed.
  if (frontmost.appIdentifier === FINDER_APP_IDENTIFIER) {
    adapter.logger.debug(
      `[CU-GATE] runInputActionGates PASS: frontmost is Finder (always allowed)`,
    );
    return null;
  }

  if (frontmost.appIdentifier === hostAppIdentifier) {
    if (actionKind !== "keyboard") {
      // mouse and mouse_full are both click events — click-through works.
      // We're click-through (executor's withClickThrough). Pass.
      adapter.logger.debug(
        `[CU-GATE] runInputActionGates PASS: frontmost is host (axiomate itself), actionKind="${actionKind}" — click-through allowed`,
      );
      return null;
    }
    // Keyboard safety net — defocus (prepareForAction step B) should have
    // moved us off. If we're still here, typing would go to our chat box.
    return errorResult(
      "Axiomate's own window still has keyboard focus. This should not happen " +
        "after the pre-action defocus. Click on the target application first.",
      "state_conflict",
    );
  }

  // Non-allowlisted, non-us, non-Finder. RARE after the hide loop — means
  // something popped up between prepare and action, or the 5-try loop gave up.
  const allowlistList = overrides.allowedApps.map(a => a.appIdentifier).join(',') || '<empty>';
  adapter.logger.debug(
    `[CU-GATE] runInputActionGates BLOCK: frontmost="${frontmost.displayName}" (${frontmost.appIdentifier}) NOT in allowedApps={${allowlistList}} — returning app_not_granted error to AI. ` +
      `(Default-open mode means this branch is unreachable; if you see this log, isAllowlistBypassed() somehow returned false.)`,
  );
  return errorResult(
    `"${frontmost.displayName}" is not in the allowed applications and is ` +
      `currently in front. Take a new screenshot — it may have appeared ` +
      `since your last one.`,
    "app_not_granted",
  );
}

/**
 * Hit-test gate: reject a mouse action if the window under (x, y) belongs
 * to an app whose tier doesn't cover mouse input. Closes the gap where a
 * tier-"full" app is frontmost but the click lands on a tier-"read" window
 * overlapping it — `runInputActionGates` passes (frontmost is fine), but the
 * click actually goes to the read-tier app.
 *
 * Runs AFTER `scaleCoord` (needs global coords) and BEFORE the executor call.
 * Returns null on pass (target is tier-"click"/"full", or desktop/Finder/us),
 * error-result on block.
 *
 * When `appUnderPoint` returns null (desktop, or platform without hit-test),
 * falls through — the frontmost check in `runInputActionGates` already ran.
 *
 * mac-only by design (same as runInputActionGates). On non-darwin we
 * early-return null without logging entry — the tier system has no Win
 * analog, and Win's `appUnderPoint` is not coupled to a permission model.
 */
async function runHitTestGate(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
  x: number,
  y: number,
  actionKind: CuActionKind,
): Promise<CuCallToolResult | null> {
  if (overrides.platform !== "darwin") return null;
  // After this guard, TypeScript narrows `overrides` to the darwin variant.
  const bypassed = isAllowlistBypassed();
  adapter.logger.debug(
    `[CU-GATE] runHitTestGate entry: x=${x} y=${y} actionKind=${actionKind} ` +
      `bypass=${bypassed} allowedApps.length=${overrides.allowedApps.length}`,
  );
  if (bypassed) return null;
  const target = await adapter.executor.appUnderPoint(x, y);
  adapter.logger.debug(
    `[CU-GATE] runHitTestGate appUnderPoint(${x},${y}) → ${target ? `appIdentifier="${target.appIdentifier}" displayName="${target.displayName}"` : 'null (desktop / nothing under point / platform no-op)'}`,
  );
  if (!target) return null; // desktop / nothing under point / platform no-op

  // Finder (desktop, file dialogs) is always clickable — same exemption as
  // runInputActionGates. Our own overlay is filtered by Swift (pid != self).
  if (target.appIdentifier === FINDER_APP_IDENTIFIER) {
    adapter.logger.debug(
      `[CU-GATE] runHitTestGate PASS: target is Finder (always allowed)`,
    );
    return null;
  }

  const tierByAppIdentifier = new Map(
    overrides.allowedApps.map((a) => [a.appIdentifier, a.tier] as const),
  );

  if (!tierByAppIdentifier.has(target.appIdentifier)) {
    // Not in the allowlist at all.
    const allowlistList = overrides.allowedApps.map(a => a.appIdentifier).join(',') || '<empty>';
    adapter.logger.debug(
      `[CU-GATE] runHitTestGate BLOCK: target="${target.displayName}" (${target.appIdentifier}) NOT in allowedApps={${allowlistList}} — returning app_not_granted error`,
    );
    return errorResult(
      `Click at these coordinates would land on "${target.displayName}", ` +
        `which is not in the allowed applications. Take a fresh screenshot ` +
        `to see the current window layout.`,
      "app_not_granted",
    );
  }

  const targetTier = tierByAppIdentifier.get(target.appIdentifier);

  // Frontmost-based sync (runInputActionGates) misses the case where
  // the click lands on a NON-FRONTMOST click-tier window. Re-sync by
  // the hit-test target's tier — if target is click-tier, stash+clear
  // before the click lands, regardless of what's frontmost.
  if (subGates.clipboardGuard && targetTier === "click") {
    await syncClipboardStash(adapter, overrides, true);
  }

  if (tierSatisfies(targetTier, actionKind)) {
    adapter.logger.debug(
      `[CU-GATE] runHitTestGate PASS: target="${target.displayName}" tier="${targetTier}" satisfies actionKind="${actionKind}"`,
    );
    return null;
  }

  adapter.logger.debug(
    `[CU-GATE] runHitTestGate BLOCK: target="${target.displayName}" tier="${targetTier}" insufficient for actionKind="${actionKind}" — returning tier_insufficient error`,
  );
  // Target is in the allowlist but tier doesn't cover this action.
  // runHitTestGate is only called with mouse/mouse_full (keyboard routes to
  // frontmost, not window-under-cursor). The branch above catches
  // mouse_full ∧ click; the only remaining fall-through is tier "read".
  if (actionKind === "mouse_full" && targetTier === "click") {
    return errorResult(
      `Click at these coordinates would land on "${target.displayName}", ` +
        `which is granted at tier "click" — right-click, middle-click, and ` +
        `clicks with modifier keys require tier "full" (they can Paste via ` +
        `the context menu or fire modifier-chord keystrokes). Plain ` +
        `left_click is allowed here.` + TIER_ANTI_SUBVERSION,
      "tier_insufficient",
    );
  }
  return errorResult(
    `Click at these coordinates would land on "${target.displayName}", ` +
      `which is granted at tier "read" (screenshots only, no interaction). ` +
      "Ask the user to take any actions in this app themselves." +
      TIER_ANTI_SUBVERSION,
    "tier_insufficient",
  );
}

// ---------------------------------------------------------------------------
// Screenshot helpers
// ---------------------------------------------------------------------------

/**
 * §6 item 9 — screenshot retry on implausibly-small buffer. Battle-tested
 * threshold (1024 bytes). We retry exactly once.
 */
const MIN_SCREENSHOT_BYTES = 1024;

function decodedByteLength(base64: string): number {
  // 3 bytes per 4 chars, minus padding. Good enough for a threshold check.
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

async function takeScreenshotWithRetry(
  executor: ComputerExecutor,
  allowedAppIdentifiers: string[],
  logger: ComputerUseHostAdapter["logger"],
  displayId?: number,
  coordinateGrid?: string,
  marks?: Array<{ id: number; x: number; y: number }>,
): Promise<ScreenshotResult> {
  let shot = await executor.screenshot({ allowedAppIdentifiers, displayId, coordinateGrid, marks });
  if (decodedByteLength(shot.base64) < MIN_SCREENSHOT_BYTES) {
    logger.warn(
      `[computer-use] screenshot implausibly small (${decodedByteLength(shot.base64)} bytes decoded), retrying once`,
    );
    shot = await executor.screenshot({ allowedAppIdentifiers, displayId, coordinateGrid, marks });
  }
  return shot;
}

// ---------------------------------------------------------------------------
// Grapheme iteration — §6 item 7, ported from the Vercept acquisition
// ---------------------------------------------------------------------------

const INTER_GRAPHEME_SLEEP_MS = 8; // §6 item 4 — 125 Hz USB polling

function segmentGraphemes(text: string): string[] {
  try {
    // Node 18+ has Intl.Segmenter; the try is defence against a stripped-
    // -down runtime (falls back to code points).
    const Segmenter = (
      Intl as typeof Intl & {
        Segmenter?: new (
          locale?: string,
          options?: { granularity: "grapheme" | "word" | "sentence" },
        ) => { segment: (s: string) => Iterable<{ segment: string }> };
      }
    ).Segmenter;
    if (typeof Segmenter === "function") {
      const seg = new Segmenter(undefined, { granularity: "grapheme" });
      return Array.from(seg.segment(text), (s) => s.segment);
    }
  } catch {
    // fall through
  }
  // Code-point iteration. Keeps surrogate pairs together but splits ZWJ.
  return Array.from(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Split a chord string like "ctrl+shift" into individual key names.
 * Same parsing as `key` tool / executor.key / keyBlocklist.normalizeKeySequence.
 */
function parseKeyChord(text: string): string[] {
  return text
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// left_mouse_down / left_mouse_up held-state tracking
// ---------------------------------------------------------------------------

/**
 * Errors on double-down but not on up-without-down. Module-level, but
 * reset on every lock acquire (handleToolCall → acquireCuLock branch) so
 * a session interrupted mid-drag (overlay stop during left_mouse_down)
 * doesn't leave the flag true for the next lock holder.
 *
 * Still scoped wrong within a single lock cycle if sessions could interleave
 * tool calls, but the lock enforces at-most-one-session-uses-CU so they
 * can't. The per-turn reset is the correctness boundary.
 */
let mouseButtonHeld = false;
/** Whether mouse_move occurred between left_mouse_down and left_mouse_up.
 *  When false at mouseUp, the decomposed sequence is a click-release (not a
 *  drop) — hit-test at "mouse", not "mouse_full". */
let mouseMoved = false;

/** Clears the cross-call drag flags. Called from Gate-3 on lock-acquire and
 *  from `bindSessionContext` in mcpServer.ts — a fresh lock holder must not
 *  inherit a prior session's mid-drag state. */
export function resetMouseButtonHeld(): void {
  mouseButtonHeld = false;
  mouseMoved = false;
}

/** If a left_mouse_down set the OS button without a matching left_mouse_up
 *  ever getting its turn, release it now. Same release-before-return as
 *  handleClick. No-op when not held — callers don't need to check. */
async function releaseHeldMouse(
  adapter: ComputerUseHostAdapter,
): Promise<void> {
  if (!mouseButtonHeld) return;
  await adapter.executor.mouseUp();
  mouseButtonHeld = false;
  mouseMoved = false;
}

/**
 * Tools that check the lock but don't acquire it. `request_access` and
 * `list_granted_applications` hit the CHECK (so a blocked session doesn't
 * show an approval dialog for access it can't use) but defer ACQUIRE — the
 * enter-CU notification/overlay only fires on the first action tool.
 *
 * `request_teach_access` is NOT here: approving teach mode hides the main
 * window, and the lock must be held before that. See Gate-3 block in
 * `handleToolCall` for the full explanation.
 *
 * Exported for `bindSessionContext` in mcpServer.ts so the async lock gate
 * uses the same set as the sync one.
 */
export function defersLockAcquire(toolName: string): boolean {
  return (
    toolName === "request_access" ||
    toolName === "list_granted_applications"
  );
}

// ---------------------------------------------------------------------------
// request_access helpers
// ---------------------------------------------------------------------------

/** Reverse-DNS-ish: contains at least one dot, no spaces, no slashes. Lets
 * raw bundle IDs pass through resolution. */
const REVERSE_DNS_RE = /^[A-Za-z0-9][\w.-]*\.[A-Za-z0-9][\w.-]*$/;

function looksLikeAppIdentifier(s: string): boolean {
  return REVERSE_DNS_RE.test(s) && !s.includes(" ");
}

function resolveRequestedApps(
  requestedNames: string[],
  installed: InstalledApp[],
  alreadyGrantedAppIdentifiers: ReadonlySet<string>,
): ResolvedAppRequest[] {
  const byLowerDisplayName = new Map<string, InstalledApp>();
  const byAppIdentifier = new Map<string, InstalledApp>();
  for (const app of installed) {
    byAppIdentifier.set(app.appIdentifier, app);
    // Last write wins on collisions. Ambiguous-name handling (multiple
    // candidates in the dialog) is plan-documented but deferred — the
    // InstalledApps enumerator dedupes by bundle ID, so true display-name
    // collisions are rare. TODO(chicago, post-P1): surface all candidates.
    byLowerDisplayName.set(app.displayName.toLowerCase(), app);
  }

  return requestedNames.map((requested): ResolvedAppRequest => {
    let resolved: InstalledApp | undefined;
    if (looksLikeAppIdentifier(requested)) {
      resolved = byAppIdentifier.get(requested);
    }
    if (!resolved) {
      resolved = byLowerDisplayName.get(requested.toLowerCase());
    }
    const appIdentifier = resolved?.appIdentifier;
    // When unresolved AND the requested string looks like a bundle ID, use it
    // directly for tier lookup (e.g. "company.thebrowser.Browser" with Arc not
    // installed — the reverse-DNS string won't match any display-name substring).
    const appIdentifierCandidate =
      appIdentifier ?? (looksLikeAppIdentifier(requested) ? requested : undefined);
    return {
      requestedName: requested,
      resolved,
      isSentinel: appIdentifier ? SENTINEL_APP_IDENTIFIERS.has(appIdentifier) : false,
      alreadyGranted: appIdentifier ? alreadyGrantedAppIdentifiers.has(appIdentifier) : false,
      proposedTier: getDefaultTierForApp(
        appIdentifierCandidate,
        resolved?.displayName ?? requested,
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Individual tool handlers
// ---------------------------------------------------------------------------

async function handleRequestAccess(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  tccState: { accessibility: boolean; screenRecording: boolean } | undefined,
): Promise<CuCallToolResult> {
  // request_access is mac-only — the tool is filtered out of the Win tool
  // list (see tools.ts). Narrow `overrides` to the darwin variant so reads
  // of allowedApps / userDeniedAppIdentifiers typecheck.
  if (overrides.platform !== "darwin") {
    return errorResult(
      "request_access is mac-only — Windows has no allowlist permission model.",
      "bad_args",
    );
  }
  adapter.logger.debug(
    `[CU-GATE] handleRequestAccess called: apps=${JSON.stringify(args.apps)} ` +
      `bypass=${isAllowlistBypassed()} ` +
      `(bypass mode does NOT auto-skip request_access — AI is the one calling it. ` +
      `If AI keeps calling this with bypass=true, the tool description is steering it; consider hiding the tool.)`,
  );
  if (!overrides.onPermissionRequest) {
    return errorResult(
      "This session was not wired with a permission handler. Computer control is not available here.",
      "feature_unavailable",
    );
  }

  // Teach mode hides the main window; permission dialogs render in that
  // window. Without this, handleToolPermission blocks on an invisible
  // prompt and the overlay spins forever. Tell the model to exit teach
  // mode, request access, then re-enter.
  if (overrides.getTeachModeActive?.()) {
    return errorResult(
      "Cannot request additional permissions during teach mode — the permission dialog would be hidden. End teach mode (finish the tour or let the turn complete), then call request_access, then start a new tour.",
      "teach_mode_conflict",
    );
  }

  const reason = requireString(args, "reason");
  if (reason instanceof Error) return errorResult(reason.message, "bad_args");

  // TCC-ungranted branch. The renderer shows a toggle panel INSTEAD OF the
  // app list when `tccState` is present on the request, so we skip app
  // resolution entirely (listInstalledApps() may fail without Screen
  // Recording anyway). The user grants the OS perms from inside the dialog,
  // then clicks "Ask again" — both buttons resolve with deny by design
  // (ComputerUseApproval.tsx) so the model re-calls request_access and
  // gets the app list on the next call.
  if (tccState) {
    const req: CuPermissionRequest = {
      requestId: randomUUID(),
      reason,
      apps: [],
      requestedFlags: {},
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      tccState,
    };
    await overrides.onPermissionRequest(req);

    // Re-check: the user may have granted in System Settings while the
    // dialog was up. The `tccState` arg is a pre-dialog snapshot — reading
    // it here would tell the model "not yet granted" even after the user
    // granted, and the model waits for confirmation instead of retrying.
    // The renderer's TCC panel already live-polls (computerUseTccStore);
    // this is the same re-check on the tool-result side.
    const recheck = await adapter.ensureOsPermissions();
    if (recheck.granted) {
      return errorResult(
        "macOS Accessibility and Screen Recording are now both granted. " +
          "Call request_access again immediately — the next call will show " +
          "the app selection list.",
      );
    }
    // request_access is mac-only (filtered out of Win tool list); recheck
    // on win would have hit `granted: true` above. Narrow for TS.
    if (recheck.platform !== "darwin") {
      return errorResult("OS permissions unexpectedly ungranted on non-darwin platform.");
    }

    const missing: string[] = [];
    if (!recheck.accessibility) missing.push("Accessibility");
    if (!recheck.screenRecording) missing.push("Screen Recording");
    return errorResult(
      `macOS ${missing.join(" and ")} permission(s) not yet granted. ` +
        `The permission panel has been shown. Once the user grants the ` +
        `missing permission(s), call request_access again.`,
      "tcc_not_granted",
    );
  }

  const rawApps = args.apps;
  if (!Array.isArray(rawApps) || !rawApps.every((a) => typeof a === "string")) {
    return errorResult('"apps" must be an array of strings.', "bad_args");
  }
  const apps = rawApps as string[];

  const requestedFlags: Partial<CuGrantFlags> = {};
  if (typeof args.clipboardRead === "boolean") {
    requestedFlags.clipboardRead = args.clipboardRead;
  }
  if (typeof args.clipboardWrite === "boolean") {
    requestedFlags.clipboardWrite = args.clipboardWrite;
  }
  if (typeof args.systemKeyCombos === "boolean") {
    requestedFlags.systemKeyCombos = args.systemKeyCombos;
  }

  const {
    needDialog,
    skipDialogGrants,
    willHide,
    tieredApps,
    userDenied,
    policyDenied,
  } = await buildAccessRequest(
    adapter,
    apps,
    overrides.allowedApps,
    new Set(overrides.userDeniedAppIdentifiers),
    overrides.selectedDisplayId,
  );

  let dialogGranted: AppGrant[] = [];
  let dialogDenied: Array<{
    appIdentifier: string;
    reason: "user_denied" | "not_installed";
  }> = [];
  let dialogFlags: CuGrantFlags = overrides.grantFlags;

  if (needDialog.length > 0 || Object.keys(requestedFlags).length > 0) {
    const req: CuPermissionRequest = {
      requestId: randomUUID(),
      reason,
      apps: needDialog,
      requestedFlags,
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      // Undefined when empty so the renderer skips the section cleanly.
      ...(willHide.length > 0 && {
        willHide,
        autoUnhideEnabled: adapter.getAutoUnhideEnabled(),
      }),
    };
    const response = await overrides.onPermissionRequest(req);
    dialogGranted = response.granted;
    dialogDenied = response.denied;
    dialogFlags = response.flags;
  }

  // Do NOT return display geometry or coordinateMode. See COORDINATES.md
  // ("Never give the model a number that invites rescaling"). scaleCoord
  // already transforms server-side; the coordinate convention is baked into
  // the tool param descriptions at server-construction time.
  const allGranted = [...skipDialogGrants, ...dialogGranted];
  // Filter tieredApps to what was actually granted — if the user unchecked
  // Chrome in the dialog, don't explain Chrome's tier.
  const grantedAppIdentifiers = new Set(allGranted.map((g) => g.appIdentifier));
  const grantedTieredApps = tieredApps.filter((t) =>
    grantedAppIdentifiers.has(t.appIdentifier),
  );
  // Best-effort — grants are already persisted by wrappedPermissionHandler;
  // a listDisplays/findWindowDisplays failure (monitor hot-unplug, NAPI
  // error) must not tank the grant response. Same discipline as
  // buildMonitorNote's listDisplays try/catch.
  let windowLocations: Awaited<ReturnType<typeof buildWindowLocations>> = [];
  try {
    windowLocations = await buildWindowLocations(adapter, allGranted);
  } catch (e) {
    adapter.logger.warn(
      `[computer-use] buildWindowLocations failed: ${String(e)}`,
    );
  }
  return okJson(
    {
      granted: allGranted,
      denied: dialogDenied,
      // Policy blocklist — precedes userDenied in precedence and response
      // order. No escape hatch; the agent is told to find another approach.
      ...(policyDenied.length > 0 && {
        policyDenied: {
          apps: policyDenied,
          guidance: buildPolicyDeniedGuidance(policyDenied),
        },
      }),
      // User-configured auto-deny — stripped before the dialog; this is the
      // agent's only signal that these apps exist but are user-blocked.
      ...(userDenied.length > 0 && {
        userDenied: {
          apps: userDenied,
          guidance: buildUserDeniedGuidance(userDenied),
        },
      }),
      // Upfront guidance so the model knows what each tier allows BEFORE
      // hitting the gate. Only included when something was tier-restricted.
      ...(grantedTieredApps.length > 0 && {
        tierGuidance: buildTierGuidanceMessage(grantedTieredApps),
      }),
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      // Where each granted app currently has open windows, across monitors.
      // Omitted when the app isn't running or has no normal windows.
      ...(windowLocations.length > 0 ? { windowLocations } : {}),
    },
    {
      // dialogGranted only — skipDialogGrants are idempotent re-grants of
      // apps already in the allowlist (no user action, dialog skips them).
      // Matching denied_count's this-call-only semantics.
      granted_count: dialogGranted.length,
      denied_count: dialogDenied.length,
      ...tierAssignmentTelemetry(grantedTieredApps),
    },
  );
}

/**
 * For each granted app with open windows, which displays those windows are
 * on. Single-monitor setups return an empty array (no multi-monitor signal
 * to give). Apps not running, or running with no normal windows, are omitted.
 */
async function buildWindowLocations(
  adapter: ComputerUseHostAdapter,
  granted: AppGrant[],
): Promise<
  Array<{
    appIdentifier: string;
    displayName: string;
    displays: Array<{ id: number; label?: string; isPrimary?: boolean }>;
  }>
> {
  if (granted.length === 0) return [];

  const displays = await adapter.executor.listDisplays();
  if (displays.length <= 1) return [];

  const grantedAppIdentifiers = granted.map((g) => g.appIdentifier);
  const windowLocs = await adapter.executor.findWindowDisplays(grantedAppIdentifiers);
  const displayById = new Map(displays.map((d) => [d.displayId, d]));
  const idsByAppIdentifier = new Map(windowLocs.map((w) => [w.appIdentifier, w.displayIds]));

  const out = [];
  for (const g of granted) {
    const displayIds = idsByAppIdentifier.get(g.appIdentifier);
    if (!displayIds || displayIds.length === 0) continue;
    out.push({
      appIdentifier: g.appIdentifier,
      displayName: g.displayName,
      displays: displayIds.map((id) => {
        const d = displayById.get(id);
        return { id, label: d?.label, isPrimary: d?.isPrimary };
      }),
    });
  }
  return out;
}

/**
 * Shared app-resolution + partition + hide-preview pipeline. Extracted from
 * `handleRequestAccess` so `handleRequestTeachAccess` can call the same path.
 *
 * Does the full app-name→InstalledApp resolution, assigns each a tier
 * (browser→"read", terminal/IDE→"click", else "full" — see deniedApps.ts),
 * splits into already-granted (skip the dialog, preserve grantedAt+tier) vs
 * need-dialog, and computes the willHide preview. Unlike the previous
 * hard-deny model, ALL apps proceed to the dialog; the tier just constrains
 * what actions are allowed once granted.
 */
/** An app assigned a restricted tier (not `"full"`). Used to build the
 *  guidance message telling the model what it can/can't do. */
interface TieredApp {
  appIdentifier: string;
  displayName: string;
  /** Never `"full"` — only restricted tiers are collected. */
  tier: "read" | "click";
}

interface AccessRequestParts {
  needDialog: ResolvedAppRequest[];
  skipDialogGrants: AppGrant[];
  willHide: Array<{ appIdentifier: string; displayName: string }>;
  /** Resolved apps with `proposedTier !== "full"` — for the guidance text.
   *  Unresolved apps are omitted (they go to `denied` with `not_installed`).  */
  tieredApps: TieredApp[];
  /** Apps stripped by the user's Settings auto-deny list. Surfaced in the
   *  response with guidance; never reach the dialog. */
  userDenied: Array<{ requestedName: string; displayName: string }>;
  /** Apps stripped by the baked-in policy blocklist (streaming/music/ebooks,
   *  etc. — `deniedApps.isPolicyDenied`). Precedence over userDenied. */
  policyDenied: Array<{ requestedName: string; displayName: string }>;
}

async function buildAccessRequest(
  adapter: ComputerUseHostAdapter,
  apps: string[],
  allowedApps: AppGrant[],
  userDeniedAppIdentifiers: ReadonlySet<string>,
  selectedDisplayId?: number,
): Promise<AccessRequestParts> {
  const alreadyGranted = new Set(allowedApps.map((g) => g.appIdentifier));
  const installed = await adapter.executor.listInstalledApps();
  const resolved = resolveRequestedApps(apps, installed, alreadyGranted);

  // Policy-level auto-deny (baked-in, not user-configurable). Stripped
  // before userDenied — checks bundle ID AND display name (covers
  // unresolved requests). Precedence: policy > user setting > tier.
  const policyDenied: Array<{ requestedName: string; displayName: string }> =
    [];
  const afterPolicy: typeof resolved = [];
  for (const r of resolved) {
    const displayName = r.resolved?.displayName ?? r.requestedName;
    if (isPolicyDenied(r.resolved?.appIdentifier, displayName)) {
      policyDenied.push({ requestedName: r.requestedName, displayName });
    } else {
      afterPolicy.push(r);
    }
  }

  // User-configured auto-deny (Settings → Desktop app → Computer Use).
  // Stripped BEFORE
  // tier assignment — these never reach the dialog regardless of category.
  // Bundle-ID match only (the Settings UI picks from installed apps, which
  // always have a bundle ID). Unresolved requests pass through to the tier
  // system; the user can't preemptively deny an app that isn't installed.
  const userDenied: Array<{ requestedName: string; displayName: string }> = [];
  const surviving: typeof afterPolicy = [];
  for (const r of afterPolicy) {
    if (r.resolved && userDeniedAppIdentifiers.has(r.resolved.appIdentifier)) {
      userDenied.push({
        requestedName: r.requestedName,
        displayName: r.resolved.displayName,
      });
    } else {
      surviving.push(r);
    }
  }

  // Collect resolved apps with a restricted tier for the guidance message.
  // Unresolved apps with a restricted tier (e.g. model asks for "Chrome" but
  // it's not installed) are omitted — they'll end up in the `denied` list
  // with reason "not_installed" and the model will see that instead.
  const tieredApps: TieredApp[] = [];
  for (const r of surviving) {
    if (r.proposedTier === "full" || !r.resolved) continue;
    tieredApps.push({
      appIdentifier: r.resolved.appIdentifier,
      displayName: r.resolved.displayName,
      tier: r.proposedTier,
    });
  }

  // Idempotence: apps that are already granted skip the dialog and are
  // merged into the `granted` response. Existing grants keep their tier
  // (which may differ from the current proposedTier if policy changed).
  const skipDialog = surviving.filter((r) => r.alreadyGranted);
  const needDialog = surviving.filter((r) => !r.alreadyGranted);

  const now = Date.now();
  const skipDialogGrants: AppGrant[] = skipDialog
    .filter((r) => r.resolved)
    .map((r) => {
      // Reuse the existing grant (preserving grantedAt + tier) rather than
      // synthesizing a new one — keeps Settings-page "Granted 3m ago" honest.
      const existing = allowedApps.find(
        (g) => g.appIdentifier === r.resolved!.appIdentifier,
      );
      return (
        existing ?? {
          appIdentifier: r.resolved!.appIdentifier,
          displayName: r.resolved!.displayName,
          grantedAt: now,
          tier: r.proposedTier,
        }
      );
    });

  // Preview what will be hidden if the user approves exactly the requested
  // set plus what they already have. All tiers are visible, so everything
  // resolved goes in the exempt set.
  const exemptForPreview = [
    ...allowedApps.map((a) => a.appIdentifier),
    ...surviving.filter((r) => r.resolved).map((r) => r.resolved!.appIdentifier),
  ];
  const willHide = (await adapter.executor.previewHideSet?.(
    exemptForPreview,
    selectedDisplayId,
  )) ?? [];

  return {
    needDialog,
    skipDialogGrants,
    willHide,
    tieredApps,
    userDenied,
    policyDenied,
  };
}

/**
 * Build guidance text for apps granted at a restricted tier. Returned
 * inline in the okJson response so the model knows upfront what it can
 * do with each app, instead of learning by hitting the tier gate.
 */
function buildTierGuidanceMessage(tiered: TieredApp[]): string {
  // tier "read" is not category-unique — split so browsers get the CiC hint
  // and trading platforms get "ask the user" instead.
  const readBrowsers = tiered.filter(
    (t) =>
      t.tier === "read" &&
      getDeniedCategoryForApp(t.appIdentifier, t.displayName) === "browser",
  );
  const readOther = tiered.filter(
    (t) =>
      t.tier === "read" &&
      getDeniedCategoryForApp(t.appIdentifier, t.displayName) !== "browser",
  );
  const clickTier = tiered.filter((t) => t.tier === "click");

  const parts: string[] = [];

  if (readBrowsers.length > 0) {
    const names = readBrowsers.map((b) => `"${b.displayName}"`).join(", ");
    parts.push(
      `${names} ${readBrowsers.length === 1 ? "is a browser" : "are browsers"} — ` +
        `granted at tier "read" (visible in screenshots only; no clicks or ` +
        `typing). You can read what's on screen but cannot navigate, click, ` +
        `or type into ${readBrowsers.length === 1 ? "it" : "them"}. Ask the ` +
        `user to take any actions in these apps themselves.`,
    );
  }

  if (readOther.length > 0) {
    const names = readOther.map((t) => `"${t.displayName}"`).join(", ");
    parts.push(
      `${names} ${readOther.length === 1 ? "is" : "are"} granted at tier ` +
        `"read" (visible in screenshots only; no clicks or typing). You can ` +
        `read what's on screen but cannot interact. Ask the user to take any ` +
        `actions in ${readOther.length === 1 ? "this app" : "these apps"} ` +
        `themselves.`,
    );
  }

  if (clickTier.length > 0) {
    const names = clickTier.map((t) => `"${t.displayName}"`).join(", ");
    parts.push(
      `${names} ${clickTier.length === 1 ? "has" : "have"} terminal or IDE ` +
        `capabilities — granted at tier "click" (visible + plain left-click ` +
        `only; NO typing, key presses, right-click, modifier-clicks, or ` +
        `drag-drop). You can click buttons and scroll output, but ` +
        `${clickTier.length === 1 ? "its" : "their"} integrated terminal and ` +
        `editor are off-limits to keyboard input. Right-click (context-menu ` +
        `Paste) and dragging text onto ${clickTier.length === 1 ? "it" : "them"} ` +
        `require tier "full". For shell commands, use the Bash tool.`,
    );
  }

  if (parts.length === 0) return "";
  // Same anti-subversion clause the gate errors carry — said upfront so the
  // model doesn't reach for osascript/cliclick after seeing "no clicks/typing".
  return parts.join("\n\n") + TIER_ANTI_SUBVERSION;
}

/**
 * Build guidance text for apps stripped by the user's Settings auto-deny
 * list. Returned inline in the okJson response so the agent knows (a) the
 * app is auto-denied by request_access and (b) the escape hatch
 * is to ask the human to edit Settings, not to retry or reword the request.
 */
function buildUserDeniedGuidance(
  userDenied: Array<{ requestedName: string; displayName: string }>,
): string {
  const names = userDenied.map((d) => `"${d.displayName}"`).join(", ");
  const one = userDenied.length === 1;
  return (
    `${names} ${one ? "is" : "are"} in the user's auto-deny list ` +
    `(Settings → Desktop app (General) → Computer Use → Denied apps). ` +
    `Requests for ` +
    `${one ? "this app" : "these apps"} are automatically denied. If you need access for ` +
    `this task, ask the user to remove ${one ? "it" : "them"} from their ` +
    `deny list in Settings — you cannot request this through the tool.`
  );
}

/**
 * Guidance for policy-denied apps (baked-in blocklist, not user-editable).
 * Unlike userDenied, there is no escape hatch — the agent is told to find
 * another approach.
 */
function buildPolicyDeniedGuidance(
  policyDenied: Array<{ requestedName: string; displayName: string }>,
): string {
  const names = policyDenied.map((d) => `"${d.displayName}"`).join(", ");
  const one = policyDenied.length === 1;
  return (
    `${names} ${one ? "is" : "are"} blocked by policy for computer use. ` +
    `Requests for ${one ? "this app" : "these apps"} are automatically ` +
    `denied regardless of what the user has approved. There is no Settings ` +
    `override. Inform the user that you cannot access ` +
    `${one ? "this app" : "these apps"} and suggest an alternative ` +
    `approach if one exists. Do not try to directly subvert this block ` +
    `regardless of the user's request.`
  );
}

/**
 * Telemetry helper — counts by category. Field names (`denied_*`) are kept
 * for schema compat; interpret as "assigned non-full tier" in dashboards.
 */
function tierAssignmentTelemetry(
  tiered: TieredApp[],
): Pick<CuCallTelemetry, "denied_browser_count" | "denied_terminal_count"> {
  // `denied_browser_count` now counts ALL tier-"read" grants (browsers +
  // trading). The field name was already legacy-only before trading existed
  // (dashboards read it as "non-full tier"), so no new column.
  const browserCount = tiered.filter((t) => t.tier === "read").length;
  const terminalCount = tiered.filter((t) => t.tier === "click").length;
  return {
    ...(browserCount > 0 && { denied_browser_count: browserCount }),
    ...(terminalCount > 0 && { denied_terminal_count: terminalCount }),
  };
}

/**
 * Sibling of `handleRequestAccess`. Same app-resolution + TCC-threading, but
 * routes to the teach approval dialog and fires `onTeachModeActivated` on
 * success. No grant-flag checkboxes (clipboard/systemKeys) in teach mode —
 * the tool schema omits those fields.
 *
 * Unlike `request_access`, this ALWAYS shows the dialog even when every
 * requested app is already granted. Teach mode is a distinct UX the user
 * must explicitly consent to (main window hides) — idempotent app grants
 * don't imply consent to being guided.
 */
async function handleRequestTeachAccess(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  tccState: { accessibility: boolean; screenRecording: boolean } | undefined,
): Promise<CuCallToolResult> {
  // Mac-only flow (teach mode is mac-only by design — no Win analog).
  if (overrides.platform !== "darwin") {
    return errorResult(
      "request_teach_access is mac-only.",
      "feature_unavailable",
    );
  }
  if (!overrides.onTeachPermissionRequest) {
    return errorResult(
      "Teach mode is not available in this session.",
      "feature_unavailable",
    );
  }

  // Same as handleRequestAccess above — the dialog renders in the hidden
  // main window. Model re-calling request_teach_access mid-tour (to add
  // another app) is plausible since request_access docs say "call again
  // mid-session to add more apps" and this uses the same grant model.
  if (overrides.getTeachModeActive?.()) {
    return errorResult(
      "Teach mode is already active. To add more apps, end the current tour first, then call request_teach_access again with the full app list.",
      "teach_mode_conflict",
    );
  }

  const reason = requireString(args, "reason");
  if (reason instanceof Error) return errorResult(reason.message, "bad_args");

  // TCC-ungranted branch — identical to handleRequestAccess's. The renderer
  // shows the same TCC toggle panel regardless of which request tool got here.
  if (tccState) {
    const req: CuTeachPermissionRequest = {
      requestId: randomUUID(),
      reason,
      apps: [],
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      tccState,
    };
    await overrides.onTeachPermissionRequest(req);

    // Same re-check as handleRequestAccess — user may have granted while the
    // dialog was up, and the pre-dialog snapshot would mislead the model.
    const recheck = await adapter.ensureOsPermissions();
    if (recheck.granted) {
      return errorResult(
        "macOS Accessibility and Screen Recording are now both granted. " +
          "Call request_teach_access again immediately — the next call will " +
          "show the app selection list.",
      );
    }
    // request_teach_access is mac-only (filtered out of Win tool list).
    if (recheck.platform !== "darwin") {
      return errorResult("OS permissions unexpectedly ungranted on non-darwin platform.");
    }

    const missing: string[] = [];
    if (!recheck.accessibility) missing.push("Accessibility");
    if (!recheck.screenRecording) missing.push("Screen Recording");
    return errorResult(
      `macOS ${missing.join(" and ")} permission(s) not yet granted. ` +
        `The permission panel has been shown. Once the user grants the ` +
        `missing permission(s), call request_teach_access again.`,
      "tcc_not_granted",
    );
  }

  const rawApps = args.apps;
  if (!Array.isArray(rawApps) || !rawApps.every((a) => typeof a === "string")) {
    return errorResult('"apps" must be an array of strings.', "bad_args");
  }
  const apps = rawApps as string[];

  const {
    needDialog,
    skipDialogGrants,
    willHide,
    tieredApps,
    userDenied,
    policyDenied,
  } = await buildAccessRequest(
    adapter,
    apps,
    overrides.allowedApps,
    new Set(overrides.userDeniedAppIdentifiers),
    overrides.selectedDisplayId,
  );

  // All requested apps were user-denied (or unresolvable) and none pre-granted
  // — skip the dialog entirely. Without this, onTeachPermissionRequest fires
  // with apps:[] and the user sees an empty approval dialog where Allow and
  // Deny produce the same result (granted=[] → teachModeActive stays false).
  // handleRequestAccess has the equivalent guard at the needDialog.length
  // check; teach didn't need one before user-deny because needDialog=[]
  // previously implied skipDialogGrants.length > 0 (all-already-granted).
  if (needDialog.length === 0 && skipDialogGrants.length === 0) {
    return okJson(
      {
        granted: [],
        denied: [],
        ...(policyDenied.length > 0 && {
          policyDenied: {
            apps: policyDenied,
            guidance: buildPolicyDeniedGuidance(policyDenied),
          },
        }),
        ...(userDenied.length > 0 && {
          userDenied: {
            apps: userDenied,
            guidance: buildUserDeniedGuidance(userDenied),
          },
        }),
        teachModeActive: false,
        screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      },
      { granted_count: 0, denied_count: 0 },
    );
  }

  const req: CuTeachPermissionRequest = {
    requestId: randomUUID(),
    reason,
    apps: needDialog,
    screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
    ...(willHide.length > 0 && {
      willHide,
      autoUnhideEnabled: adapter.getAutoUnhideEnabled(),
    }),
  };
  const response = await overrides.onTeachPermissionRequest(req);

  const granted = [...skipDialogGrants, ...response.granted];
  // Gate on explicit dialog consent, NOT on merged grant length.
  // skipDialogGrants are pre-existing idempotent app grants — they don't
  // imply the user said yes to THIS dialog. Without the userConsented
  // check, Deny would still activate teach mode whenever any requested
  // app was previously granted (worst case: needDialog=[] → Allow and
  // Deny payloads are structurally identical).
  const teachModeActive = response.userConsented === true && granted.length > 0;
  if (teachModeActive) {
    overrides.onTeachModeActivated?.();
  }

  const grantedAppIdentifiers = new Set(granted.map((g) => g.appIdentifier));
  const grantedTieredApps = tieredApps.filter((t) =>
    grantedAppIdentifiers.has(t.appIdentifier),
  );

  return okJson(
    {
      granted,
      denied: response.denied,
      ...(policyDenied.length > 0 && {
        policyDenied: {
          apps: policyDenied,
          guidance: buildPolicyDeniedGuidance(policyDenied),
        },
      }),
      ...(userDenied.length > 0 && {
        userDenied: {
          apps: userDenied,
          guidance: buildUserDeniedGuidance(userDenied),
        },
      }),
      ...(grantedTieredApps.length > 0 && {
        tierGuidance: buildTierGuidanceMessage(grantedTieredApps),
      }),
      teachModeActive,
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
    },
    {
      // response.granted only — skipDialogGrants are idempotent re-grants.
      // See handleRequestAccess's parallel comment.
      granted_count: response.granted.length,
      denied_count: response.denied.length,
      ...tierAssignmentTelemetry(grantedTieredApps),
    },
  );
}

// ---------------------------------------------------------------------------
// teach_step + teach_batch — shared step primitives
// ---------------------------------------------------------------------------

/** A fully-validated teach step, anchor already scaled to logical points. */
interface ValidatedTeachStep {
  explanation: string;
  nextPreview: string;
  anchorLogical: TeachStepRequest["anchorLogical"];
  actions: Array<Record<string, unknown>>;
}

/**
 * Validate one raw step record and scale its anchor. `label` is prefixed to
 * error messages so teach_batch can say `steps[2].actions[0]` instead of
 * just `actions[0]`.
 *
 * The anchor transform is the whole coordinate story: model sends image-pixel
 * coords (same space as click coords, per COORDINATES.md), `scaleCoord` turns
 * them into logical points against `overrides.lastScreenshot`. For
 * teach_batch, lastScreenshot stays at its pre-call value for the entire
 * batch — same invariant as computer_batch's "coordinates refer to the
 * PRE-BATCH screenshot". Anchors for step 2+ must therefore target elements
 * the model can predict will be at those coordinates after step 1's actions.
 */
async function validateTeachStepArgs(
  raw: Record<string, unknown>,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  label: string,
): Promise<ValidatedTeachStep | Error> {
  const explanation = requireString(raw, "explanation");
  if (explanation instanceof Error) {
    return new Error(`${label}: ${explanation.message}`);
  }
  const nextPreview = requireString(raw, "next_preview");
  if (nextPreview instanceof Error) {
    return new Error(`${label}: ${nextPreview.message}`);
  }

  const actions = raw.actions;
  if (!Array.isArray(actions)) {
    return new Error(
      `${label}: "actions" must be an array (empty is allowed).`,
    );
  }
  for (const [i, act] of actions.entries()) {
    if (typeof act !== "object" || act === null) {
      return new Error(`${label}: actions[${i}] must be an object`);
    }
    const action = (act as Record<string, unknown>).action;
    if (typeof action !== "string") {
      return new Error(`${label}: actions[${i}].action must be a string`);
    }
    if (!BATCHABLE_ACTIONS.has(action)) {
      return new Error(
        `${label}: actions[${i}].action="${action}" is not allowed. ` +
          `Allowed: ${[...BATCHABLE_ACTIONS].join(", ")}.`,
      );
    }
  }

  let anchorLogical: TeachStepRequest["anchorLogical"];
  if (raw.anchor !== undefined) {
    const anchor = raw.anchor;
    if (
      !Array.isArray(anchor) ||
      anchor.length !== 2 ||
      typeof anchor[0] !== "number" ||
      typeof anchor[1] !== "number" ||
      !Number.isFinite(anchor[0]) ||
      !Number.isFinite(anchor[1])
    ) {
      return new Error(
        `${label}: "anchor" must be a [x, y] number tuple or omitted.`,
      );
    }
    const display = await adapter.executor.getDisplaySize(
      overrides.selectedDisplayId,
    );
    const ctx = screenScaleCtx(display);
    anchorLogical = scaleCoord(
      anchor[0],
      anchor[1],
      overrides.coordinateMode,
      display,
      ctx,
      adapter.logger,
    );
  }

  return {
    explanation,
    nextPreview,
    anchorLogical,
    actions: actions as Array<Record<string, unknown>>,
  };
}

/** Outcome of showing one tooltip + running its actions. */
type TeachStepOutcome =
  | { kind: "exit" }
  | { kind: "ok"; results: BatchActionResult[] }
  | {
      kind: "action_error";
      executed: number;
      failed: BatchActionResult;
      remaining: number;
      /** The inner action's telemetry (error_kind), forwarded so the
       *  caller can pass it to okJson and keep cu_tool_call accurate
       *  when the failure happened inside a batch. */
      telemetry: CuCallTelemetry | undefined;
    };

/**
 * Show the tooltip, block for Next/Exit, run actions on Next.
 *
 * Action execution is a straight lift from `handleComputerBatch`:
 * prepareForAction ONCE per step (the user clicked Next — they consented to
 * that step's sequence), pixelValidation OFF (committed sequence), frontmost
 * gate still per-action, stop-on-first-error with partial results.
 *
 * Empty `actions` is valid — "read this, click Next to continue" steps.
 * Assumes `overrides.onTeachStep` is set (caller guards).
 */
async function executeTeachStep(
  step: ValidatedTeachStep,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<TeachStepOutcome> {
  // Teach mode is mac-only — caller (handleTeachStep) is gated on the same.
  // Re-narrow here so overrides.allowedApps reads typecheck.
  if (overrides.platform !== "darwin") {
    return { kind: "exit" };
  }
  // Block until Next or Exit. Same pending-promise pattern as
  // onPermissionRequest — host stores the resolver, overlay IPC fires it.
  // `!` is safe: both callers guard on overrides.onTeachStep before reaching here.
  const stepResult = await overrides.onTeachStep!({
    explanation: step.explanation,
    nextPreview: step.nextPreview,
    anchorLogical: step.anchorLogical,
  });

  if (stepResult.action === "exit") {
    // The host's Exit handler also calls stopSession, so the turn is
    // already unwinding. Caller decides what to return for the transcript.
    // A PREVIOUS step's left_mouse_down may have left the OS button held.
    await releaseHeldMouse(adapter);
    return { kind: "exit" };
  }

  // Next clicked. Flip overlay to spinner before we start driving.
  overrides.onTeachWorking?.();

  if (step.actions.length === 0) {
    return { kind: "ok", results: [] };
  }

  if (subGates.hideBeforeAction) {
    const hidden = (await adapter.executor.prepareForAction?.(
      overrides.allowedApps.map((a) => a.appIdentifier),
      overrides.selectedDisplayId,
    )) ?? [];
    if (hidden.length > 0) {
      overrides.onAppsHidden?.(hidden);
    }
  }

  const stepSubGates: CuSubGates = {
    ...subGates,
    hideBeforeAction: false,
    // Anchors are pre-computed against the display at batch start.
    // A mid-batch resolver switch would break tooltip positioning.
    autoTargetDisplay: false,
  };

  const results: BatchActionResult[] = [];
  for (const [i, act] of step.actions.entries()) {
    // Same abort check as handleComputerBatch — Exit calls stopSession so
    // this IS the exit path, just caught mid-dispatch instead of at the
    // onTeachStep await above. Callers already handle { kind: "exit" }.
    if (overrides.isAborted?.()) {
      await releaseHeldMouse(adapter);
      return { kind: "exit" };
    }
    // Same inter-step settle as handleComputerBatch.
    if (i > 0) await sleep(10);
    const action = act.action as string;

    // Drop mid-step screenshot piggyback — same invariant as computer_batch.
    // Click coords stay anchored to the screenshot the model took BEFORE
    // calling teach_step/teach_batch.
    const { screenshot: _dropped, ...inner } = await dispatchAction(
      action,
      act,
      adapter,
      overrides,
      stepSubGates,
    );

    const text = firstTextContent(inner);
    const result = { action, ok: !inner.isError, output: text };
    results.push(result);

    if (inner.isError) {
      await releaseHeldMouse(adapter);
      return {
        kind: "action_error",
        executed: results.length - 1,
        failed: result,
        remaining: step.actions.length - results.length,
        telemetry: inner.telemetry,
      };
    }
  }

  return { kind: "ok", results };
}

/**
 * Fold a fresh screenshot into the result. Eliminates the separate
 * screenshot tool call the model would otherwise make before the next
 * teach_step (one fewer API round trip per step). handleScreenshot
 * runs its own prepareForAction — that's correct: actions may have
 * opened something outside the allowlist. The .screenshot piggyback
 * flows through to serverDef.ts's stash → lastScreenshot updates →
 * the next teach_step.anchor scales against THIS image, which is what
 * the model is now looking at.
 */
async function appendTeachScreenshot(
  resultJson: unknown,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const shotResult = await handleScreenshot(adapter, overrides, subGates);
  if (shotResult.isError) {
    // Hide+screenshot failed (rare — e.g. SCContentFilter error). Don't
    // tank the step; just omit the image. Model will call screenshot
    // itself and see the real error.
    return okJson(resultJson);
  }
  return {
    content: [
      { type: "text", text: JSON.stringify(resultJson) },
      // handleScreenshot's content is [maybeMonitorNote, maybeHiddenNote,
      // image]. Spread all — both notes are useful context and the model
      // expects them alongside screenshots.
      ...shotResult.content,
    ],
    // For serverDef.ts to stash. Next teach_step.anchor scales against this.
    screenshot: shotResult.screenshot,
  };
}

/**
 * Show one guided-tour tooltip and block until the user clicks Next or Exit.
 * On Next, execute `actions[]` with `computer_batch` semantics.
 */
async function handleTeachStep(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (!overrides.onTeachStep) {
    return errorResult(
      "Teach mode is not active. Call request_teach_access first.",
      "teach_mode_not_active",
    );
  }

  const step = await validateTeachStepArgs(
    args,
    adapter,
    overrides,
    "teach_step",
  );
  if (step instanceof Error) return errorResult(step.message, "bad_args");

  const outcome = await executeTeachStep(step, adapter, overrides, subGates);

  if (outcome.kind === "exit") {
    return okJson({ exited: true });
  }
  if (outcome.kind === "action_error") {
    return okJson(
      {
        executed: outcome.executed,
        failed: outcome.failed,
        remaining: outcome.remaining,
      },
      outcome.telemetry,
    );
  }

  // ok. No screenshot for empty actions — screen didn't change, model's
  // existing screenshot is still accurate.
  if (step.actions.length === 0) {
    return okJson({ executed: 0, results: [] });
  }
  return appendTeachScreenshot(
    { executed: outcome.results.length, results: outcome.results },
    adapter,
    overrides,
    subGates,
  );
}

/**
 * Queue a whole guided tour in one tool call. Parallels `computer_batch`: N
 * steps → one model→API round trip instead of N. Each step still blocks for
 * its own Next click (the user paces the tour), but the model doesn't wait
 * for a round trip between steps.
 *
 * Validates ALL steps upfront so a typo in step 5 doesn't surface after the
 * user has already clicked through steps 1–4.
 *
 * Anchors for every step scale against the pre-call `lastScreenshot` — same
 * PRE-BATCH invariant as computer_batch. Steps 2+ should either omit anchor
 * (centered tooltip) or target elements the model predicts won't have moved.
 *
 * Result shape:
 *   {exited: true, stepsCompleted: N}                   — user clicked Exit
 *   {stepsCompleted, stepFailed, executed, failed, …}   — action error at step N
 *   {stepsCompleted, results: [...]} + screenshot       — all steps ran
 */
async function handleTeachBatch(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (!overrides.onTeachStep) {
    return errorResult(
      "Teach mode is not active. Call request_teach_access first.",
      "teach_mode_not_active",
    );
  }

  const rawSteps = args.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length < 1) {
    return errorResult('"steps" must be a non-empty array.', "bad_args");
  }

  // Validate upfront — fail fast before showing any tooltip.
  const steps: ValidatedTeachStep[] = [];
  for (const [i, raw] of rawSteps.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return errorResult(`steps[${i}] must be an object`, "bad_args");
    }
    const v = await validateTeachStepArgs(
      raw as Record<string, unknown>,
      adapter,
      overrides,
      `steps[${i}]`,
    );
    if (v instanceof Error) return errorResult(v.message, "bad_args");
    steps.push(v);
  }

  const allResults: BatchActionResult[][] = [];
  for (const [i, step] of steps.entries()) {
    const outcome = await executeTeachStep(step, adapter, overrides, subGates);

    if (outcome.kind === "exit") {
      return okJson({ exited: true, stepsCompleted: i });
    }
    if (outcome.kind === "action_error") {
      return okJson(
        {
          stepsCompleted: i,
          stepFailed: i,
          executed: outcome.executed,
          failed: outcome.failed,
          remaining: outcome.remaining,
          results: allResults,
        },
        outcome.telemetry,
      );
    }
    allResults.push(outcome.results);
  }

  // Final screenshot only if any step ran actions (screen changed).
  const screenChanged = steps.some((s) => s.actions.length > 0);
  const resultJson = { stepsCompleted: steps.length, results: allResults };
  if (!screenChanged) {
    return okJson(resultJson);
  }
  return appendTeachScreenshot(resultJson, adapter, overrides, subGates);
}

/**
 * Build the hidden-apps note that accompanies a screenshot. Tells the model
 * which apps got hidden (not in allowlist) and how to add them. Returns
 * undefined when nothing was hidden since the last screenshot.
 */
async function buildHiddenNote(
  adapter: ComputerUseHostAdapter,
  hiddenSinceLastSeen: string[],
): Promise<string | undefined> {
  if (hiddenSinceLastSeen.length === 0) return undefined;
  const running = await adapter.executor.listRunningApps();
  const nameOf = new Map(running.map((a) => [a.appIdentifier, a.displayName]));
  const names = hiddenSinceLastSeen.map((id) => nameOf.get(id) ?? id);
  const list = names.map((n) => `"${n}"`).join(", ");
  const one = names.length === 1;
  return (
    `${list} ${one ? "was" : "were"} open and got hidden before this screenshot ` +
    `(not in the session allowlist). If a previous action was meant to open ` +
    `${one ? "it" : "one of them"}, that's why you don't see it — call ` +
    `request_access to add ${one ? "it" : "them"} to the allowlist.`
  );
}

/**
 * Assign a human-readable label to each display. Falls back to `display N`
 * when NSScreen.localizedName is undefined; disambiguates identical labels
 * (matched-pair external monitors) with a `(2)` suffix. Used by both
 * buildMonitorNote and handleSwitchDisplay so the name the model sees in a
 * screenshot note is the same name it can pass back to switch_display.
 */
function uniqueDisplayLabels(
  displays: readonly DisplayGeometry[],
): Map<number, string> {
  // Sort by displayId so the (N) suffix is stable regardless of
  // NSScreen.screens iteration order — same label always maps to same
  // physical display across buildMonitorNote → switch_display round-trip,
  // even if display configuration reorders between the two calls.
  const sorted = [...displays].sort((a, b) => a.displayId - b.displayId);
  const counts = new Map<string, number>();
  const out = new Map<number, string>();
  for (const d of sorted) {
    const base = d.label ?? `display ${d.displayId}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    out.set(d.displayId, n === 1 ? base : `${base} (${n})`);
  }
  return out;
}

/**
 * Build the monitor-context text that accompanies a screenshot. Tells the
 * model which monitor it's looking at (by human name), lists other attached
 * monitors, and flags when the monitor changed vs. the previous screenshot.
 *
 * Only emitted when there are 2+ displays AND (first screenshot OR the
 * display changed). Single-monitor setups and steady-state same-monitor
 * screenshots get no text — avoids noise.
 */
async function buildMonitorNote(
  adapter: ComputerUseHostAdapter,
  shotDisplayId: number,
  lastDisplayId: number | undefined,
  canSwitchDisplay: boolean,
): Promise<string | undefined> {
  // listDisplays failure (e.g. Swift returns zero screens during monitor
  // hot-unplug) must not tank the screenshot — this note is optional context.
  let displays;
  try {
    displays = await adapter.executor.listDisplays();
  } catch (e) {
    adapter.logger.warn(`[computer-use] listDisplays failed: ${String(e)}`);
    return undefined;
  }
  if (displays.length < 2) return undefined;

  const labels = uniqueDisplayLabels(displays);
  const nameOf = (id: number): string => labels.get(id) ?? `display ${id}`;

  const current = `${nameOf(shotDisplayId)} (display_id=${shotDisplayId})`;
  const others = displays
    .filter((d) => d.displayId !== shotDisplayId)
    .map((d) => nameOf(d.displayId));
  const switchHint = canSwitchDisplay
    ? " Use switch_display to capture a different monitor."
    : "";
  const othersList =
    others.length > 0
      ? ` Other attached monitors: ${others.map((n) => `"${n}"`).join(", ")}.` +
        switchHint
      : "";

  // 0 is kCGNullDirectDisplay (sentinel from old sessions persisted
  // pre-multimon) — treat same as undefined.
  if (lastDisplayId === undefined || lastDisplayId === 0) {
    return `This screenshot was taken on monitor "${current}".` + othersList;
  }
  if (lastDisplayId !== shotDisplayId) {
    const prev = nameOf(lastDisplayId);
    return (
      `This screenshot was taken on monitor "${current}", which is different ` +
      `from your previous screenshot (taken on "${prev}").` +
      othersList
    );
  }
  return undefined;
}

/**
 * Empty-allowlist auto-trigger. When a screenshot is requested and the session
 * allowlist is empty, we surface a permission dialog (running apps list) instead
 * of returning a hard error — the LLM shouldn't have to pre-call request_access
 * with guessed bundle IDs to make a first screenshot work. On success, mutates
 * `overrides.allowedApps` in place so the same dispatch can fall through with
 * the new grants. Returns a CuCallToolResult only when the auto-trigger itself
 * resolved to an error (no permission handler, no running apps, user denied).
 */
async function autoTriggerEmptyAllowlistDialog(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  reason: string,
): Promise<CuCallToolResult | undefined> {
  // Auto-trigger fires only when CLI_CU_CAPABILITIES.screenshotFiltering ===
  // 'native' (caller-checked). That's mac-only — Win uses 'none' and never
  // reaches here. Narrow `overrides` for typesafe allowedApps mutation.
  if (overrides.platform !== "darwin") {
    return undefined;
  }
  if (!overrides.onPermissionRequest) {
    return errorResult(
      "No applications are granted for this session and the session has no permission handler. Computer control is unavailable here.",
      "feature_unavailable",
    );
  }

  const running = await adapter.executor.listRunningApps();
  const userDeniedSet = new Set(overrides.userDeniedAppIdentifiers);
  const apps: ResolvedAppRequest[] = [];
  for (const r of running) {
    if (userDeniedSet.has(r.appIdentifier)) continue;
    if (isPolicyDenied(r.appIdentifier, r.displayName)) continue;
    apps.push({
      requestedName: r.displayName,
      resolved: {
        appIdentifier: r.appIdentifier,
        displayName: r.displayName,
        path: "",
      },
      isSentinel: SENTINEL_APP_IDENTIFIERS.has(r.appIdentifier),
      alreadyGranted: false,
      proposedTier: getDefaultTierForApp(r.appIdentifier, r.displayName),
    });
  }

  if (apps.length === 0) {
    return errorResult(
      "No running applications are available to grant. Ask the user to open the apps you need to control, then retry.",
      "allowlist_empty",
    );
  }

  const req: CuPermissionRequest = {
    requestId: randomUUID(),
    reason,
    apps,
    requestedFlags: {},
    screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
  };
  const response = await overrides.onPermissionRequest(req);

  if (response.granted.length === 0) {
    return errorResult(
      "User dismissed the permission dialog without granting any application. Ask the user which apps you should be allowed to control, then retry.",
      "allowlist_empty",
    );
  }

  overrides.allowedApps.push(...response.granted);
  overrides.displayResolvedForApps = undefined;
  return undefined;
}

async function handleScreenshot(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
  args?: Record<string, unknown>,
): Promise<CuCallToolResult> {
  const allowedApps = allowedAppsOf(overrides);
  // SoM gate: when som:false, skip all UIA enumeration. This bypasses
  // runWinPreCaptureUIA (avoiding its z-order / foreground side effects
  // on Windows) and the Mac post-capture probe, plus the windows-context
  // listing. Also clears any prior mark_id store so mouse_move(mark_id)
  // errors out until the next SoM-producing call. Default true.
  const somDisabled = args?.som === false;
  if (somDisabled) overrides.onLocateMarksUpdated?.([]);
  adapter.logger.debug(
    `[computer-use] handleScreenshot enter: screenshotFiltering=${adapter.executor.capabilities.screenshotFiltering} allowedApps=${allowedApps.length} autoTargetDisplay=${subGates.autoTargetDisplay} hideBeforeAction=${subGates.hideBeforeAction} selectedDisplayId=${overrides.selectedDisplayId ?? "undef"}`,
  );
  // The allowlist gate only matters when the platform actually filters
  // screenshots by allowlist (compositor-level). On platforms where
  // `screenshotFiltering === 'none'` (the screen is captured as-is), the
  // gate is ceremony — TCC Screen Recording perms already gate
  // "permission to look at the screen", and screenshots are read-only.
  // Skip the auto-trigger entirely; capture full-screen.
  if (
    adapter.executor.capabilities.screenshotFiltering === "native" &&
    allowedApps.length === 0
  ) {
    const bypassed = isAllowlistBypassed();
    adapter.logger.debug(
      `[CU-GATE] handleScreenshot empty-allowlist + native-filter: ` +
        `bypass=${bypassed} → ${bypassed ? "SKIP autoTrigger, capture full-screen unfiltered" : "auto-trigger PermissionRequest dialog"}`,
    );
    if (!bypassed) {
      // Native compositor filtering: empty allowlist means no apps would be
      // visible. Auto-trigger the dialog so the user picks something to keep.
      const triggerError = await autoTriggerEmptyAllowlistDialog(
        adapter,
        overrides,
        "Take a screenshot of your screen.",
      );
      if (triggerError) return triggerError;
    }
    // bypass=true → falls through to the regular capture path which on
    // native-filter platforms would normally emit empty pixels; here it
    // captures unfiltered like a 'none' platform. Default-open mode
    // makes this the always-taken path now.
  }

  // Minimize axiomate's terminal window before capture so it doesn't
  // appear in the screenshot. Repairs must run in finally so a failed
  // capture doesn't leave axiomate minimized permanently.
  const initialFgToken = await captureWinForegroundRestoreToken(adapter);
  // Snapshot the full top-level window order (including axiomate's host
  // windows) BEFORE hideSelf. Anything the screenshot pipeline touches —
  // host hide/show, SoM probing of user apps — gets undone uniformly in
  // finally via showSelf (position) + restoreWinVisibleWindowOrder (z-order).
  const isWin = adapter.executor.capabilities.platform === "win32";
  const winBaseline: VisibleWindowSnapshot[] = isWin
    ? await listWinVisibleWindows(adapter)
    : [];
  const winTouched = new Set<string>();
  // Hide axiomate's host chain (parent terminal, VS Code if claude-code
  // launched axiomate from VS Code's integrated terminal, etc.) whenever
  // ANY host window is VISIBLE — not just when host is foreground. The
  // previous gate (`initialFgToken.isHost === true`) missed the case
  // where axiomate's actual host (e.g. VS Code) sits in the background
  // while some unrelated user app is foreground: host leaked into the
  // screenshot. Decoupling the two intents:
  //   - hide host (so it doesn't appear in pixels): any host visible
  //   - bring host back to foreground after: only if host WAS foreground
  // hideSelf's `restoreHwnd` parameter marks a specific host hwnd as
  // was_foreground=true for showSelf's bring-back step; passing undefined
  // means showSelf just restores positions without re-foregrounding.
  const anyHostVisible = isWin && winBaseline.some(w => w.isHost === true);
  const hostWasForeground = isWin && initialFgToken?.isHost === true;
  if (anyHostVisible) {
    await adapter.executor.hideSelf?.(
      hostWasForeground ? initialFgToken?.hwnd : undefined,
    );
  }
  // Win-only pre-capture: do UIA + probe + z-order restore BEFORE the
  // screenshot so the captured pixels reflect the final settled state
  // (no focus-side-effect drift between mark coords and image). The
  // pre-capture also returns its display dims (`pre.dims`) so we can
  // detect geometry drift against the eventual screenshot's dims.
  //
  // Mac is unchanged: AX doesn't disturb foreground / z-order, so the
  // post-capture UIA path is fine and produces image-aligned marks.
  let winPrecapture: Awaited<ReturnType<typeof runWinPreCaptureUIA>> = null;
  let winRestoredEarly = false;
  try {
    if (isWin && !somDisabled) {
      winPrecapture = await runWinPreCaptureUIA(
        adapter,
        overrides.selectedDisplayId,
        winBaseline,
        winTouched,
      );
      if (winPrecapture) {
        winRestoredEarly = true;
      }
    }
    // Atomic resolve→prepare→capture (one Swift call, no scheduler gap).
    // Off → fall through to separate-calls path below.
    if (subGates.autoTargetDisplay) {
      // Model's explicit switch_display pin overrides everything — Swift's
      // straight cuDisplayInfo(forDisplayID:) passthrough, no chase chain.
      // Otherwise sticky display: only auto-resolve when the allowed-app
      // set has changed since the display was last resolved. Prevents the
      // resolver yanking the display on every screenshot.
      const allowedAppIdentifiers = allowedApps.map((a) => a.appIdentifier);
      const currentAppSetKey = allowedAppIdentifiers.slice().sort().join(",");
      const appSetChanged = currentAppSetKey !== overrides.displayResolvedForApps;
      const autoResolve = !overrides.displayPinnedByModel && appSetChanged;
  
      adapter.logger.debug(
        `[computer-use] handleScreenshot atomic: calling resolvePrepareCapture allowedAppIdentifiers=[${allowedAppIdentifiers.join(",")}] preferredDisplayId=${overrides.selectedDisplayId ?? "undef"} autoResolve=${autoResolve} doHide=${subGates.hideBeforeAction}`,
      );
  
      const coordinateGrid = typeof args?.coordinate_grid === "string" ? args.coordinate_grid : "none";
      // Win pre-capture marks → native overlay via captureDisplayScaled.
      // Mac overlay is post-capture via applyMacMarkOverlay below.
      const preMarkOverlays = computePreCaptureOverlayMarks(
        isWin && winPrecapture ? winPrecapture.marks : [],
        winPrecapture?.dims.virtualW ?? 0,
        winPrecapture?.dims.virtualH ?? 0,
      );
      const result = await adapter.executor.resolvePrepareCapture({
        allowedAppIdentifiers,
        preferredDisplayId: overrides.selectedDisplayId,
        autoResolve,
        // Keep the hideBeforeAction sub-gate independently rollable —
        // atomic path honors the same toggle the non-atomic path checks
        // at the prepareForAction call site.
        doHide: subGates.hideBeforeAction,
        coordinateGrid,
        marks: preMarkOverlays,
      });
  
      adapter.logger.debug(
        `[computer-use] handleScreenshot atomic: resolvePrepareCapture returned base64Len=${result.base64?.length ?? "undef"} width=${result.width} height=${result.height} displayId=${result.displayId} hiddenCount=${result.hidden?.length ?? 0} captureError=${result.captureError ?? "none"}`,
      );
  
      // Non-atomic path's takeScreenshotWithRetry has a MIN_SCREENSHOT_BYTES
      // check + retry. The atomic call is expensive (resolve+prepare+capture),
      // so no retry here — just a warning when the result is implausibly
      // small (transient display state like sleep wake). Skip when
      // captureError is set (base64 is intentionally empty then).
      if (
        result.captureError === undefined &&
        decodedByteLength(result.base64) < MIN_SCREENSHOT_BYTES
      ) {
        adapter.logger.warn(
          `[computer-use] resolvePrepareCapture result implausibly small (${decodedByteLength(result.base64)} bytes decoded) — possible transient display state`,
        );
      }
  
      // Resolver picked a different display than the session had selected
      // (host window moved, or allowed app on a different display). Write
      // the pick back to session so teach overlay positioning and subsequent
      // non-resolver calls track the same display. Fire-and-forget.
      if (result.displayId !== overrides.selectedDisplayId) {
        adapter.logger.debug(
          `[computer-use] resolver: preferred=${overrides.selectedDisplayId} resolved=${result.displayId}`,
        );
        overrides.onResolvedDisplayUpdated?.(result.displayId);
      }
      // Record the app set this display was resolved for, so the next
      // screenshot skips auto-resolve until the set changes again. Gated on
      // autoResolve (not just appSetChanged) — when pinned, we didn't
      // actually resolve, so don't update the key.
      if (autoResolve) {
        overrides.onDisplayResolvedForApps?.(currentAppSetKey);
      }
  
      // Report hidden apps only when the model has already seen the screen.
      // `result.hidden` is mac-only (Win returns undefined since the hide
      // loop is mac-only, see executor.ts ResolvePrepareCaptureResult).
      const resultHidden = result.hidden ?? [];
      const hiddenSinceLastSeen = resultHidden;
      if (resultHidden.length > 0) {
        overrides.onAppsHidden?.(resultHidden);
      }
  
      // Partial-success case: hide succeeded, capture failed (SCK perm
      // revoked mid-session). onAppsHidden fired above so auto-unhide will
      // restore hidden apps at turn end. Now surface the error to the model.
      if (result.captureError !== undefined) {
        return errorResult(result.captureError, "capture_failed");
      }
  
      const hiddenNote = await buildHiddenNote(adapter, hiddenSinceLastSeen);
  
      // Cherry-pick — don't spread `result` (would leak resolver fields into lastScreenshot).
      const shot: ScreenshotResult = {
        base64: result.base64,
        width: result.width,
        height: result.height,
        displayWidth: result.displayWidth,
        displayHeight: result.displayHeight,
        displayId: result.displayId,
        originX: result.originX,
        originY: result.originY,
      };
      adapter.logger.debug(
        `[CU-COORD] handleScreenshot atomic stash: image=${shot.width}x${shot.height} (px) ` +
          `display=${shot.displayWidth}x${shot.displayHeight} (physical) ` +
          `origin=(${shot.originX},${shot.originY}) displayId=${shot.displayId} ` +
          `(these are the dims AI's clicks will be scaled against)`,
      );
  
      const monitorNote = await buildMonitorNote(
        adapter,
        shot.displayId,
        overrides.selectedDisplayId,
        overrides.onDisplayPinned !== undefined,
      );
      let somText = "";
      const visionEnabled = supportsVisionForFeedback(adapter);
      let marks: Mark[] = [];
      let detectionStats: any = {};
      if (somDisabled) {
        // som:false — skip post-capture UIA entirely. marks stays empty,
        // no windows context is built, no text SoM block is rendered.
      } else if (isWin) {
        // Win: marks were produced by the pre-capture UIA pass before
        // the screenshot. Validate that display geometry didn't drift
        // — if it did, the mark coords reference stale dims and would
        // be visibly off relative to the captured image, so drop them.
        if (winPrecapture) {
          if (winPreCaptureDimsStable(winPrecapture.dims, shot)) {
            marks = winPrecapture.marks;
            detectionStats = winPrecapture.somStats;
          } else {
            adapter.logger.warn(
              `[computer-use] display geometry drifted during screenshot pipeline; pre=${winPrecapture.dims.width}x${winPrecapture.dims.height}@(${winPrecapture.dims.originX},${winPrecapture.dims.originY})/disp${winPrecapture.dims.displayId} shot=${shot.displayWidth}x${shot.displayHeight}@(${shot.originX ?? 0},${shot.originY ?? 0})/disp${shot.displayId} — discarding SoM marks (image still valid)`,
            );
          }
        }
      } else if (adapter.executor.enumerateVisibleElements) {
        // Mac: post-capture UIA. AX has no foreground requirement so
        // there's no probing / z-order disturbance to defend against —
        // probe enrichment is still useful for additional non-frontmost
        // app windows, just doesn't need the focus / restore dance.
        try {
          const ratioX = shot.displayWidth ? shot.displayWidth / shot.width : 1;
          const ratioY = shot.displayHeight ? shot.displayHeight / shot.height : 1;
          const originX = shot.originX ?? 0;
          const originY = shot.originY ?? 0;
          const detection = await detectElementsMultiSourceDetailed(
            adapter.executor,
            { x: 0, y: 0, w: shot.width, h: shot.height },
            { ratioX, ratioY, originX, originY },
            ["uia"],
          );
          marks = detection.marks;
          detectionStats = detection.stats;
          // Probe enrichment for non-frontmost normal-layer windows that
          // didn't make it into the multi-root pass. Mirrors what
          // collectWinContextAwareMarks does for Win, minus the
          // foreground-dance overhead.
          const targetPhysicalRect = {
            x: originX,
            y: originY,
            w: Math.round(shot.width * ratioX),
            h: Math.round(shot.height * ratioY),
          };
          marks = await collectMacContextAwareMarks(
            adapter,
            marks,
            targetPhysicalRect,
            ratioX,
            ratioY,
            originX,
            originY,
          );
        } catch {
          // best-effort
        }
      }
      if (marks.length > 0) {
        // Discard marks whose center falls outside the captured image —
        // cross-display windows can produce UIA elements on adjacent
        // monitors that survive filterMarksByVisibleRegions but aren't
        // visible in this screenshot.
        marks = marks.filter(m => m.x >= 0 && m.x < shot.width && m.y >= 0 && m.y < shot.height);
        const shownCount = Math.min(
          marks.length,
          50,
        );
        const wRatioX = shot.displayWidth ? shot.displayWidth / shot.width : 1;
        const wRatioY = shot.displayHeight ? shot.displayHeight / shot.height : 1;
        const wOriginX = shot.originX ?? 0;
        const wOriginY = shot.originY ?? 0;
        // Clip per-window rects to the captured display's virtual extent
        // so windows that extend onto the OTHER monitor in a multi-display
        // setup don't surface negative-coord rects that aren't actually
        // visible in this screenshot.
        const shotScope = { x: 0, y: 0, w: shot.width, h: shot.height };
        let windowsContext: VisibleWindowContext[] | undefined;
        let attributedMarks: Mark[] = marks;
        if (isWin) {
          const built = buildWinVisibleWindowsContext(
            winBaseline, marks, wRatioX, wRatioY, wOriginX, wOriginY, shotScope,
          );
          windowsContext = built.contexts;
          attributedMarks = built.attributed;
        } else if (adapter.executor.capabilities.platform === "darwin") {
          try {
            const macBaseline = await listMacVisibleWindows(adapter);
            const built = buildMacVisibleWindowsContext(
              macBaseline, marks, wRatioX, wRatioY, wOriginX, wOriginY, shotScope,
            );
            windowsContext = built.contexts;
            attributedMarks = built.attributed;
          } catch {
            // best-effort: omit windows section if baseline fetch fails
          }
        }
        // Mac post-capture mark overlay (Win drew marks at capture time).
        if (!isWin && shownCount > 0) {
          await applyMacMarkOverlay(adapter.executor, shot, attributedMarks, shownCount, adapter.logger);
        }
        somText = buildTextFirstSoMBlock(
          attributedMarks,
          shownCount,
          { x: 0, y: 0, w: shot.width, h: shot.height },
          {
            includePriorityHint: !visionEnabled,
            stats: { ...detectionStats, returnedCount: attributedMarks.length },
            windows: windowsContext,
          },
        );
        // Publish marks for mark_id resolution by subsequent mouse_move
        // calls. Without this the IDs the model sees in the text SoM list
        // would only be resolvable after a follow-up zoom. Pass
        // attributedMarks (post-window-attribution) so mouse_move's debug
        // log shows the source window for each jump.
        overrides.onLocateMarksUpdated?.(attributedMarks.slice(0, shownCount));
      }
      return {
        content: [
          ...(monitorNote ? [{ type: "text" as const, text: monitorNote }] : []),
          ...(hiddenNote ? [{ type: "text" as const, text: hiddenNote }] : []),
          {
            type: "image",
            data: shot.base64,
            mimeType: "image/jpeg",
          },
          ...(somText
            ? [{ type: "text" as const, text: somText + buildToolModeHint(adapter, "screenshot") }]
            : buildToolModeHint(adapter, "screenshot")
              ? [{ type: "text" as const, text: buildToolModeHint(adapter, "screenshot") }]
              : []),
        ],
        screenshot: shot,
      };
    }
  
    // Same hide+defocus sequence as input actions. Screenshot needs hide too
    // — if a non-allowlisted app is on top, SCContentFilter would composite it
    // out, but the pixels BELOW it are what the model would see, and those are
    // NOT what's actually there. Hiding first makes the screenshot TRUE.
    let hiddenSinceLastSeen: string[] = [];
    if (subGates.hideBeforeAction) {
      const hidden = (await adapter.executor.prepareForAction?.(
        allowedApps.map((a) => a.appIdentifier),
        overrides.selectedDisplayId,
      )) ?? [];
      // "Something appeared since the model last looked." Report whenever:
      //   (a) prepare hid something AND
      //   (b) the model has ALREADY SEEN the screen (lastScreenshot is set).
      //
      // (b) is the discriminator that silences the first screenshot's
      // expected-noise hide. NOT a delta against a cumulative set — that was
      // the earlier bug: cuHiddenDuringTurn only grows, so once Preview is in
      // it (from the first screenshot's hide), subsequent re-hides of Preview
      // delta to zero. The double-click → Preview opens → re-hide → silent
      // loop never breaks.
      //
      // With this check: every re-hide fires. If the model loops "click → file
      // opens in Preview → screenshot → Preview hidden", it gets told EVERY
      // time. Eventually it'll request_access for Preview (or give up).
      //
      // False positive: user alt-tabs mid-turn → Safari re-hidden → reported.
      // Rare, and "Safari appeared" is at worst mild noise — far better than
      // the false-negative of never explaining why the file vanished.
      hiddenSinceLastSeen = hidden;
      if (hidden.length > 0) {
        overrides.onAppsHidden?.(hidden);
      }
    }
  
    const allowedAppIdentifiers = allowedApps.map((g) => g.appIdentifier);
    adapter.logger.debug(
      `[computer-use] handleScreenshot non-atomic: calling takeScreenshotWithRetry allowedAppIdentifiers=[${allowedAppIdentifiers.join(",")}] selectedDisplayId=${overrides.selectedDisplayId ?? "undef"}`,
    );
    const coordinateGrid = typeof args?.coordinate_grid === "string" ? args.coordinate_grid : "none";
    // Win pre-capture marks → native overlay. Mac is post-capture.
    const naPreMarkOverlays = computePreCaptureOverlayMarks(
      isWin && winPrecapture ? winPrecapture.marks : [],
      winPrecapture?.dims.virtualW ?? 0,
      winPrecapture?.dims.virtualH ?? 0,
    );
    const shot = await takeScreenshotWithRetry(
      adapter.executor,
      allowedAppIdentifiers,
      adapter.logger,
      overrides.selectedDisplayId,
      coordinateGrid,
      naPreMarkOverlays,
    );
    adapter.logger.debug(
      `[computer-use] handleScreenshot non-atomic: takeScreenshotWithRetry returned base64Len=${shot.base64?.length ?? "undef"} width=${shot.width} height=${shot.height} displayId=${shot.displayId}`,
    );
    adapter.logger.debug(
      `[CU-COORD] handleScreenshot non-atomic stash: image=${shot.width}x${shot.height} (px) ` +
        `display=${shot.displayWidth}x${shot.displayHeight} (physical) ` +
        `origin=(${shot.originX},${shot.originY}) displayId=${shot.displayId} ` +
        `(these are the dims AI's clicks will be scaled against)`,
    );
  
    const hiddenNote = await buildHiddenNote(adapter, hiddenSinceLastSeen);
  
    const monitorNote = await buildMonitorNote(
      adapter,
      shot.displayId,
      overrides.selectedDisplayId,
      overrides.onDisplayPinned !== undefined,
    );
    let somText = "";
    const visionEnabled = supportsVisionForFeedback(adapter);
    let marks: Mark[] = [];
    let detectionStats: any = {};
    if (somDisabled) {
      // som:false — skip post-capture UIA entirely. See atomic-path
      // comment.
    } else if (isWin) {
      // Win: see atomic-path comment. Pre-capture pass produced marks
      // earlier; validate display dims still match the screenshot.
      if (winPrecapture) {
        if (winPreCaptureDimsStable(winPrecapture.dims, shot)) {
          marks = winPrecapture.marks;
          detectionStats = winPrecapture.somStats;
        } else {
          adapter.logger.warn(
            `[computer-use] display geometry drifted during screenshot pipeline; pre=${winPrecapture.dims.width}x${winPrecapture.dims.height}@(${winPrecapture.dims.originX},${winPrecapture.dims.originY})/disp${winPrecapture.dims.displayId} shot=${shot.displayWidth}x${shot.displayHeight}@(${shot.originX ?? 0},${shot.originY ?? 0})/disp${shot.displayId} — discarding SoM marks (image still valid)`,
          );
        }
      }
    } else if (adapter.executor.enumerateVisibleElements) {
      try {
        const ratioX = shot.displayWidth ? shot.displayWidth / shot.width : 1;
        const ratioY = shot.displayHeight ? shot.displayHeight / shot.height : 1;
        const originX = shot.originX ?? 0;
        const originY = shot.originY ?? 0;
        const detection = await detectElementsMultiSourceDetailed(
          adapter.executor,
          { x: 0, y: 0, w: shot.width, h: shot.height },
          { ratioX, ratioY, originX, originY },
          ["uia"],
        );
        marks = detection.marks;
        detectionStats = detection.stats;
        // Mac probe enrichment — mirrors the atomic-path branch above.
        const targetPhysicalRect = {
          x: originX,
          y: originY,
          w: Math.round(shot.width * ratioX),
          h: Math.round(shot.height * ratioY),
        };
        marks = await collectMacContextAwareMarks(
          adapter,
          marks,
          targetPhysicalRect,
          ratioX,
          ratioY,
          originX,
          originY,
        );
      } catch {
        // best-effort
      }
    }
    if (marks.length > 0) {
      marks = marks.filter(m => m.x >= 0 && m.x < shot.width && m.y >= 0 && m.y < shot.height);
      const shownCount = Math.min(
        marks.length,
        50,
      );
      const wRatioX = shot.displayWidth ? shot.displayWidth / shot.width : 1;
      const wRatioY = shot.displayHeight ? shot.displayHeight / shot.height : 1;
      const wOriginX = shot.originX ?? 0;
      const wOriginY = shot.originY ?? 0;
      const shotScope = { x: 0, y: 0, w: shot.width, h: shot.height };
      let windowsContext: VisibleWindowContext[] | undefined;
      let attributedMarks: Mark[] = marks;
      if (isWin) {
        const built = buildWinVisibleWindowsContext(
          winBaseline, marks, wRatioX, wRatioY, wOriginX, wOriginY, shotScope,
        );
        windowsContext = built.contexts;
        attributedMarks = built.attributed;
      } else if (adapter.executor.capabilities.platform === "darwin") {
        try {
          const macBaseline = await listMacVisibleWindows(adapter);
          const built = buildMacVisibleWindowsContext(
            macBaseline, marks, wRatioX, wRatioY, wOriginX, wOriginY, shotScope,
          );
          windowsContext = built.contexts;
          attributedMarks = built.attributed;
        } catch {
          // best-effort
        }
      }
      // Mac post-capture mark overlay (Win drew marks at capture time).
      if (!isWin && shownCount > 0) {
        await applyMacMarkOverlay(adapter.executor, shot, attributedMarks, shownCount, adapter.logger);
      }
      somText = buildTextFirstSoMBlock(
        attributedMarks,
        shownCount,
        shotScope,
        {
          includePriorityHint: !visionEnabled,
          stats: { ...detectionStats, returnedCount: attributedMarks.length },
          windows: windowsContext,
        },
      );
      // See atomic-path comment: publish marks so mouse_move can resolve
      // mark_id against this screenshot's IDs.
      overrides.onLocateMarksUpdated?.(attributedMarks.slice(0, shownCount));
    }
    return {
      content: [
        ...(monitorNote ? [{ type: "text" as const, text: monitorNote }] : []),
        ...(hiddenNote ? [{ type: "text" as const, text: hiddenNote }] : []),
        {
          type: "image",
          data: shot.base64,
          mimeType: "image/jpeg",
        },
        ...(somText
          ? [{ type: "text" as const, text: somText + buildToolModeHint(adapter, "screenshot") }]
          : buildToolModeHint(adapter, "screenshot")
            ? [{ type: "text" as const, text: buildToolModeHint(adapter, "screenshot") }]
            : []),
      ],
      // Piggybacked for serverDef.ts to stash on InternalServerContext.
      screenshot: shot,
    };
  } finally {
    // showSelf first: moves axiomate's host windows back on-screen.
    // showSelf internally checks the was_foreground flag set by hideSelf
    // and only re-foregrounds when host originally was foreground —
    // calling it when host was just background is safe (just restores
    // position).
    if (anyHostVisible) {
      await adapter.executor.showSelf?.();
    }
    // Restore z-order only when the pre-capture pass didn't already
    // run it (e.g. when getDisplaySize threw, leaving winPrecapture
    // null but probing may still have happened). Safety net.
    if (!winRestoredEarly && isWin && winTouched.size > 0 && winBaseline.length > 0) {
      await restoreWinVisibleWindowOrder(adapter, winBaseline, [...winTouched]);
    }
  }
}

/**
 * Per-app window capture via the platform's window-id-aware screenshot API
 * (macOS: `screencapture -l <CGWindowID>`; other platforms currently null).
 * Returns ONLY the target window's pixels — no other app is hidden as a
 * side effect (cleaner UX than full-screen + prepareForAction hide).
 *
 * Same coord-invariant guard as handleZoom: return has NO `.screenshot`
 * field, so subsequent click coords still refer to the last full-screen
 * screenshot. This is for inspection.
 */
async function handleScreenshotWindow(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const appIdentifier = requireString(args, "app_identifier");
  if (appIdentifier instanceof Error)
    return errorResult(appIdentifier.message, "bad_args");

  const gridMode = ((args.coordinate_grid as string) ?? "none") === "none"
    ? 0
    : (args.coordinate_grid as string) === "edge" ? 1 : 2;
  const restoreToken = await captureWinForegroundRestoreToken(adapter);
  // Match the screenshot/zoom paths' gate: hide whenever ANY host is
  // visible (host leak prevention), not just when host was foreground.
  // For screenshot_window specifically, capture is via PrintWindow on
  // the target HWND's offscreen buffer so host pixels can't appear in
  // the image regardless — but the hide is still useful as a defensive
  // measure for the UIA step (a host window on the same display can't
  // confuse a single-root enumeration but it's a free hedge).
  const isWin = adapter.executor.capabilities.platform === "win32";
  const winBaseline: VisibleWindowSnapshot[] = isWin
    ? await listWinVisibleWindows(adapter)
    : [];
  const anyHostVisible = isWin && winBaseline.some(w => w.isHost === true);
  const hostWasForeground = isWin && restoreToken?.isHost === true;

  // ── SoM (Set-of-Mark) enrichment ──
  // First capture without marks to get the window's screen rect from the
  // result, then run UIA detection on that rect, then re-capture with
  // marks if the density gate passes. The window rect (originX/Y,
  // displayWidth/Height) is only known after capture.
  //
  // PrintWindow captures the target HWND directly (no hideSelf needed
  // for the capture itself). The UIA enumeration below uses the
  // app-specific single-root path (`enumerate_ui_elements_for_app_in_rect_detailed`)
  // which only walks the matched HWND's tree, so host windows can't
  // contribute marks regardless. hideSelf is kept as a defensive hedge:
  // if axiomate's host happens to overlap the target window's rect on
  // screen, hiding it keeps GetForegroundWindow-based scoring inside
  // the UIA walk consistent (target stays the "foreground" the scorer
  // sees).
  const prelim = await adapter.executor.screenshotWindow(appIdentifier, gridMode);
  if (!prelim) {
    let runningHint = "";
    try {
      const running = await adapter.executor.listRunningApps();
      if (running.length > 0) {
        runningHint =
          ` Currently running apps with visible windows: ${running
            .map((a) => `"${a.appIdentifier}"`)
            .join(", ")}.`;
      }
    } catch {
      // best-effort
    }
    return errorResult(
      `Could not capture a window for "${appIdentifier}". The app may not be running, may not have an on-screen window at the normal layer, or the app identifier may not match a running app.${runningHint} Pick the correct app identifier from the list above, or call \`screenshot\` (full-screen) to see what's currently open.`,
      "capture_failed",
    );
  }
  // Implausibly-small payload check. PrintWindow can succeed (return TRUE)
  // and still produce all-black pixels for apps that render via
  // hardware acceleration / DirectComposition (some games, video players,
  // certain WebView2 hosts). JPEG compresses solid colors aggressively
  // so a near-empty capture decodes to a tiny base64. We warn but don't
  // retry — capture_window already has an internal PrintWindow→BitBlt
  // fallback, and a second attempt against the same app would
  // typically hit the same wall.
  if (decodedByteLength(prelim.base64) < MIN_SCREENSHOT_BYTES) {
    adapter.logger.warn(
      `[computer-use] screenshotWindow result implausibly small (${decodedByteLength(prelim.base64)} bytes decoded) for app '${appIdentifier}' — likely hardware-accelerated rendering that PrintWindow can't access; image may be blank/black`,
    );
  }

  // Run UIA detection on the window's screen rect.
  const somEnabled = args.som !== false;
  let marks: Mark[] = [];
  const ratioX = prelim.displayWidth ? prelim.displayWidth / prelim.width : 1;
  const ratioY = prelim.displayHeight ? prelim.displayHeight / prelim.height : 1;
  const visionEnabled = supportsVisionForFeedback(adapter);
  let drawMarks = false;
  let circleLimit = 0;
  if (somEnabled) {
    if (anyHostVisible) {
      await adapter.executor.hideSelf?.(
        hostWasForeground ? restoreToken?.hwnd : undefined,
      );
    }
    try {
      const ox = prelim.originX ?? 0;
      const oy = prelim.originY ?? 0;
      if (adapter.executor.enumerateVisibleElementsForAppDetailed) {
        const detailed = await adapter.executor.enumerateVisibleElementsForAppDetailed(
          appIdentifier,
          {
            x: ox,
            y: oy,
            w: prelim.displayWidth ?? Math.round(prelim.width * ratioX),
            h: prelim.displayHeight ?? Math.round(prelim.height * ratioY),
          },
        );
        marks = detailed.elements.map((el, i) => {
          const vx = (el.bbox.x - ox) / ratioX;
          const vy = (el.bbox.y - oy) / ratioY;
          const vw = el.bbox.w / ratioX;
          const vh = el.bbox.h / ratioY;
          return {
            id: i + 1,
            x: Math.round(vx + vw / 2),
            y: Math.round(vy + vh / 2),
            name: el.name ?? "",
            role: el.role ?? "",
            automationId: el.automationId,
            source: "uia" as const,
            confidence: 1.0,
            uiaSource: el.uiaSource ?? "foreground",
          };
        });
        (marks as any).__somStats = {
          traversedCount: detailed.traversedCount,
          matchedCount: detailed.matchedCount,
          returnedCount: detailed.returnedCount,
          truncated: detailed.truncated,
          truncationReason: detailed.truncationReason,
        };
      } else {
        const detection = await detectElementsMultiSourceDetailed(
          adapter.executor,
          { x: 0, y: 0, w: prelim.width, h: prelim.height },
          { ratioX, ratioY, originX: ox, originY: oy, windowOnly: true },
          ["uia"],
        );
        marks = detection.marks;
        (marks as any).__somStats = detection.stats;
      }
      circleLimit = marks.length > 0 ? 1 : 0;
      // Actual circle cap + spatial sampling happen after we know the
      // final prelim image dims and the shown-mark slice — see below.
      drawMarks = circleLimit > 0;
    } catch {
      // UIA detection failed — proceed without marks.
    } finally {
      // Defer restore until after any mark-overlay recapture, otherwise the
      // final screenshotWindow(markOverlays) call would foreground the target
      // again and undo the restore.
    }
  }

  // Re-capture with marks if needed, or use prelim capture as-is.
  let result: typeof prelim;
  let somText = "";

  // Discard marks outside the captured image (cross-display window edges).
  marks = marks.filter(m => m.x >= 0 && m.x < prelim.width && m.y >= 0 && m.y < prelim.height);

  const shownCount = Math.min(
    marks.length,
    50,
  );
  const shownMarks = marks.slice(0, shownCount);
  if (shownMarks.length > 0) {
      somText = buildTextFirstSoMBlock(
        marks,
        shownCount,
        { x: 0, y: 0, w: prelim.width, h: prelim.height },
        { includePriorityHint: !visionEnabled, stats: (marks as any).__somStats },
      );
      // Publish marks for mark_id resolution by subsequent mouse_move
      // calls — see handleScreenshot atomic-path comment for rationale.
      overrides.onLocateMarksUpdated?.(shownMarks);
    }

  if (drawMarks && shownMarks.length > 0) {
    // Dynamic cap + spatial sampling on the shown-mark slice so circles
    // cover the window image evenly instead of clustering on whatever
    // UIA enumerated first. Small windows → few circles, big windows
    // → many. Cap bounded [5..50] for readability.
    const dynCap = computeDynamicOverlayCap(prelim.width, prelim.height);
    const sampled = selectSpatiallyDistributedMarks(shownMarks, Math.min(shownMarks.length, dynCap));
    // Marks are in image-pixel coords after detectElementsInRect divides
    // by ratioX/Y. Convert back to physical window-local px for Rust
    // draw_marks_on_rgb which expects physical coordinates.
    const isMac = adapter.executor.capabilities.platform === "darwin";
    const markOverlays = sampled.map((m) => ({
      id: m.id,
      x: isMac
        ? Math.round(m.x * ratioX + (prelim.originX ?? 0))
        : Math.round(m.x * ratioX),
      y: isMac
        ? Math.round(m.y * ratioY + (prelim.originY ?? 0))
        : Math.round(m.y * ratioY),
    }));
    result = await adapter.executor.screenshotWindow(appIdentifier, gridMode, markOverlays);
    if (!result) {
      // Fallback to prelim capture if re-capture failed.
      result = prelim;
    }
  } else {
    result = prelim;
  }
  
  try {
    return {
      content: [
        {
          type: "image",
          data: result.base64,
          mimeType: "image/jpeg",
        },
        {
          type: "text",
          text: somText + buildToolModeHint(adapter, "screenshot_window"),
        },
      ],
      screenshot: result,
      };
  } finally {
    if (somEnabled && anyHostVisible) {
      adapter.logger.debug?.(`[computer-use] screenshot_window restore: showSelf (hostWasForeground=${hostWasForeground})`);
      await adapter.executor.showSelf?.();
    }
  }
}

/**
 * Region-crop upscaled screenshot. Coord invariant (computer_use_v2.py:1092):
 * click coords ALWAYS refer to the full-screen screenshot, never the zoom.
 * Enforced structurally: this handler's return has NO `.screenshot` field,
 * so serverDef.ts's `if (result.screenshot)` branch cannot fire and
 * `cuLastScreenshot` is never touched. `executor.zoom()`'s return type also
 * lacks displayWidth/displayHeight, so it's not assignable to
 * `ScreenshotResult` even by accident.
 */
async function handleZoom(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  // ── Parse parameters: center+size is primary; region is legacy fallback ──
  const hasRegion = Array.isArray(args.region) && args.region.length === 4;
  const hasCenter = Array.isArray(args.center) && args.center.length === 2;
  const hasSize = typeof args.size === "number";

  if (!hasRegion && !(hasCenter && hasSize)) {
    return errorResult(
      "Provide 'center: [cx, cy]' + 'size: N', or legacy 'region: [x0, y0, x1, y1]'",
      "bad_args",
    );
  }
  if (hasRegion && (hasCenter || hasSize)) {
    return errorResult(
      "Cannot specify both 'region' and 'center'/'size'",
      "bad_args",
    );
  }

  let x0: number, y0: number, x1: number, y1: number;
  let wasClipped = false;
  let probeX: number, probeY: number;

  if (hasCenter && hasSize) {
    // ── Primary path: center + size → square ──
    const [cx, cy] = args.center as number[];
    const size = args.size as number;

    if (![cx, cy].every((v) => typeof v === "number" && v >= 0)) {
      return errorResult(
        "center coordinates must be non-negative numbers",
        "bad_args",
      );
    }
    if (typeof size !== "number" || size < 10) {
      return errorResult("size must be a number >= 10", "bad_args");
    }

    // Convert center+size to rect (ideal square, before clipping)
    const halfSize = size / 2;
    probeX = cx;
    probeY = cy;
    x0 = Math.round(cx - halfSize);
    y0 = Math.round(cy - halfSize);
    x1 = Math.round(cx + halfSize);
    y1 = Math.round(cy + halfSize);
  } else {
    // ── Legacy path: region = [x0, y0, x1, y1] ──
    [x0, y0, x1, y1] = args.region as number[];
    if (![x0, y0, x1, y1].every((v) => typeof v === "number" && v >= 0)) {
      return errorResult(
        "region values must be non-negative numbers",
        "bad_args",
      );
    }
    if (x1 <= x0)
      return errorResult("region x1 must be greater than x0", "bad_args");
    if (y1 <= y0)
      return errorResult("region y1 must be greater than y0", "bad_args");
    probeX = Math.round((x0 + x1) / 2);
    probeY = Math.round((y0 + y1) / 2);
  }

  // ── Boundary clipping (applies to both paths) ──
  // Get display geometry to compute screen bounds (no stored screenshot needed).
  const display = await resolveDisplay(adapter, args, overrides);
  const [screenW, screenH] = computeImageDim(display.width, display.height);
  const zoomCtx = screenScaleCtx(display);
  adapter.logger.debug(
    `[zoom] display logical=${display.width}x${display.height} origin=(${display.originX ?? 0},${display.originY ?? 0}) ` +
      `virtual=${screenW}x${screenH} ratio=(${zoomCtx.ratioX},${zoomCtx.ratioY}) ` +
      `inputRect=[${x0},${y0}]-[${x1},${y1}]`,
  );

  // Track original coords to detect clipping
  const origX0 = x0, origY0 = y0, origX1 = x1, origY1 = y1;

  // Clamp to screen bounds [0, screenW] × [0, screenH]
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(screenW, x1);
  y1 = Math.min(screenH, y1);

  // Check if clipping occurred
  if (x0 !== origX0 || y0 !== origY0 || x1 !== origX1 || y1 !== origY1) {
    wasClipped = true;
  }

  // After clamping, ensure valid rect (can happen if center is off-screen)
  if (x1 <= x0 || y1 <= y0) {
    return errorResult(
      `Computed zoom region [${x0},${y0}]-[${x1},${y1}] is invalid (zero or negative size after boundary clipping). Choose a center and size that intersect the screen.`,
      "bad_args",
    );
  }

  // ── Execute zoom with clipped region ──
  const regionVirtual = {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
  };

  const allowedIds = allowedAppsOf(overrides).map((g) => g.appIdentifier);
  const coordinateGrid = (args.coordinate_grid as string) ?? "none";

  // ── SoM (Set-of-Mark) enrichment ──
  const somDisabled = args.som === false;
  const hadMarksBeforeClear = (overrides.getLastZoomMarks?.().length ?? 0) > 0;
  if (somDisabled) {
    overrides.onLocateMarksUpdated?.([]);
  }

  // Move axiomate off-screen before UIA detection AND zoom capture
  // so neither step sees our terminal window.
  const initialFgToken = await captureWinForegroundRestoreToken(adapter);
  // Snapshot the full top-level window order (including axiomate's host
  // windows) BEFORE hideSelf — same uniform restore as handleScreenshot.
  const isWin = adapter.executor.capabilities.platform === "win32";
  const winBaseline: VisibleWindowSnapshot[] = isWin
    ? await listWinVisibleWindows(adapter)
    : [];
  const winTouched = new Set<string>();
  let winRestoredEarly = false;
  // Same gate split as handleScreenshot: hide whenever any host is
  // visible (host leak prevention), bring host back to foreground only
  // if it was foreground originally.
  const anyHostVisible = isWin && winBaseline.some(w => w.isHost === true);
  const hostWasForeground = isWin && initialFgToken?.isHost === true;
  if (anyHostVisible) {
    await adapter.executor.hideSelf?.(
      hostWasForeground ? initialFgToken?.hwnd : undefined,
    );
  }
  try {
    let marks: Mark[] = [];
    const visionEnabled = supportsVisionForFeedback(adapter);
    let drawMarks = false;
    let circleLimit = 0;
    let probedWindowNames: Set<string> | undefined;
    if (!somDisabled) {
      const ratioX = zoomCtx.ratioX;
      const ratioY = zoomCtx.ratioY;
      const originX = zoomCtx.originX;
      const originY = zoomCtx.originY;
      const targetPhysicalRect = {
        x: Math.round(regionVirtual.x * ratioX + originX),
        y: Math.round(regionVirtual.y * ratioY + originY),
        w: Math.round(regionVirtual.w * ratioX),
        h: Math.round(regionVirtual.h * ratioY),
      };
      try {
        if (adapter.executor.capabilities.platform === "win32") {
          const baseline = await listWinVisibleWindows(adapter);
          // Read cursor for the candidate ranker — same "what the user
          // is pointing at" signal selectWinProbeCandidates uses for
          // full-screen probes. Failure is non-fatal: ranker falls back
          // to area + zRank.
          let cursor: { x: number; y: number } | null = null;
          try {
            cursor = await adapter.executor.getCursorPosition();
          } catch {
            cursor = null;
          }
          const built = buildWinZoomWindowCandidates(baseline, targetPhysicalRect);
          adapter.logger.debug?.(
            `[computer-use] zoom baseline windows=${baseline.map(w => `${w.displayName}@${w.zRank}${w.isForeground ? "[fg]" : ""}${w.isSystemChrome ? "[chrome]" : ""}`).join(", ")}`,
          );
          adapter.logger.debug?.(
            `[computer-use] zoom built candidates=${built.map(w => `${w.displayName}@${w.zRank} visArea=${w.visibleAreaInTarget} rawArea=${w.rawIntersectArea} rects=${w.visibleRects.length}`).join(", ")}`,
          );
          const candidates = selectZoomWindowCandidates(built, cursor);
          adapter.logger.debug?.(
            `[computer-use] zoom selected candidates=${candidates.map(w => `${w.displayName}@${w.zRank}`).join(", ")} cap=4 cursor=${cursor ? `(${cursor.x},${cursor.y})` : "null"}`,
          );
          const merged: Mark[] = [];
          let lastStats: any = undefined;
          for (const candidate of candidates) {
            const probeRect = [...candidate.visibleRects]
              .sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
            if (!probeRect) continue;
            if (adapter.executor.focusNonHostWindowAtPoint) {
              await adapter.executor.focusNonHostWindowAtPoint({
                x: probeRect.x + Math.round(probeRect.w / 2),
                y: probeRect.y + Math.round(probeRect.h / 2),
              });
              await sleep(150);
            }
            if (candidate.appIdentifier) winTouched.add(candidate.appIdentifier);
            const detailed = candidate.hwnd
              ? await enumerateWinWindowMarksDetailed(
                  adapter,
                  candidate.hwnd,
                  targetPhysicalRect,
                  ratioX,
                  ratioY,
                  originX,
                  originY,
                )
              : await enumerateWinAppMarksDetailed(
                  adapter,
                  candidate.appIdentifier,
                  targetPhysicalRect,
                  ratioX,
                  ratioY,
                  originX,
                  originY,
                );
            const visibleVirtualRects = candidate.visibleRects.map(rect =>
              physicalRectToVirtualRect(rect, ratioX, ratioY, originX, originY),
            );
            const kept = filterMarksByVisibleRegions(detailed.marks, visibleVirtualRects);
            // Pre-tag source window name so downstream attribution credits
            // each mark to the window that was actually UIA-probed, not
            // to whichever buried window overlaps via point-in-rect.
            // Mirrors the pre-tag collectWinContextAwareMarks does.
            for (const m of kept) m.sourceWindowName = candidate.displayName;
            merged.push(...kept);
            lastStats = detailed.stats;
          }
          marks = dedupeMarks(merged);
          (marks as any).__somStats = {
            ...(lastStats ?? {}),
            returnedCount: marks.length,
          };
          probedWindowNames = new Set(candidates.map(c => c.displayName));
        } else if (adapter.executor.capabilities.platform === "darwin") {
          const baseline = await listMacVisibleWindows(adapter);
          let macCursor: { x: number; y: number } | null = null;
          try {
            macCursor = await adapter.executor.getCursorPosition();
          } catch {
            macCursor = null;
          }
          const candidates = selectZoomWindowCandidates(
            buildMacZoomWindowCandidates(baseline, targetPhysicalRect),
            macCursor,
          );
          const merged: Mark[] = [];
          let lastStats: any = undefined;
          for (const candidate of candidates) {
            const detailed = await enumerateMacWindowMarksDetailed(
              adapter,
              candidate.windowId,
              candidate.appIdentifier,
              targetPhysicalRect,
              ratioX,
              ratioY,
              originX,
              originY,
            );
            const visibleVirtualRects = candidate.visibleRects.map(rect =>
              physicalRectToVirtualRect(rect, ratioX, ratioY, originX, originY),
            );
            const kept = filterMarksByVisibleRegions(detailed.marks, visibleVirtualRects);
            // Pre-tag — see Win zoom probe comment above.
            for (const m of kept) m.sourceWindowName = candidate.displayName;
            merged.push(...kept);
            lastStats = detailed.stats;
          }
          marks = dedupeMarks(merged);
          (marks as any).__somStats = {
            ...(lastStats ?? {}),
            returnedCount: marks.length,
          };
          probedWindowNames = new Set(candidates.map(c => c.displayName));
        } else {
          const detection = await detectElementsMultiSourceDetailed(
            adapter.executor,
            regionVirtual,
            { ratioX, ratioY, originX, originY },
            ["uia"],
          );
          marks = detection.marks;
          (marks as any).__somStats = detection.stats;
        }
        // Zoom only cares about the zoom region — discard any marks whose
        // center lies outside regionVirtual before downstream tile / text /
        // overlay processing. The per-candidate filter clips by window
        // visibleRects (which are NOT clipped to the zoom region) and the
        // native enumerator returns elements that *intersect* the region
        // bbox, so a mark center can still leak out. Final region filter
        // makes "Visible windows" counts, tile counts, and totalCount in
        // the SoM summary consistent with the user's mental model: only
        // what's actually in the zoomed view.
        const prevStats = (marks as any).__somStats ?? {};
        const preFilterCount = marks.length;
        const rxMax = regionVirtual.x + regionVirtual.w;
        const ryMax = regionVirtual.y + regionVirtual.h;
        const inRegionMarks = marks.filter(
          m =>
            m.x >= regionVirtual.x &&
            m.x < rxMax &&
            m.y >= regionVirtual.y &&
            m.y < ryMax,
        );
        // Re-number ids so they're contiguous 1..N in the new list — the
        // overlay slice and text listing both use this id sequence and
        // we want gap-free numbering after the filter drops out-of-region
        // marks.
        marks = inRegionMarks.map((m, i) => ({ ...m, id: i + 1 }));
        if (marks.length !== preFilterCount) {
          adapter.logger.debug?.(
            `[zoom-som] in-region filter: ${preFilterCount} → ${marks.length} marks (dropped ${preFilterCount - marks.length} outside zoom region)`,
          );
        }
        (marks as any).__somStats = { ...prevStats, returnedCount: marks.length };
        const fgCount = marks.filter(m => m.uiaSource === "foreground").length;
        const chromeCount = marks.filter(m => m.uiaSource !== "foreground").length;
        // Dynamic circle cap based on expected zoom image dims (≈
        // regionVirtual scaled by the display's virtual↔physical ratio).
        // Small zoom regions render at small image sizes → few circles;
        // large regions → many. Cap is bounded [5..50] so tight zooms
        // still get a handful and full-display-sized zooms don't drown.
        const estImgW = Math.round(regionVirtual.w * zoomCtx.ratioX);
        const estImgH = Math.round(regionVirtual.h * zoomCtx.ratioY);
        const dynCap = computeDynamicOverlayCap(estImgW, estImgH);
        // circleLimit ≤ text-list shownCount (computed below) — circles
        // are a subset of the text list. Use TEXT_SOM_CAP as the upper
        // bound here; the actual shownCount (VL=20, non-VL=50) further
        // constrains the spatial sampling at the draw site.
        circleLimit = Math.min(marks.length, dynCap, TEXT_SOM_CAP);
        // Draw circles regardless of vision support: non-VL models have
        // image content stripped before send, so there's no token cost,
        // and the dumped JPEG is the human debugger's only visual signal.
        drawMarks = circleLimit > 0;
        overrides.onLocateMarksUpdated?.(marks);
        adapter.logger.debug(
          `[zoom-som] stored ${marks.length} marks (fg=${fgCount} chrome=${chromeCount} circles: ${circleLimit}/${dynCap} est-img=${estImgW}x${estImgH}): ${marks.map((m) => `#${m.id}(${m.name})`.slice(0, 40)).join(", ")}`,
        );
      } catch (e) {
        adapter.logger.debug(
          `[zoom-som] detection failed: ${e instanceof Error ? e.message : String(e)} — falling back to ruler-only zoom`,
        );
      }
    }

    // Win: restore z-order BEFORE the zoom capture so the zoomed image
    // reflects the post-disturbance settled state — same rationale as
    // handleScreenshot's pre-capture pass. Then verify display geometry
    // didn't shift; if it did, drop the marks since their coords are
    // computed against the pre-shift ratios/origin.
    if (isWin && winTouched.size > 0 && winBaseline.length > 0) {
      try {
        await restoreWinVisibleWindowOrder(adapter, winBaseline, [...winTouched]);
      } catch (e) {
        adapter.logger.debug(
          `[zoom] win restore failed pre-capture: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      winRestoredEarly = true;
      // Settle DWM compose + per-app focus-out repaints.
      await sleep(80);

      // Layout re-check: detect window move/resize/close during the
      // probe loop. visibleRects we filtered marks against came from
      // `baseline` (taken at probe start) — if any tracked window
      // moved, mark coords are stale.
      //
      // Scope to the zoom region: a window moving in an unrelated
      // corner of the screen doesn't affect the zoom's marks (they
      // only cover this region). Pass `targetPhysicalRect` so
      // winLayoutRectStable only considers windows that overlap the
      // zoom area.
      if (marks.length > 0) {
        try {
          const winBaselineAfter = await listWinVisibleWindows(adapter);
          // Rebuild the zoom region's physical rect from the same
          // zoomCtx + regionVirtual the probe loop used. We can't
          // reuse the targetPhysicalRect variable since it lives
          // inside the `!somDisabled` block above.
          const zoomPhysicalRect = {
            x: Math.round(regionVirtual.x * zoomCtx.ratioX + zoomCtx.originX),
            y: Math.round(regionVirtual.y * zoomCtx.ratioY + zoomCtx.originY),
            w: Math.round(regionVirtual.w * zoomCtx.ratioX),
            h: Math.round(regionVirtual.h * zoomCtx.ratioY),
          };
          const layoutDelta = winLayoutRectStable(
            winBaseline,
            winBaselineAfter,
            zoomPhysicalRect,
          );
          if (layoutDelta) {
            adapter.logger.warn(
              `[computer-use] window layout drifted in zoom region: ${layoutDelta} — discarding SoM marks`,
            );
            marks = [];
            drawMarks = false;
            circleLimit = 0;
            overrides.onLocateMarksUpdated?.(marks);
          }
        } catch (e) {
          adapter.logger.debug(
            `[computer-use] zoom layout re-check failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      if (marks.length > 0) {
        try {
          const dimsAfter = await adapter.executor.getDisplaySize(display.displayId);
          const stable =
            dimsAfter.width === display.width &&
            dimsAfter.height === display.height &&
            (dimsAfter.originX ?? 0) === (display.originX ?? 0) &&
            (dimsAfter.originY ?? 0) === (display.originY ?? 0) &&
            dimsAfter.displayId === display.displayId;
          if (!stable) {
            adapter.logger.warn(
              `[computer-use] display geometry drifted during zoom pipeline; pre=${display.width}x${display.height}@(${display.originX ?? 0},${display.originY ?? 0})/disp${display.displayId} post=${dimsAfter.width}x${dimsAfter.height}@(${dimsAfter.originX ?? 0},${dimsAfter.originY ?? 0})/disp${dimsAfter.displayId} — discarding SoM marks`,
            );
            marks = [];
            drawMarks = false;
            circleLimit = 0;
            overrides.onLocateMarksUpdated?.(marks);
          }
        } catch {
          // best-effort: leave marks as-is if dim re-query fails
        }
      }
    }

    // Text-list cap computed early so the circle subset can be bounded
    // by it (circles ≤ text list). Same cap for VL and non-VL — VL
    // models still benefit from a complete text listing alongside the
    // image, and capping at 20 for VL was discriminating against
    // non-vision feedback when the dataset should be identical.
    const shownCount = Math.min(
      marks.length,
      50,
    );

    // For circles: pick a spatially-distributed subset of marks so
    // red dots cover the zoom image evenly. Circle count ≤ text-list
    // count (marks.length, which is already ≤ TEXT_SOM_CAP after the
    // in-region filter + re-number above). Dynamic cap scales with
    // estimated image area.
    const zoomCircleCap = Math.min(circleLimit, shownCount);
    const zoomCircleMarks = drawMarks && zoomCircleCap > 0
      ? selectSpatiallyDistributedMarks(marks.slice(0, shownCount), zoomCircleCap).map((m) => ({ id: m.id, x: m.x, y: m.y }))
      : undefined;
    const zoomed = await adapter.executor.zoom(
      regionVirtual,
      allowedIds,
      display.displayId,
      coordinateGrid,
      zoomCircleMarks,
    );
  
    // ── Build feedback text ──
    const w = x1 - x0;
    const h = y1 - y0;
    const warnings: string[] = [];
    if (x0 <= 5) warnings.push("LEFT edge");
    if (y0 <= 5) warnings.push("TOP edge");
    if (x1 >= screenW - 5) warnings.push("RIGHT edge");
    if (y1 >= screenH - 5) warnings.push("BOTTOM edge");
  
    const centerX = Math.round((x0 + x1) / 2);
    const centerY = Math.round((y0 + y1) / 2);
    let text = `Zoomed to [${x0},${y0}]-[${x1},${y1}], center (${centerX},${centerY}), size ${w}×${h} px. Screen is ${screenW}×${screenH}.`;
  
    // Add clipping note if rect was adjusted
    if (hasCenter && wasClipped) {
      text += ` Region was clipped to screen bounds.`;
    }
  
    if (warnings.length > 0) {
      text += ` Region touches ${warnings.join(", ")} of the screen — content may be clipped. Zoom to a narrower region if you need to see edge detail more clearly.`;
    }
  
    // ── Cursor position feedback (existing logic) ──
    try {
      const cursor = await adapter.executor.getCursorPosition();
      const localX = cursor.x - zoomCtx.originX;
      const localY = cursor.y - zoomCtx.originY;
      const cx = Math.round(localX / zoomCtx.ratioX);
      const cy = Math.round(localY / zoomCtx.ratioY);
      adapter.logger.debug(
        `[zoom] cursor logical=(${cursor.x},${cursor.y}) local=(${localX},${localY}) virtual=(${cx},${cy})`,
      );
      const MARGIN = 10;
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) {
        text += ` Cursor is at (${cx}, ${cy}), OUTSIDE this zoom region.`;
      } else if (cx < x0 + MARGIN || cx > x1 - MARGIN || cy < y0 + MARGIN || cy > y1 - MARGIN) {
        text += ` Cursor is at (${cx}, ${cy}), near the EDGE of this zoom region.`;
      }
    } catch {
      // best-effort
    }
  
    // ── SoM marks structured text ──
    const shownMarks = marks.slice(0, shownCount);
    if (shownMarks.length > 0) {
      // Windows context scoped to the zoom region — only windows whose
      // virtual rect intersects regionVirtual contribute, and each
      // window's reported rect is clipped to the zoom region.
      // Restricted to windows we actually UIA-probed (see
      // selectZoomWindowCandidates cap=4) so unprobed windows aren't
      // reported with markCount=0.
      let windowsContext: VisibleWindowContext[] | undefined;
      let attributedMarks: Mark[] = marks;
      if (isWin) {
        const built = buildWinVisibleWindowsContext(
          winBaseline, marks, zoomCtx.ratioX, zoomCtx.ratioY, zoomCtx.originX, zoomCtx.originY,
          regionVirtual,
          probedWindowNames && probedWindowNames.size > 0 ? probedWindowNames : undefined,
        );
        windowsContext = built.contexts;
        attributedMarks = built.attributed;
      } else if (adapter.executor.capabilities.platform === "darwin") {
        try {
          const macBaseline = await listMacVisibleWindows(adapter);
          const built = buildMacVisibleWindowsContext(
            macBaseline, marks, zoomCtx.ratioX, zoomCtx.ratioY, zoomCtx.originX, zoomCtx.originY,
            regionVirtual,
            probedWindowNames && probedWindowNames.size > 0 ? probedWindowNames : undefined,
          );
          windowsContext = built.contexts;
          attributedMarks = built.attributed;
        } catch {
          // best-effort
        }
      }
      text += buildTextFirstSoMBlock(
        attributedMarks,
        shownCount,
        regionVirtual,
        {
          query: overrides.getActiveLocate?.()?.target,
          includePriorityHint: !visionEnabled,
          stats: (marks as any).__somStats,
          windows: windowsContext,
        },
      );
    } else if (somDisabled) {
      // som was explicitly disabled, marks from a prior zoom were cleared.
      const msg = hadMarksBeforeClear
        ? `\n\nSoM marks cleared (som: false). Use ruler coordinates for positioning.`
        : `\n\nSoM detection skipped (som: false). Use ruler coordinates for positioning.`;
      text += msg;
    }
    text += buildToolModeHint(adapter, "zoom");
  
    // Return the image + text feedback. NO `.screenshot` piggyback — this is the invariant.
    return {
      content: [
        { type: "image", data: zoomed.base64, mimeType: "image/jpeg" },
        { type: "text", text },
      ],
    };
  } finally {
    if (anyHostVisible) {
      await adapter.executor.showSelf?.();
    }
    if (!winRestoredEarly && isWin && winTouched.size > 0 && winBaseline.length > 0) {
      await restoreWinVisibleWindowOrder(adapter, winBaseline, [...winTouched]);
    }
  }
}

/** Shared handler for all five click variants. */
async function handleClickVariant(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
  button: "left" | "right" | "middle",
  count: 1 | 2 | 3,
): Promise<CuCallToolResult> {
  // A prior left_mouse_down may have set mouseButtonHeld without a matching
  // left_mouse_up (e.g. drag rejected by a tier gate, model falls back to
  // left_click). executor.click() does its own mouseDown+mouseUp, releasing
  // the OS button — but without this, the JS flag stays true and all
  // subsequent mouse_move calls take the held-button path ("mouse"/
  // "mouse_full" actionKind + hit-test), causing spurious rejections on
  // click-tier and read-tier windows. Release first so click() gets a clean
  // slate.
  if (mouseButtonHeld) {
    await adapter.executor.mouseUp();
    mouseButtonHeld = false;
    mouseMoved = false;
  }

  // Click-in-place: when AI omits `coordinate`, click at the current
  // cursor position. Used after `mouse_move(estimated)` + `screenshot`
  // verification, so AI can commit a click with high confidence the
  // cursor is on its intended target without re-specifying coords.
  const coord = extractOptionalCoordinate(args);
  if (coord instanceof Error) return errorResult(coord.message, "bad_args");
  const clickInPlace = coord === null;
  let rawX = 0;
  let rawY = 0;
  if (!clickInPlace) {
    [rawX, rawY] = coord;
  }

  // left_click(coordinate=[x,y], text="shift") — hold modifiers
  // during the click. Same chord parsing as the key tool.
  let modifiers: string[] | undefined;
  if (args.text !== undefined) {
    if (typeof args.text !== "string") {
      return errorResult("text must be a string", "bad_args");
    }
    // Same gate as handleKey/handleHoldKey. withModifiers presses each name
    // via native.key(m, "press") — a non-modifier like "q" in text="cmd+q"
    // gets pressed while Cmd is held → Cmd+Q fires before the click.
    if (
      isSystemKeyCombo(args.text, adapter.executor.capabilities.platform) &&
      !overrides.grantFlags.systemKeyCombos
    ) {
      return errorResult(
        `The modifier chord "${args.text}" would fire a system shortcut. ` +
          "Request the systemKeyCombos grant flag via request_access, or use " +
          "only modifier keys (shift, ctrl, alt, cmd) in the text parameter.",
        "grant_flag_required",
      );
    }
    modifiers = parseKeyChord(args.text);
  }

  // Right/middle-click and any click with a modifier chord escalate to
  // keyboard-equivalent input at tier "click" (context-menu Paste, chord
  // keystrokes). Compute once, pass to both gates.
  const clickActionKind: CuActionKind =
    button !== "left" || (modifiers !== undefined && modifiers.length > 0)
      ? "mouse_full"
      : "mouse";

  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    clickActionKind,
  );
  if (gate) return gate;

  const display = await resolveDisplay(adapter, args, overrides);
  const ctx = screenScaleCtx(display);

  // Resolve the screen-space click coords. For click-in-place: read the
  // current cursor position directly (already in physical screen coords,
  // no scaleCoord needed — would double-add the display origin). Hit-test
  // and the executor.click call below run on these coords identically to
  // the explicit-coord path.
  let x: number;
  let y: number;
  if (clickInPlace) {
    const cursor = await adapter.executor.getCursorPosition();
    x = cursor.x;
    y = cursor.y;
    adapter.logger.debug(
      `[CU-COORD] click-in-place: using current cursor (${x},${y}) (no coord supplied by AI)`,
    );
  } else {
    const scaled = scaleCoord(
      rawX,
      rawY,
      overrides.coordinateMode,
      display,
      ctx,
      adapter.logger,
    );
    x = scaled.x;
    y = scaled.y;
  }

  const hitGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    x,
    y,
    clickActionKind,
  );
  if (hitGate) return hitGate;

  await adapter.executor.click(x, y, button, count, modifiers);
  // Verify cursor actually landed where we asked. If the value differs
  // from (x, y) by more than rounding, there's still a coord-space
  // mismatch between scaleCoord and the input library. Helps tell
  // "click went to wrong pixel" (our bug) from "click went to right
  // pixel but model misidentified the target" (model bug).
  try {
    const actual = await adapter.executor.getCursorPosition();
    adapter.logger.debug(
      `[CU-COORD] post-click cursor: requested=(${x},${y}) actual=(${actual.x},${actual.y}) delta=(${actual.x - x},${actual.y - y})`,
    );
  } catch {
    // getCursorPosition is best-effort diagnostic, don't break the click
  }
  // Foreground-window probe: which app actually came to the front in
  // response to this click? Disambiguates "click hit the right pixel
  // but launched a different app than expected" from "the right app
  // launched but appears wrong (rendering issue, anti-screenshot, etc)".
  try {
    const fg = await adapter.executor.getFrontmostApp();
    adapter.logger.debug(
      `[CU-FOREGROUND] after click: appIdentifier="${fg?.appIdentifier ?? "null"}" displayName="${fg?.displayName ?? "null"}"`,
    );
  } catch {
    // best-effort
  }
  return okText("Clicked.");
}

async function handleType(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const text = requireString(args, "text");
  if (text instanceof Error) return errorResult(text.message, "bad_args");

  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    "keyboard",
  );
  if (gate) return gate;

  // §6 item 3 — clipboard-paste fast path for multi-line. Sub-gated AND
  // requires clipboardWrite grant. The save/restore + read-back-verify
  // lives in the EXECUTOR (task #5), not here. Here we just route.
  const viaClipboard =
    text.includes("\n") &&
    overrides.grantFlags.clipboardWrite &&
    subGates.clipboardPasteMultiline;

  if (viaClipboard) {
    await adapter.executor.type(text, { viaClipboard: true });
    return okText("Typed (via clipboard).");
  }

  // §6 item 7 — grapheme-cluster iteration. Prevents ZWJ emoji → �.
  // §6 item 4 — 8ms between graphemes (125 Hz USB polling). Battle-tested:
  // sleep BEFORE each keystroke, not after.
  //
  // \n, \r, \t MUST route through executor.key(), not type(). Two reasons:
  //   1. enigo.text("\n") on macOS posts a stale CGEvent with virtualKey=0
  //      after stripping the newline — virtualKey 0 is the 'a' key, so a
  //      ghost 'a' gets typed. Upstream bug in enigo 0.6.1 fast_text().
  //   2. Unicode text-insertion of '\n' is not a Return key press. URL bars
  //      and terminals ignore it; the model's intent (submit/execute) is lost.
  // CRLF (\r\n) is one grapheme cluster (UAX #29 GB3), so check for it too.
  const graphemes = segmentGraphemes(text);
  for (const [i, g] of graphemes.entries()) {
    // Same abort check as handleComputerBatch. At 8ms/grapheme a 50-char
    // type() runs ~400ms; this is where an in-flight batch actually
    // spends its time.
    if (overrides.isAborted?.()) {
      return errorResult(
        `Typing aborted after ${i} of ${graphemes.length} graphemes (user interrupt).`,
      );
    }
    await sleep(INTER_GRAPHEME_SLEEP_MS);
    if (g === "\n" || g === "\r" || g === "\r\n") {
      await adapter.executor.key("return");
    } else if (g === "\t") {
      await adapter.executor.key("tab");
    } else {
      await adapter.executor.type(g, { viaClipboard: false });
    }
  }
  return okText(`Typed ${graphemes.length} grapheme(s).`);
}

async function handleKey(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const keySequence = requireString(args, "text");
  if (keySequence instanceof Error)
    return errorResult("text is required", "bad_args");

  // Cap 100, error strings match.
  let repeat: number | undefined;
  if (args.repeat !== undefined) {
    if (
      typeof args.repeat !== "number" ||
      !Number.isInteger(args.repeat) ||
      args.repeat < 1
    ) {
      return errorResult("repeat must be a positive integer", "bad_args");
    }
    if (args.repeat > 100) {
      return errorResult("repeat exceeds maximum of 100", "bad_args");
    }
    repeat = args.repeat;
  }

  // §2 — blocklist check BEFORE gates. A blocked combo with an ungranted
  // app frontmost should return the blocklist error, not the frontmost
  // error — the model's fix is to request the flag, not change focus.
  if (
    isSystemKeyCombo(keySequence, adapter.executor.capabilities.platform) &&
    !overrides.grantFlags.systemKeyCombos
  ) {
    return errorResult(
      `"${keySequence}" is a system-level shortcut. Request the \`systemKeyCombos\` grant via request_access to use it.`,
      "grant_flag_required",
    );
  }

  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    "keyboard",
  );
  if (gate) return gate;

  await adapter.executor.key(keySequence, repeat);
  return okText("Key pressed.");
}

async function handleScroll(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const coord = extractCoordinate(args);
  if (coord instanceof Error) return errorResult(coord.message, "bad_args");
  const [rawX, rawY] = coord;

  // Uses scroll_direction + scroll_amount.
  // Map to our dx/dy executor interface.
  const dir = args.scroll_direction;
  if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
    return errorResult(
      "scroll_direction must be 'up', 'down', 'left', or 'right'",
      "bad_args",
    );
  }
  const amount = args.scroll_amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    return errorResult("scroll_amount must be a non-negative int", "bad_args");
  }
  if (amount > 100) {
    return errorResult("scroll_amount exceeds maximum of 100", "bad_args");
  }
  // up → dy = -amount; down → dy = +amount; left → dx = -amount; right → dx = +amount.
  const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
  const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;

  const gate = await runInputActionGates(adapter, overrides, subGates, "mouse");
  if (gate) return gate;

  const display = await resolveDisplay(adapter, args, overrides);
  const ctx = screenScaleCtx(display);
  const { x, y } = scaleCoord(
    rawX,
    rawY,
    overrides.coordinateMode,
    display,
    ctx,
    adapter.logger,
  );

  // When the button is held, executor.scroll's internal moveMouse generates
  // a leftMouseDragged event (enigo reads NSEvent.pressedMouseButtons) —
  // same mechanism as handleMoveMouse's held-button path. Upgrade the
  // hit-test to "mouse_full" so scroll can't be used to drag-drop text onto
  // a click-tier terminal, and mark mouseMoved so the subsequent
  // left_mouse_up hit-tests as a drop not a click-release.
  const hitGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    x,
    y,
    mouseButtonHeld ? "mouse_full" : "mouse",
  );
  if (hitGate) return hitGate;
  if (mouseButtonHeld) mouseMoved = true;

  await adapter.executor.scroll(x, y, dx, dy);
  return okText("Scrolled.");
}

async function handleDrag(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  // executor.drag() does its own press+release internally. Without this
  // defensive clear, a prior left_mouse_down leaves mouseButtonHeld=true
  // across the drag and desyncs the flag from OS state — same mechanism as
  // the handleClickVariant clear above. Release first so drag() gets a
  // clean slate.
  if (mouseButtonHeld) {
    await adapter.executor.mouseUp();
    mouseButtonHeld = false;
    mouseMoved = false;
  }

  // `end_coordinate` is the END point (required).
  // `start_coordinate` is OPTIONAL — when omitted, drag from current cursor.
  const rawTo = extractCoordinate(args, "end_coordinate");
  if (rawTo instanceof Error)
    return errorResult(rawTo.message, "bad_args");

  let rawFrom: [number, number] | undefined;
  if (args.start_coordinate !== undefined) {
    const startCoord = extractCoordinate(args, "start_coordinate");
    if (startCoord instanceof Error)
      return errorResult(startCoord.message, "bad_args");
    rawFrom = startCoord;
  }
  // else: rawFrom stays undefined → executor drags from current cursor.

  const gate = await runInputActionGates(adapter, overrides, subGates, "mouse");
  if (gate) return gate;

  // Resolve start and end displays independently for cross-display drag.
  const toDisplay = await resolveDisplay(adapter, args, overrides);

  let fromDisplay: DisplayGeometry | undefined;
  if (typeof args.start_display_id === "number") {
    const displays = await adapter.executor.listDisplays();
    fromDisplay = displays.find((d) => d.displayId === args.start_display_id);
  }

  const startDisplay = fromDisplay ?? toDisplay;
  const fromCtx = screenScaleCtx(startDisplay);
  const toCtx = screenScaleCtx(toDisplay);
  const from =
    rawFrom === undefined
      ? undefined
      : scaleCoord(
          rawFrom[0],
          rawFrom[1],
          overrides.coordinateMode,
          startDisplay,
          fromCtx,
          adapter.logger,
        );
  const to = scaleCoord(
    rawTo[0],
    rawTo[1],
    overrides.coordinateMode,
    toDisplay,
    toCtx,
    adapter.logger,
  );

  // Check both drag endpoints. `from` is where the mouseDown happens (picks
  // up), `to` is where mouseUp happens (drops). When start_coordinate is
  // omitted the drag begins at the cursor — same bypass as mouse_move →
  // left_mouse_down, so read the cursor and hit-test it (mirrors
  // handleLeftMouseDown).
  //
  // The `to` endpoint uses "mouse_full" (not "mouse"): dropping text onto a
  // terminal inserts it as if typed (macOS text drag-drop). Same threat as
  // right-click→Paste. `from` stays "mouse" — picking up is a read.
  const fromPoint = from ?? (await adapter.executor.getCursorPosition());
  const fromGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    fromPoint.x,
    fromPoint.y,
    "mouse",
  );
  if (fromGate) return fromGate;
  const toGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    to.x,
    to.y,
    "mouse_full",
  );
  if (toGate) return toGate;

  await adapter.executor.drag(from, to);
  return okText("Dragged.");
}

async function handleAccept(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const cursor = await adapter.executor.getCursorPosition();

  // Compute image-space coords: physical virtual-screen → screenshot pixel
  // space, so the returned (x, y) match what AI sees on the rulers.
  let x: number;
  let y: number;
  let displayId: number;
  try {
    const d = await adapter.executor.getDisplaySize();
    const ctx = screenScaleCtx(d);
    const localX = cursor.x - ctx.originX;
    const localY = cursor.y - ctx.originY;
    x = Math.round(localX / ctx.ratioX);
    y = Math.round(localY / ctx.ratioY);
    displayId = d.displayId;
  } catch {
    x = cursor.x;
    y = cursor.y;
    displayId = 0;
  }

  // Also try to resolve the actual display the cursor is on.
  try {
    const displays = await adapter.executor.listDisplays();
    const cursorDisplay = displays.find(
      (d) =>
        cursor.x >= d.originX &&
        cursor.x < d.originX + d.width &&
        cursor.y >= d.originY &&
        cursor.y < d.originY + d.height,
    );
    if (cursorDisplay) {
      displayId = cursorDisplay.displayId;
    }
  } catch {
    // best-effort
  }

  return {
    content: [{
      type: "text",
      text: `Position accepted: x=${x}, y=${y}, display_id=${displayId}`,
    }],
    json: { x, y, display_id: displayId },
  };
}

async function handleMoveMouse(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  // ── mark_id resolution (SoM shortcut) ──
  // After any zoom, screenshot, or screenshot_window that ran SoM detection,
  // AI can pass `mark_id: N` instead of a coordinate. We resolve N to the
  // recorded (x, y) of the matching mark from the most recent SoM-producing
  // call. Storage is via `overrides.onLocateMarksUpdated(marks)` which all
  // three handlers call after building their shown-mark slice.
  const markId =
    typeof args.mark_id === "number" && Number.isInteger(args.mark_id)
      ? args.mark_id
      : undefined;
  const hasCoord = Array.isArray(args.coordinate);
  if (markId !== undefined && hasCoord) {
    return errorResult(
      "Cannot specify both `coordinate` and `mark_id` — pick one. mark_id resolves to the recorded center of a SoM mark; coordinate is an explicit (x, y) pair.",
      "bad_args",
    );
  }

  let rawX: number;
  let rawY: number;
  if (markId !== undefined) {
    const marks = overrides.getLastZoomMarks?.() ?? [];
    if (marks.length === 0) {
      return errorResult(
        "`mark_id` requires a recent `zoom`, `screenshot`, or `screenshot_window` that produced SoM marks. No marks available — call one of those tools on the relevant region first, or use `coordinate` instead.",
        "bad_args",
      );
    }
    const mark = marks.find((m) => m.id === markId);
    if (!mark) {
      const known = marks.map((m) => m.id).join(", ");
      return errorResult(
        `mark_id ${markId} not found. Available marks from the most recent SoM call: ${known}. If your target isn't listed, use \`coordinate\` instead.`,
        "bad_args",
      );
    }
    rawX = mark.x;
    rawY = mark.y;
    adapter.logger.debug(
      `[mouse_move] mark_id=${markId} resolved to (${rawX}, ${rawY}) name="${mark.name}" role=${mark.role}`,
    );
  } else if (hasCoord) {
    const coord = extractCoordinate(args);
    if (coord instanceof Error) return errorResult(coord.message, "bad_args");
    [rawX, rawY] = coord;
  } else {
    return errorResult(
      "Either `coordinate` ([x, y] array) or `mark_id` (integer) is required.",
      "bad_args",
    );
  }

  // When the button is held, moveMouse generates leftMouseDragged events on
  // the window under the cursor — that's interaction, not positioning.
  // Upgrade to "mouse" and hit-test the destination. When the button is NOT
  // held: pure positioning, passes at any tier, no hit-test (mouseDown/Up
  // hit-test the cursor to close the mouse_move→left_mouse_down decomposition).
  const actionKind: CuActionKind = mouseButtonHeld ? "mouse" : "mouse_position";
  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    actionKind,
  );
  if (gate) return gate;

  const display = await resolveDisplay(adapter, args, overrides);
  const ctx = screenScaleCtx(display);
  const { x, y } = scaleCoord(
    rawX,
    rawY,
    overrides.coordinateMode,
    display,
    ctx,
    adapter.logger,
  );

  if (mouseButtonHeld) {
    // "mouse_full" — same as left_click_drag's to-endpoint. Dragging onto a
    // click-tier terminal is text injection regardless of which primitive
    // (atomic drag vs. decomposed down/move/up) delivers the events.
    const hitGate = await runHitTestGate(
      adapter,
      overrides,
      subGates,
      x,
      y,
      "mouse_full",
    );
    if (hitGate) return hitGate;
  }

  await adapter.executor.moveMouse(x, y);
  if (mouseButtonHeld) mouseMoved = true;

  const actual = await adapter.executor.getCursorPosition();
  const actualScreenX = rawX;
  const actualScreenY = rawY;

  const CURSOR_MARGIN_IMAGE_PX = 5;
  const warnings: string[] = [];
  const posX = actualScreenX;
  const posY = actualScreenY;
  let xFrac: number | null = null;
  let yFrac: number | null = null;
  const reportW = display.width;
  const reportH = display.height;
  let marginFracX = CURSOR_MARGIN_IMAGE_PX / display.width;
  let marginFracY = CURSOR_MARGIN_IMAGE_PX / display.height;
  if (overrides.coordinateMode === "normalized_0_100") {
    xFrac = rawX / 100;
    yFrac = rawY / 100;
  } else if (overrides.coordinateMode === "pixels" && reportW > 0) {
    xFrac = rawX / reportW;
    marginFracX = CURSOR_MARGIN_IMAGE_PX / reportW;
    if (reportH > 0) {
      yFrac = rawY / reportH;
      marginFracY = CURSOR_MARGIN_IMAGE_PX / reportH;
    }
  }
  if (xFrac !== null && reportW > 0) {
      if (xFrac < 0)
        warnings.push("past LEFT edge (x<0) — fully off-screen. Increase x.");
      else if (xFrac < marginFracX)
        warnings.push("near LEFT edge — cursor partially clipped. Increase x.");
      else if (xFrac >= 1)
        warnings.push(
          `past RIGHT edge (screen width ${reportW}px) — fully off-screen. Reduce x.`,
        );
      else if (xFrac > 1 - marginFracX)
        warnings.push(
          `near RIGHT edge (screen width ${reportW}px) — cursor partially clipped. Reduce x.`,
        );
    }
    if (yFrac !== null && reportH > 0) {
      if (yFrac < 0)
        warnings.push("past TOP edge (y<0) — fully off-screen. Increase y.");
      else if (yFrac < marginFracY)
        warnings.push("near TOP edge — cursor partially clipped. Increase y.");
      else if (yFrac >= 1)
        warnings.push(
          `past BOTTOM edge (screen height ${reportH}px) — fully off-screen. Reduce y.`,
        );
      else if (yFrac > 1 - marginFracY)
        warnings.push(
          `near BOTTOM edge (screen height ${reportH}px) — cursor partially clipped. Reduce y.`,
        );
    }
  const screenLabel = "screen";
  const pos =
    actualScreenX !== undefined ? ` Cursor at (${posX}, ${posY}) on ${screenLabel}.` : "";
  if (warnings.length > 0) {
    return okText(`Moved (warning: ${warnings.join("; ")}).${pos}`);
  }
  return okText(`Moved.${pos}`);
}

async function handleOpenApplication(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const app = requireString(args, "app");
  if (app instanceof Error) return errorResult(app.message, "bad_args");

  const bypassed = isAllowlistBypassed();
  const allowedApps = allowedAppsOf(overrides);
  adapter.logger.debug(
    `[CU-GATE] handleOpenApplication entry: app=${JSON.stringify(app)} bypass=${bypassed} ` +
      `allowedApps=${JSON.stringify(allowedApps.map((a) => a.appIdentifier))}`,
  );
  // Bypass: skip the allowlist pre-launch check entirely; pass the input
  // straight to the executor. executor.openApp tolerates raw exe paths
  // (Windows) / bundle ids (mac) / display names; whatever the AI passed
  // we forward it.
  if (bypassed) {
    await adapter.executor.openApp(app);
    return okText(`Launched ${app}.`);
  }

  // Resolve display-name → bundle ID. Same logic as request_access.
  const allowed = new Set(allowedApps.map((g) => g.appIdentifier));
  let targetAppIdentifier: string | undefined;

  if (looksLikeAppIdentifier(app) && allowed.has(app)) {
    targetAppIdentifier = app;
  } else {
    // Try display name → bundle ID, but ONLY against the allowlist itself.
    // Avoids paying the listInstalledApps() cost on the hot path and is
    // arguably more correct: if the user granted "Slack", the model asking
    // to open "Slack" should match THAT grant.
    const match = allowedApps.find(
      (g) => g.displayName.toLowerCase() === app.toLowerCase(),
    );
    targetAppIdentifier = match?.appIdentifier;
  }

  if (!targetAppIdentifier || !allowed.has(targetAppIdentifier)) {
    const allowlistList = allowedApps.map(a => a.appIdentifier).join(',') || '<empty>';
    adapter.logger.debug(
      `[CU-GATE] handleOpenApplication BLOCK: app="${app}" not in allowedApps={${allowlistList}} — returning app_not_granted error to AI ` +
        `(default-open mode means this branch is unreachable; if you see this log, isAllowlistBypassed() somehow returned false)`,
    );
    return errorResult(
      `"${app}" is not granted for this session. Call request_access first.`,
      "app_not_granted",
    );
  }
  adapter.logger.debug(
    `[CU-GATE] handleOpenApplication PASS: app="${app}" → appIdentifier="${targetAppIdentifier}", launching`,
  );

  // open_application works at any tier — bringing an app forward is exactly
  // what tier "read" enables (you need it on screen to screenshot it). The
  // tier gates on click/type catch any follow-up interaction.

  await adapter.executor.openApp(targetAppIdentifier);

  // On multi-monitor setups, macOS may place the opened window on a monitor
  // the resolver won't pick (e.g. Axiomate + another allowed app are co-located
  // elsewhere). Nudge the model toward switch_display BEFORE it wastes steps
  // clicking on dock icons. Single-monitor → no hint. listDisplays failure is
  // non-fatal — the hint is advisory.
  if (overrides.onDisplayPinned !== undefined) {
    let displayCount = 1;
    try {
      displayCount = (await adapter.executor.listDisplays()).length;
    } catch {
      // hint skipped
    }
    if (displayCount >= 2) {
      return okText(
        `Opened "${app}". If it isn't visible in the next screenshot, it may ` +
          `have opened on a different monitor — use switch_display to check.`,
      );
    }
  }

  return okText(`Opened "${app}".`);
}

async function handleSwitchDisplay(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const display = requireString(args, "display");
  if (display instanceof Error) return errorResult(display.message, "bad_args");

  if (!overrides.onDisplayPinned) {
    return errorResult(
      "Display switching is not available in this session.",
      "feature_unavailable",
    );
  }

  if (display.toLowerCase() === "auto") {
    overrides.onDisplayPinned(undefined);
    return okText(
      "Returned to automatic monitor selection. Call screenshot to continue.",
    );
  }

  // Resolve label → displayId fresh. Same source buildMonitorNote reads,
  // so whatever name the model saw in a screenshot note resolves here.
  let displays;
  try {
    displays = await adapter.executor.listDisplays();
  } catch (e) {
    return errorResult(
      `Failed to enumerate displays: ${String(e)}`,
      "display_error",
    );
  }

  if (displays.length < 2) {
    return errorResult(
      "Only one monitor is connected. There is nothing to switch to.",
      "bad_args",
    );
  }

  const labels = uniqueDisplayLabels(displays);
  const wanted = display.toLowerCase();
  const target = displays.find(
    (d) => labels.get(d.displayId)?.toLowerCase() === wanted,
  );
  if (!target) {
    const available = displays
      .map((d) => `"${labels.get(d.displayId)}"`)
      .join(", ");
    return errorResult(
      `No monitor named "${display}" is connected. Available monitors: ${available}.`,
      "bad_args",
    );
  }

  overrides.onDisplayPinned(target.displayId);
  return {
    content: [{
      type: "text",
      text: `Switched to monitor "${labels.get(target.displayId)}" (display_id=${target.displayId}). Call screenshot to see it.`,
    }],
    json: { display_id: target.displayId, label: labels.get(target.displayId) },
  };
}

function handleListGrantedApplications(
  overrides: ComputerUseOverrides,
): CuCallToolResult {
  // list_granted_applications is mac-only (filtered out of Win tool list).
  return okJson({
    allowedApps: allowedAppsOf(overrides),
    grantFlags: overrides.grantFlags,
  });
}

async function handleListRunningApps(
  adapter: ComputerUseHostAdapter,
): Promise<CuCallToolResult> {
  // Returns currently-running apps with at least one visible top-level
  // window. Win NAPI uses EnumWindows + IsWindowVisible + dedupe by exe
  // path (full path = bundle_id). Mac uses NSWorkspace runningApplications
  // filtered to activationPolicy == .regular. Output JSON shape matches
  // RunningApp interface so the AI can directly extract bundle_id for
  // subsequent screenshot_window / open_application calls.
  const apps = await adapter.executor.listRunningApps();
  return okJson({ runningApps: apps });
}

async function handleReadClipboard(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (!overrides.grantFlags.clipboardRead) {
    return errorResult(
      "Clipboard read is not granted. Request `clipboardRead` via request_access.",
      "grant_flag_required",
    );
  }

  // read_clipboard doesn't route through runInputActionGates — sync here so
  // reading after clicking into a click-tier app sees the cleared clipboard
  // (same as what the app's own Paste would see).
  if (subGates.clipboardGuard) {
    const frontmost = await adapter.executor.getFrontmostApp();
    const tierByAppIdentifier = new Map(
      allowedAppsOf(overrides).map((a) => [a.appIdentifier, a.tier] as const),
    );
    const frontmostTier = frontmost
      ? tierByAppIdentifier.get(frontmost.appIdentifier)
      : undefined;
    await syncClipboardStash(adapter, overrides, frontmostTier === "click");
  }

  // clipboardGuard may have stashed+cleared — read the actual (possibly
  // empty) clipboard. The agent sees what the app would see.
  const text = await adapter.executor.readClipboard();
  return okJson({ text });
}

async function handleWriteClipboard(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (!overrides.grantFlags.clipboardWrite) {
    return errorResult(
      "Clipboard write is not granted. Request `clipboardWrite` via request_access.",
      "grant_flag_required",
    );
  }
  const text = requireString(args, "text");
  if (text instanceof Error) return errorResult(text.message, "bad_args");

  if (subGates.clipboardGuard) {
    const frontmost = await adapter.executor.getFrontmostApp();
    const tierByAppIdentifier = new Map(
      allowedAppsOf(overrides).map((a) => [a.appIdentifier, a.tier] as const),
    );
    const frontmostTier = frontmost
      ? tierByAppIdentifier.get(frontmost.appIdentifier)
      : undefined;

    // Defense-in-depth for the clipboardGuard bypass: write_clipboard +
    // left_click on a click-tier app's UI Paste button. The re-clear in
    // syncClipboardStash already defeats it (the next action clobbers the
    // write), but rejecting here gives the agent a clear signal instead of
    // silently voiding its write.
    if (frontmost && frontmostTier === "click") {
      return errorResult(
        `"${frontmost.displayName}" is a tier-"click" app and currently ` +
          `frontmost. write_clipboard is blocked because the next action ` +
          `would clear the clipboard anyway — a UI Paste button in this ` +
          `app cannot be used to inject text. Bring a tier-"full" app ` +
          `forward before writing to the clipboard.` +
          TIER_ANTI_SUBVERSION,
        "tier_insufficient",
      );
    }

    // write_clipboard doesn't route through runInputActionGates — sync here
    // so clicking away from a click-tier app then writing restores the user's
    // stash before the agent's text lands.
    await syncClipboardStash(adapter, overrides, frontmostTier === "click");
  }

  await adapter.executor.writeClipboard(text);
  return okText("Clipboard written.");
}

/**
 * wait(duration=N). Sleeps N seconds, capped at 100.
 * No frontmost gate — no input, nothing to protect. Kill-switch + TCC
 * are checked in handleToolCall before dispatch reaches here.
 */
async function handleWait(
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  const duration = args.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return errorResult("duration must be a number", "bad_args");
  }
  if (duration < 0) {
    return errorResult("duration must be non-negative", "bad_args");
  }
  if (duration > 100) {
    return errorResult(
      "duration is too long. Duration is in seconds.",
      "bad_args",
    );
  }
  await sleep(duration * 1000);
  return okText(`Waited ${duration}s.`);
}

/**
 * Returns "X=...,Y=..." plain text. We return richer JSON with
 * coordinateSpace annotation — the model handles both shapes.
 *
 * When lastScreenshot is present: inverse of scaleCoord — logical points →
 * image-pixels via `imageX = logicalX × (screenshotWidth / displayWidth)`.
 * Uses capture-time dims so the returned coords match what the model would
 * read off that screenshot.
 *
 * No frontmost gate — read-only, no input.
 */
async function handleCursorPosition(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const logical = await adapter.executor.getCursorPosition();

  // Resolve which display the cursor is physically on
  let cursorDisplayId = overrides.selectedDisplayId ?? 0;
  try {
    const displays = await adapter.executor.listDisplays();
    const cursorDisplay = displays.find(
      (d) =>
        logical.x >= d.originX &&
        logical.x < d.originX + d.width &&
        logical.y >= d.originY &&
        logical.y < d.originY + d.height,
    );
    if (cursorDisplay) cursorDisplayId = cursorDisplay.displayId;
  } catch { /* best-effort */ }

  try {
    const d = await adapter.executor.getDisplaySize(cursorDisplayId);
    const ctx = screenScaleCtx(d);
    const localX = logical.x - ctx.originX;
    const localY = logical.y - ctx.originY;
    const x = Math.round(localX / ctx.ratioX);
    const y = Math.round(localY / ctx.ratioY);
    return okJson({ x, y, display_id: cursorDisplayId });
  } catch {
    return okJson({ x: logical.x, y: logical.y, display_id: cursorDisplayId });
  }
}

/**
 * Presses each key in the
 * chord, sleeps duration seconds, releases in reverse. Same duration bounds
 * as wait. Keyboard action → frontmost gate applies; same systemKeyCombos
 * blocklist check as key.
 */
async function handleHoldKey(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const text = requireString(args, "text");
  if (text instanceof Error) return errorResult(text.message, "bad_args");

  const duration = args.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return errorResult("duration must be a number", "bad_args");
  }
  if (duration < 0) {
    return errorResult("duration must be non-negative", "bad_args");
  }
  if (duration > 100) {
    return errorResult(
      "duration is too long. Duration is in seconds.",
      "bad_args",
    );
  }

  // Blocklist check BEFORE gates — same reasoning as handleKey. Holding
  // cmd+q is just as dangerous as tapping it.
  if (
    isSystemKeyCombo(text, adapter.executor.capabilities.platform) &&
    !overrides.grantFlags.systemKeyCombos
  ) {
    return errorResult(
      `"${text}" is a system-level shortcut. Request the \`systemKeyCombos\` grant via request_access to use it.`,
      "grant_flag_required",
    );
  }

  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    "keyboard",
  );
  if (gate) return gate;

  const keyNames = parseKeyChord(text);
  await adapter.executor.holdKey(keyNames, duration * 1000);
  return okText("Key held.");
}

/**
 * Raw press at current cursor, no coordinate.
 * Move first with mouse_move. Errors if already held.
 */
async function handleLeftMouseDown(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (mouseButtonHeld) {
    return errorResult(
      "mouse button already held, call left_mouse_up first",
      "state_conflict",
    );
  }

  const gate = await runInputActionGates(adapter, overrides, subGates, "mouse");
  if (gate) return gate;

  // macOS routes mouseDown to the window under the cursor, not the frontmost
  // app. Without this hit-test, mouse_move (positioning, passes at any tier)
  // + left_mouse_down decomposes a click that lands on a tier-"read" window
  // overlapping a tier-"full" frontmost app — bypassing runHitTestGate's
  // whole purpose. All three are batchable, so the bypass is atomic.
  const cursor = await adapter.executor.getCursorPosition();
  const hitGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    cursor.x,
    cursor.y,
    "mouse",
  );
  if (hitGate) return hitGate;

  await adapter.executor.mouseDown();
  mouseButtonHeld = true;
  mouseMoved = false;
  return okText("Mouse button pressed.");
}

/**
 * Raw release at current cursor. Does NOT error
 * if not held (idempotent release).
 */
async function handleLeftMouseUp(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  // Any gate rejection here must release the button FIRST — otherwise the
  // OS button stays pressed and mouseButtonHeld stays true. Recovery
  // attempts (mouse_move back to a safe app) would generate leftMouseDragged
  // events into whatever window is under the cursor, including the very
  // read-tier window the gate was protecting. A single mouseUp on a
  // restricted window is one event; a stuck button is cascading damage.
  //
  // This includes the frontmost gate: focus can change between mouseDown and
  // mouseUp (something else grabbed focus), in which case runInputActionGates
  // rejects here even though it passed at mouseDown.
  const releaseFirst = async (
    err: CuCallToolResult,
  ): Promise<CuCallToolResult> => {
    await adapter.executor.mouseUp();
    mouseButtonHeld = false;
    mouseMoved = false;
    return err;
  };

  const gate = await runInputActionGates(adapter, overrides, subGates, "mouse");
  if (gate) return releaseFirst(gate);

  // When the cursor moved since mouseDown, this is a drop (text-injection
  // vector) — hit-test at "mouse_full" same as left_click_drag's `to`. When
  // NO move happened, this is a click-release — same semantics as the atomic
  // left_click, hit-test at "mouse". Without this distinction, a decomposed
  // click on a click-tier app fails here while the atomic left_click works,
  // and releaseFirst fires mouseUp anyway so the OS sees a complete click
  // while the model gets a misleading error.
  const cursor = await adapter.executor.getCursorPosition();
  const hitGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    cursor.x,
    cursor.y,
    mouseMoved ? "mouse_full" : "mouse",
  );
  if (hitGate) return releaseFirst(hitGate);

  await adapter.executor.mouseUp();
  mouseButtonHeld = false;
  mouseMoved = false;
  return okText("Mouse button released.");
}

// ---------------------------------------------------------------------------
// Batch dispatch
// ---------------------------------------------------------------------------

/**
 * Actions allowed inside a computer_batch call. Excludes request_access,
 * open_application, clipboard, list_granted (no latency benefit, complicates
 * security model).
 */
const BATCHABLE_ACTIONS: ReadonlySet<string> = new Set([
  "key",
  "type",
  "mouse_move",
  "left_click_drag",
  "scroll",
  "hold_key",
  "screenshot",
  "cursor_position",
  "left_mouse_down",
  "left_mouse_up",
  "wait",
]);

interface BatchActionResult {
  action: string;
  ok: boolean;
  output: string;
}

/**
 * Executes `actions: [{action, …}, …]`
 * sequentially in ONE model→API round trip — the dominant latency cost
 * (seconds, vs. ~50ms local overhead per action).
 *
 * Gate semantics (the security model):
 *   - Kill-switch + TCC: checked ONCE by handleToolCall before reaching here.
 *   - prepareForAction: run ONCE at the top. The user approved "do this
 *     sequence"; hiding apps per-action is wasted work and fast-pathed anyway.
 *   - Frontmost gate: checked PER ACTION. State can change mid-batch — a
 *     click might open a non-allowed app. This is the safety net: if action
 *     3 of 5 opened Safari (not allowed), action 4's frontmost check fires
 *     and stops the batch there.
 *
 * The skip is implemented by passing `{...subGates, hideBeforeAction:
 * false}` to each inner dispatch — the handlers'
 * existing gate logic does the right thing, no new code paths.
 *
 * Stop-on-first-error: accumulate results, on
 * first `isError` stop executing, return everything so far + the error. The
 * model sees exactly where the batch broke and what succeeded before it.
 *
 * Mid-batch screenshots are allowed (for inspection) but NEVER piggyback —
 * their `.screenshot` field is dropped. Same invariant as zoom: click coords
 * always refer to the PRE-BATCH `lastScreenshot`. If the model wants to click
 * based on a new screenshot, it ends the batch and screenshots separately.
 */
async function handleComputerBatch(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const actions = args.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return errorResult("actions must be a non-empty array", "bad_args");
  }

  for (const [i, act] of actions.entries()) {
    if (typeof act !== "object" || act === null) {
      return errorResult(`actions[${i}] must be an object`, "bad_args");
    }
    const action = (act as Record<string, unknown>).action;
    if (typeof action !== "string") {
      return errorResult(`actions[${i}].action must be a string`, "bad_args");
    }
    if (!BATCHABLE_ACTIONS.has(action)) {
      return errorResult(
        `actions[${i}].action="${action}" is not allowed in a batch. ` +
          `Allowed: ${[...BATCHABLE_ACTIONS].join(", ")}.`,
        "bad_args",
      );
    }
  }

  // prepareForAction ONCE. After this, inner dispatches skip it via
  // hideBeforeAction:false.
  if (subGates.hideBeforeAction) {
    const hidden = (await adapter.executor.prepareForAction?.(
      allowedAppsOf(overrides).map((a) => a.appIdentifier),
      overrides.selectedDisplayId,
    )) ?? [];
    if (hidden.length > 0) {
      overrides.onAppsHidden?.(hidden);
    }
  }

  // Inner actions: skip prepare (already ran). Frontmost still
  // checked — runInputActionGates does it unconditionally.
  const batchSubGates: CuSubGates = {
    ...subGates,
    hideBeforeAction: false,
    // Batch already took its screenshot (appended at end); a mid-batch
    // resolver switch would make that screenshot inconsistent with
    // earlier clicks' lastScreenshot-based scaleCoord targeting.
    autoTargetDisplay: false,
  };

  const results: BatchActionResult[] = [];
  for (const [i, act] of actions.entries()) {
    // Overlay Stop → host's stopSession → lifecycleState leaves "running"
    // synchronously before query.interrupt(). The SDK abort tears down the
    // host's await but not this loop — without this check the remaining
    // actions fire into a dead session.
    if (overrides.isAborted?.()) {
      await releaseHeldMouse(adapter);
      return errorResult(
        `Batch aborted after ${results.length} of ${actions.length} actions (user interrupt).`,
      );
    }

    // Small inter-step settle. Synthetic CGEvents post instantly; some apps
    // need a tick to process step N's input before step N+1 lands (e.g. a
    // click opening a menu before the next click targets a menu item).
    if (i > 0) await sleep(10);

    const actionArgs = act as Record<string, unknown>;
    const action = actionArgs.action as string;

    // Drop mid-batch screenshot piggyback (strip .screenshot). Click coords
    // stay anchored to the pre-batch lastScreenshot.
    const { screenshot: _dropped, ...inner } = await dispatchAction(
      action,
      actionArgs,
      adapter,
      overrides,
      batchSubGates,
    );

    const text = firstTextContent(inner);
    const result = { action, ok: !inner.isError, output: text };
    results.push(result);

    if (inner.isError) {
      // Stop-on-first-error. Return everything so far + the error.
      // Forward the inner action's telemetry (error_kind) so cu_tool_call
      // reflects the actual failure — without this, batch-internal errors
      // emit error_kind: undefined despite the inner handler tagging it.
      // Release held mouse: the error may be a mid-grapheme abort in
      // handleType, or a frontmost gate, landing between mouse_down and
      // mouse_up.
      await releaseHeldMouse(adapter);
      return okJson(
        {
          completed: results.slice(0, -1),
          failed: result,
          remaining: actions.length - results.length,
        },
        inner.telemetry,
      );
    }
  }

  return okJson({ completed: results });
}

function firstTextContent(r: CuCallToolResult): string {
  const first = r.content[0];
  return first && first.type === "text" ? first.text : "";
}

/**
 * Action dispatch shared by handleToolCall and handleComputerBatch. Called
 * AFTER kill-switch + TCC gates have passed. Never sees request_access — it's
 * special-cased in handleToolCall for the tccState thread-through.
 */
async function dispatchAction(
  name: string,
  a: Record<string, unknown>,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  switch (name) {
    case "screenshot":
      return handleScreenshot(adapter, overrides, subGates, a);

    case "screenshot_window":
      return handleScreenshotWindow(adapter, a, overrides);

    case "zoom":
      return handleZoom(adapter, a, overrides);

    case "vision_locate":
      return handleVisionLocate(adapter, a as { description: string }, overrides);

    case "accept":
      return handleAccept(adapter, overrides);

    case "left_click":
      return handleClickVariant(adapter, a, overrides, subGates, "left", 1);
    case "double_click":
      return handleClickVariant(adapter, a, overrides, subGates, "left", 2);
    case "triple_click":
      return handleClickVariant(adapter, a, overrides, subGates, "left", 3);
    case "right_click":
      return handleClickVariant(adapter, a, overrides, subGates, "right", 1);
    case "middle_click":
      return handleClickVariant(adapter, a, overrides, subGates, "middle", 1);

    case "type":
      return handleType(adapter, a, overrides, subGates);

    case "key":
      return handleKey(adapter, a, overrides, subGates);

    case "scroll":
      return handleScroll(adapter, a, overrides, subGates);

    case "left_click_drag":
      return handleDrag(adapter, a, overrides, subGates);

    case "mouse_move":
      return handleMoveMouse(adapter, a, overrides, subGates);

    case "wait":
      return handleWait(a);

    case "cursor_position":
      return handleCursorPosition(adapter, overrides);

    case "hold_key":
      return handleHoldKey(adapter, a, overrides, subGates);

    case "left_mouse_down":
      return handleLeftMouseDown(adapter, overrides, subGates);

    case "left_mouse_up":
      return handleLeftMouseUp(adapter, overrides, subGates);

    case "open_application":
      return handleOpenApplication(adapter, a, overrides);

    case "switch_display":
      return handleSwitchDisplay(adapter, a, overrides);

    case "list_running_apps":
      return handleListRunningApps(adapter);
    case "list_granted_applications":
      return handleListGrantedApplications(overrides);

    case "read_clipboard":
      return handleReadClipboard(adapter, overrides, subGates);

    case "write_clipboard":
      return handleWriteClipboard(adapter, a, overrides, subGates);

    case "computer_batch":
      return handleComputerBatch(adapter, a, overrides, subGates);

    default:
      return errorResult(`Unknown tool "${name}".`, "bad_args");
  }
}

function screenLocateDisabledResult(): CuCallToolResult {
  return errorResult(
    "`vision_locate` is unavailable. Use `screenshot`, `zoom`, or `screenshot_window` instead, read the text SoM list, then use `mouse_move(mark_id: N)` to target a detected UI element.",
    "feature_unavailable",
  );
}

function screenLocateNoImageResult(): CuCallToolResult {
  return errorResult(
    "`vision_locate` requires image input and is unavailable with the current model. Use `screenshot`, `zoom`, or `screenshot_window` instead, read the text SoM list, then use `mouse_move(mark_id: N)` to target a detected UI element.",
    "feature_unavailable",
  );
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function handleToolCall(
  adapter: ComputerUseHostAdapter,
  name: string,
  args: unknown,
  rawOverrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const { logger, serverName } = adapter;

  logger.debug(
    `[CU-DISPATCH] tool=${name} bypass=${isAllowlistBypassed()} ` +
      `allowedApps.length=${allowedAppsOf(rawOverrides).length} ` +
      `args=${JSON.stringify(args ?? {}).slice(0, 200)}`,
  );

  // Normalize the allowlist before any gate runs (mac-only — Win has no
  // allowlist concept, the type system says rawOverrides.allowedApps doesn't
  // exist on the win32 variant):
  //
  // (a) Strip user-denied. A grant from a previous session (before the user
  //     added the app to Settings → Desktop app → Computer Use → Denied apps)
  //     must not survive. Without
  //     this, a stale grant bypasses the auto-deny. Stripped silently — the
  //     agent already saw the userDenied guidance at request_access time, and
  //     a live frontmost-gate rejection cites "not in allowed applications".
  //
  // (b) Strip policy-denied. Same story as (a) for a grant that predates a
  //     blocklist addition. buildAccessRequest denies these up front for new
  //     requests; this catches stale persisted grants.
  //
  // (c) Backfill tier. A grant persisted before the tier field existed has
  //     `tier: undefined`, which `tierSatisfies` treats as `"full"` — wrong
  //     for a legacy Chrome grant. Assign the hardcoded tier based on
  //     bundle-ID category. Modern grants already have a tier.
  //
  // `.some()` guard keeps the hot path (empty deny list, no legacy grants)
  // zero-alloc.
  const overrides: ComputerUseOverrides = (() => {
    if (rawOverrides.platform !== "darwin") return rawOverrides;
    const userDeniedSet = new Set(rawOverrides.userDeniedAppIdentifiers);
    const needsNormalize = rawOverrides.allowedApps.some(
      (a) =>
        a.tier === undefined ||
        userDeniedSet.has(a.appIdentifier) ||
        isPolicyDenied(a.appIdentifier, a.displayName),
    );
    if (!needsNormalize) return rawOverrides;
    return {
      ...rawOverrides,
      allowedApps: rawOverrides.allowedApps
        .filter((a) => !userDeniedSet.has(a.appIdentifier))
        .filter((a) => !isPolicyDenied(a.appIdentifier, a.displayName))
        .map((a) =>
          a.tier !== undefined
            ? a
            : { ...a, tier: getDefaultTierForApp(a.appIdentifier, a.displayName) },
        ),
    };
  })();

  // ─── Gate 1: kill switch ─────────────────────────────────────────────
  if (adapter.isDisabled()) {
    return errorResult(
      "Computer control is disabled in Settings. Enable it and try again.",
      "other",
    );
  }

  if (name === "vision_locate" && !adapter.isVisionLocateEnabled()) {
    return screenLocateDisabledResult();
  }

  if (name === "vision_locate" && !adapter.currentModelSupportsImages()) {
    return screenLocateNoImageResult();
  }

  // ─── Gate 2: TCC ─────────────────────────────────────────────────────
  // Accessibility + Screen Recording on macOS. Pure check — no dialog,
  // no relaunch. `request_access` is exempted: it threads the ungranted
  // state through to the renderer, which shows a TCC toggle panel instead
  // of the app list. Every other tool short-circuits here.
  const osPerms = await adapter.ensureOsPermissions();
  let tccState:
    | { accessibility: boolean; screenRecording: boolean }
    | undefined;
  // win32 variant is statically `granted: true`, so this branch is reachable
  // only on darwin — TS narrows osPerms to the darwin variant after the
  // platform check, giving us typed access to accessibility/screenRecording.
  if (osPerms.platform === "darwin" && !osPerms.granted) {
    // Both request_* tools thread tccState through to the renderer's
    // TCC toggle panel. Every other tool short-circuits.
    if (name !== "request_access" && name !== "request_teach_access") {
      return errorResult(
        "Accessibility and Screen Recording permissions are required. " +
          "Call request_access to show the permission panel.",
        "tcc_not_granted",
      );
    }
    tccState = {
      accessibility: osPerms.accessibility,
      screenRecording: osPerms.screenRecording,
    };
  }

  // ─── Gate 3: global CU lock ──────────────────────────────────────────
  // At most one session uses CU at a time. Every tool including
  // request_access hits the CHECK — even showing the approval dialog while
  // another session holds the lock would be confusing ("why approve access
  // that can't be used?").
  //
  // But ACQUIRE is split: request_access and list_granted_applications
  // check-without-acquire (the overlay + notifications are driven by
  // cuLockChanged, and showing "Axiomate is using your computer" while the
  // agent is only ASKING for access is premature). First action tool
  // acquires and the overlay appears. If the user denies and no action
  // follows, the overlay never shows.
  //
  // request_teach_access is NOT in this set — approving teach mode HIDES
  // the main window (via onTeachModeActivated), and the lock must be held
  // before that happens. Otherwise a concurrent session's request_access
  // would render its dialog in an invisible main window during the gap
  // between hide and the first teach_step (seconds of model inference).
  // The old acquire-always-at-Gate-3 behavior was correct for teach; only
  // the non-teach permission tools benefit from deferral.
  //
  // Host releases on idle/stop/archive; this package never releases. Hosts
  // wire checkCuLock via a shared cuLock singleton. When undefined
  // (tests/hosts without locking), no gate — absence of the mechanism ≠
  // locked out.
  const deferAcquire = defersLockAcquire(name);
  const lock = overrides.checkCuLock?.();
  if (lock) {
    if (lock.holder !== undefined && !lock.isSelf) {
      return errorResult(
        "Another Axiomate session is currently using the computer. Wait for " +
          "the user to acknowledge it is finished (stop button in the Axiomate " +
          "window), or find a non-computer-use approach if one is readily " +
          "apparent.",
        "cu_lock_held",
      );
    }
    if (lock.holder === undefined && !deferAcquire) {
      // Acquire. Emits cuLockChanged → overlay shows. Idempotent — if
      // someone else acquired between check and here (won't happen on a
      // single-threaded event loop, but defensive), this is a no-op.
      overrides.acquireCuLock?.();
      // Fresh lock holder → any prior session's mouseButtonHeld is stale
      // (e.g. overlay stop mid-drag). Clear it so this session doesn't get
      // a spurious "already held" error. resetMouseButtonHeld is file-local;
      // this is the one non-test callsite.
      resetMouseButtonHeld();
    }
    // lock.isSelf → already held by us, proceed.
    // lock.holder === undefined && deferAcquire →
    //   checked but not acquired — proceed, first action will acquire.
  }

  // Sub-gates read FRESH every call so a GrowthBook flip takes effect
  // mid-session (plan §3).
  const subGates = adapter.getSubGates();

  // Clipboard guard runs per-action inside runInputActionGates + inline in
  // handleReadClipboard/handleWriteClipboard. NOT here — per-tool-call sync
  // would run once for computer_batch and miss sub-actions 2..N, and would
  // fire during deferAcquire tools / `wait` / teach_step's blocking-dialog
  // phase where no input is happening.

  const a = asRecord(args);

  logger.silly(
    `[${serverName}] tool=${name} args=${JSON.stringify(a).slice(0, 200)}`,
  );

  // ─── Fail-closed dispatch ────────────────────────────────────────────
  // ANY exception below → tool error, executor never left in a half-called
  // state. Explicit inversion of the prior `catch → return true` fail-open.
  try {
    // request_access / request_teach_access: need tccState thread-through;
    // dispatchAction never sees them (not batchable).
    // teach_step: blocking UI tool, also not batchable; needs subGates for
    // its action-execution phase.
    if (name === "request_access") {
      return await handleRequestAccess(adapter, a, overrides, tccState);
    }
    if (name === "request_teach_access") {
      return await handleRequestTeachAccess(adapter, a, overrides, tccState);
    }
    if (name === "teach_step") {
      return await handleTeachStep(adapter, a, overrides, subGates);
    }
    if (name === "teach_batch") {
      return await handleTeachBatch(adapter, a, overrides, subGates);
    }
    return await dispatchAction(name, a, adapter, overrides, subGates);
  } catch (err) {
    // Fail-closed. If the gate machinery itself throws (e.g.
    // getFrontmostApp() rejects), the executor has NOT been called yet for
    // the gated tools — the gates run before the executor in every handler.
    // For ungated tools, the executor may have been mid-call; that's fine —
    // the result is still a tool error, never an implicit success.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[${serverName}] tool=${name} threw: ${msg}`, err);
    return errorResult(`Tool "${name}" failed: ${msg}`, "executor_threw");
  }
}

export const _test = {
  scaleCoord,
  segmentGraphemes,
  decodedByteLength,
  resolveRequestedApps,
  buildAccessRequest,
  buildTierGuidanceMessage,
  buildUserDeniedGuidance,
  tierSatisfies,
  looksLikeAppIdentifier,
  extractCoordinate,
  parseKeyChord,
  buildMonitorNote,
  handleSwitchDisplay,
  uniqueDisplayLabels,
};
