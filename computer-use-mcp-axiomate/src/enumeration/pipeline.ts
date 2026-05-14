/**
 * Phase 1.5 — UIA/AX enumeration pipeline orchestrator.
 *
 * Implements the 13-step flow from `plans/hermes-agent-computer-use-glistening-hartmanis.md` Part F:
 *
 *   1. (caller)  hide axiomate host if visible
 *   2. (here)    build visible-windows baseline
 *   3. (here)    record window layout
 *   4. (here)    select candidate windows
 *   5. (here)    bulk-enumerate each candidate
 *   6. (here)    restore Win window layout
 *   7. (caller)  capture screenshot
 *   8. (here)    filter to meaningful + visible elements
 *   9. (here)    rank into 9a text list + 9b circle list (via score.ts)
 *  10. (here)    truncate per caps
 *  11. (caller)  composite ruler + SoM + cursor overlays
 *  12. (caller)  restore axiomate
 *  13. (caller)  build model-facing payload via buildTextFirstSoMBlock
 *
 * Caller-owned steps live in the screenshot handlers because they are
 * tangled with screenshot timing + overlay composition.
 */
import type { ComputerExecutor, BulkEnumerationResult } from "../executor.js";
import type { Mark } from "../clickTarget.js";
import type {
  BrowserViewportHint,
  CandidateWindow,
  PipelineConfig,
  PipelineElement,
  Rect,
} from "./types.js";
import { DEFAULT_PIPELINE_CONFIG } from "./types.js";
import { filterMeaningfulElements } from "./filter.js";
import { classifyRole, scoreElement } from "./score.js";

export { DEFAULT_PIPELINE_CONFIG } from "./types.js";
export type {
  BrowserViewportHint,
  CandidateWindow,
  PipelineConfig,
  Rect,
} from "./types.js";

type Logger = {
  debug?: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

interface VisibleWindowBaseline {
  appIdentifier: string;
  displayName: string;
  hwnd?: number;
  rect: Rect;
  zRank: number;
  isForeground: boolean;
  isHost?: boolean;
  isSystemChrome?: boolean;
}

interface MacWindowBaseline {
  windowId: number;
  appIdentifier: string;
  displayName: string;
  rect: Rect;
  layer: number;
  zRank: number;
}

/**
 * Step 2 — list visible windows, filter to enumerable ones.
 *
 * Drops: host windows, zero-size + tiny phantom rects (<8x8). Minimized
 * + cloaked + off-screen windows are filtered upstream by the native
 * layer:
 *   - Win NAPI's `list_visible_windows` enum proc rejects `!IsWindowVisible`
 *     / `IsIconic` / `DwmGetWindowAttribute(DWMWA_CLOAKED)` before the
 *     window ever crosses the napi boundary.
 *   - Mac uses CGWindowList with `kCGWindowListOptionOnScreenOnly`, which
 *     by definition excludes minimized + occluded-off-screen windows.
 *
 * So the TS filter here only catches edge cases: zero-rect ghosts, and
 * tiny phantom (1×1, 4×4) windows that some apps create for accessibility
 * sentinels and that the platform filters don't catch.
 */
const MIN_USABLE_WINDOW_SIZE = 8;

export async function buildWindowBaseline(
  executor: ComputerExecutor,
): Promise<{ win: VisibleWindowBaseline[]; mac: MacWindowBaseline[] }> {
  const platform = executor.capabilities.platform;
  if (platform === "win32") {
    const raw = (await executor.listVisibleWindows?.()) ?? [];
    const filtered = raw.filter(
      (w) =>
        w.isHost !== true &&
        w.rect.w >= MIN_USABLE_WINDOW_SIZE &&
        w.rect.h >= MIN_USABLE_WINDOW_SIZE,
    );
    return { win: filtered, mac: [] };
  }
  if (platform === "darwin") {
    const raw = (await executor.listVisibleMacWindows?.()) ?? [];
    const filtered = raw.filter(
      (w) =>
        w.rect.w >= MIN_USABLE_WINDOW_SIZE &&
        w.rect.h >= MIN_USABLE_WINDOW_SIZE,
    );
    return { win: [], mac: filtered };
  }
  return { win: [], mac: [] };
}

/**
 * Step 3 helper — compute occlusion-clipped visible rects for a window
 * against everything in front of it (lower zRank = more frontward).
 *
 * Same algorithm as the existing `visibleRegionsForWindow` in toolCalls.ts
 * — repeated here so the pipeline doesn't need a circular import. Pure
 * geometry, no platform branches.
 */
export function computeVisibleRects(
  target: { rect: Rect; zRank: number },
  all: Array<{ rect: Rect; zRank: number }>,
): Rect[] {
  let regions: Rect[] = [target.rect];
  for (const other of all) {
    if (other.zRank >= target.zRank) continue;
    regions = subtractRect(regions, other.rect);
    if (regions.length === 0) break;
  }
  return regions;
}

/**
 * Step 6 — re-query listVisibleWindows AFTER probe + z-order restore, then
 * recompute each candidate's occlusion-clipped `visibleRects` using the
 * post-restore window layout.
 *
 * Why this matters: `selectCandidates` (step 4) builds `visibleRects` from
 * the baseline BEFORE bulkEnumerate's per-app focus probe. After the probe
 * ran and z-order was restored, DWM may have settled slightly different
 * geometry (animation tail, fade-in/out compositing). Step 8 (filter)
 * tests element centers against `visibleRects` to drop occluded elements;
 * if those rects reference the pre-probe layout, occluded elements at the
 * new boundaries can leak through.
 *
 * Match strategy: pair refreshed windows by (hwnd | windowId, appIdentifier).
 * If a candidate window has disappeared (closed during probe), its refreshed
 * `visibleRects` becomes empty — step 8 then drops all its elements.
 *
 * Best-effort: if `listVisibleWindows` errors, we return the original
 * candidates unchanged rather than wiping them out.
 */
export async function refreshVisibleRectsAfterRestore(
  executor: ComputerExecutor,
  candidates: CandidateWindow[],
): Promise<CandidateWindow[]> {
  if (candidates.length === 0) return candidates;
  const platform = executor.capabilities.platform;
  let refreshed: Array<{ rect: Rect; zRank: number; matchKey: string }> = [];
  try {
    if (platform === "win32") {
      const after = (await executor.listVisibleWindows?.()) ?? [];
      refreshed = after.map((w) => ({
        rect: w.rect,
        zRank: w.zRank,
        matchKey: `win:${w.hwnd ?? 0}`,
      }));
    } else if (platform === "darwin") {
      const after = (await executor.listVisibleMacWindows?.()) ?? [];
      refreshed = after.map((w) => ({
        rect: w.rect,
        zRank: w.zRank,
        matchKey: `mac:${w.windowId}`,
      }));
    } else {
      return candidates;
    }
  } catch {
    return candidates;
  }

  const keyFor = (c: CandidateWindow) =>
    platform === "win32" ? `win:${c.windowHandle}` : `mac:${c.macWindowId ?? 0}`;

  return candidates.map((c) => {
    const match = refreshed.find((r) => r.matchKey === keyFor(c));
    if (!match) {
      // Window closed/hidden during probe: empty visibleRects causes
      // filter step 8 to drop every element from this candidate.
      return { ...c, visibleRects: [] };
    }
    const all = refreshed.map((r) => ({ rect: r.rect, zRank: r.zRank }));
    const newRects = computeVisibleRects({ rect: match.rect, zRank: match.zRank }, all);
    return { ...c, rect: match.rect, zRank: match.zRank, visibleRects: newRects };
  });
}

/**
 * Step 4 — pick candidate windows by visible-area within the target rect.
 *
 * `targetRect` is the screenshot rect for handleScreenshot, the zoom
 * region for handleZoom, the window rect for handleScreenshotWindow.
 * `probeCap` limits how many user windows we enumerate. Desktop/taskbar
 * (system chrome) are always included when `includeSystemChrome=true`.
 *
 * On Mac we always include the foreground app — its z-order matches the
 * frontmost window. On Win we include foreground PLUS top-N background
 * candidates ranked by visible area (cursor-owned first as a tie-break).
 */
export function selectCandidates(
  baseline: { win: VisibleWindowBaseline[]; mac: MacWindowBaseline[] },
  targetRect: Rect,
  config: PipelineConfig,
  cursor: { x: number; y: number } | null,
): CandidateWindow[] {
  if (baseline.win.length > 0) {
    return selectWinCandidates(baseline.win, targetRect, config, cursor);
  }
  if (baseline.mac.length > 0) {
    return selectMacCandidates(baseline.mac, targetRect, config, cursor);
  }
  return [];
}

function selectWinCandidates(
  baseline: VisibleWindowBaseline[],
  targetRect: Rect,
  config: PipelineConfig,
  cursor: { x: number; y: number } | null,
): CandidateWindow[] {
  // Enrich every window with occlusion-clipped visible rects.
  const enriched = baseline.map((w) => ({
    w,
    visibleRects: computeVisibleRects(w, baseline),
  }));

  const fitsTarget = (vrs: Rect[]) =>
    vrs.some((r) => rectsIntersect(r, targetRect));

  // Foreground + ranked non-foreground user windows.
  const user = enriched.filter(
    (e) =>
      e.w.isSystemChrome !== true &&
      e.w.rect.w >= 100 &&
      e.w.rect.h >= 100 &&
      fitsTarget(e.visibleRects),
  );

  const ownsCursor = (vrs: Rect[]) => {
    if (!cursor) return false;
    return vrs.some(
      (r) =>
        cursor.x >= r.x &&
        cursor.x < r.x + r.w &&
        cursor.y >= r.y &&
        cursor.y < r.y + r.h,
    );
  };

  user.sort((a, b) => {
    if (a.w.isForeground !== b.w.isForeground) return a.w.isForeground ? -1 : 1;
    const cA = ownsCursor(a.visibleRects);
    const cB = ownsCursor(b.visibleRects);
    if (cA !== cB) return cA ? -1 : 1;
    const areaA = visibleAreaInTarget(a.visibleRects, targetRect);
    const areaB = visibleAreaInTarget(b.visibleRects, targetRect);
    if (areaA !== areaB) return areaB - areaA;
    return a.w.zRank - b.w.zRank;
  });

  const out: CandidateWindow[] = user.slice(0, config.probeCap).map((e) => ({
    windowHandle: e.w.hwnd ?? 0,
    appIdentifier: e.w.appIdentifier,
    displayName: e.w.displayName,
    zRank: e.w.zRank,
    isForeground: e.w.isForeground,
    isSystemChrome: false,
    rect: e.w.rect,
    visibleRects: e.visibleRects,
  }));

  if (config.includeSystemChrome) {
    for (const e of enriched) {
      if (
        e.w.isSystemChrome === true &&
        fitsTarget(e.visibleRects) &&
        !out.some((c) => c.windowHandle === (e.w.hwnd ?? 0))
      ) {
        out.push({
          windowHandle: e.w.hwnd ?? 0,
          appIdentifier: e.w.appIdentifier,
          displayName: e.w.displayName,
          zRank: e.w.zRank,
          isForeground: false,
          isSystemChrome: true,
          rect: e.w.rect,
          visibleRects: e.visibleRects,
        });
      }
    }
  }

  return out;
}

function selectMacCandidates(
  baseline: MacWindowBaseline[],
  targetRect: Rect,
  config: PipelineConfig,
  cursor: { x: number; y: number } | null,
): CandidateWindow[] {
  // Mac doesn't track isForeground / isHost — zRank=0 ≡ foreground by
  // convention. layer > 0 = system chrome (Dock, menu bar).
  const enriched = baseline.map((w) => ({
    w,
    visibleRects: computeVisibleRects(w, baseline),
  }));

  const fitsTarget = (vrs: Rect[]) =>
    vrs.some((r) => rectsIntersect(r, targetRect));
  const ownsCursor = (vrs: Rect[]) => {
    if (!cursor) return false;
    return vrs.some(
      (r) =>
        cursor.x >= r.x &&
        cursor.x < r.x + r.w &&
        cursor.y >= r.y &&
        cursor.y < r.y + r.h,
    );
  };

  const user = enriched.filter(
    (e) =>
      e.w.layer === 0 &&
      e.w.rect.w >= 100 &&
      e.w.rect.h >= 100 &&
      fitsTarget(e.visibleRects),
  );
  user.sort((a, b) => {
    if (a.w.zRank === 0 && b.w.zRank !== 0) return -1;
    if (b.w.zRank === 0 && a.w.zRank !== 0) return 1;
    const cA = ownsCursor(a.visibleRects);
    const cB = ownsCursor(b.visibleRects);
    if (cA !== cB) return cA ? -1 : 1;
    const areaA = visibleAreaInTarget(a.visibleRects, targetRect);
    const areaB = visibleAreaInTarget(b.visibleRects, targetRect);
    if (areaA !== areaB) return areaB - areaA;
    return a.w.zRank - b.w.zRank;
  });

  const out: CandidateWindow[] = user.slice(0, config.probeCap).map((e) => ({
    windowHandle: 0,
    macWindowId: e.w.windowId,
    appIdentifier: e.w.appIdentifier,
    displayName: e.w.displayName,
    zRank: e.w.zRank,
    isForeground: e.w.zRank === 0,
    isSystemChrome: false,
    rect: e.w.rect,
    visibleRects: e.visibleRects,
  }));

  if (config.includeSystemChrome) {
    for (const e of enriched) {
      if (
        e.w.layer > 0 &&
        fitsTarget(e.visibleRects) &&
        !out.some((c) => c.macWindowId === e.w.windowId)
      ) {
        out.push({
          windowHandle: 0,
          macWindowId: e.w.windowId,
          appIdentifier: e.w.appIdentifier,
          displayName: e.w.displayName,
          zRank: e.w.zRank,
          isForeground: false,
          isSystemChrome: true,
          rect: e.w.rect,
          visibleRects: e.visibleRects,
        });
      }
    }
  }

  return out;
}

/**
 * Step 5 — bulk-pull each candidate.
 *
 * Win: requires temporary foreground via `focusNonHostWindowAtPoint` so
 * UIA providers serve up fresh data (per Phase 1 verification). The
 * caller is responsible for `restoreWinVisibleWindowOrder` after this
 * returns — pass `touched` to track which apps got foregrounded.
 *
 * Mac: AX doesn't need foreground; this just iterates candidates and
 * calls the bulk napi.
 *
 * Returns flattened `PipelineElement[]` (window index threaded onto each)
 * plus all `browserViewports` accumulated across candidates.
 */
export async function bulkEnumerate(
  executor: ComputerExecutor,
  candidates: CandidateWindow[],
  config: PipelineConfig,
  touchedAppIdentifiers: Set<string>,
  logger: Logger,
): Promise<{
  elements: PipelineElement[];
  browserViewports: Rect[];
  candidateTimings: Array<{ displayName: string; elapsedMs: number; truncated: boolean; count: number }>;
}> {
  const platform = executor.capabilities.platform;
  const allElements: PipelineElement[] = [];
  const allViewports: Rect[] = [];
  const timings: Array<{ displayName: string; elapsedMs: number; truncated: boolean; count: number }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    let bulk: BulkEnumerationResult | null = null;

    if (platform === "win32" && c.windowHandle !== 0) {
      if (!c.isSystemChrome && executor.focusNonHostWindowAtPoint) {
        // Pick a point inside one of this window's visible rects.
        const probePoint =
          c.visibleRects.length > 0
            ? {
                x: Math.round(c.visibleRects[0]!.x + c.visibleRects[0]!.w / 2),
                y: Math.round(c.visibleRects[0]!.y + c.visibleRects[0]!.h / 2),
              }
            : {
                x: Math.round(c.rect.x + c.rect.w / 2),
                y: Math.round(c.rect.y + c.rect.h / 2),
              };
        try {
          await executor.focusNonHostWindowAtPoint(probePoint);
          await sleep(config.winFocusSettleMs);
          touchedAppIdentifiers.add(c.appIdentifier);
        } catch (e) {
          logger.debug?.(
            `[pipeline] focusNonHostWindowAtPoint failed for ${c.displayName}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      try {
        bulk = await executor.enumerateUiElementsBulkForWindow?.(c.windowHandle) ?? null;
      } catch (e) {
        logger.debug?.(
          `[pipeline] bulkForWindow failed for ${c.displayName}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    } else if (platform === "darwin") {
      try {
        if (c.macWindowId !== undefined && executor.enumerateUiElementsBulkForMacWindow) {
          bulk = await executor.enumerateUiElementsBulkForMacWindow(
            c.macWindowId,
            c.appIdentifier,
          );
        } else if (executor.enumerateUiElementsBulkForApp) {
          bulk = await executor.enumerateUiElementsBulkForApp(c.appIdentifier);
        }
      } catch (e) {
        logger.debug?.(
          `[pipeline] bulk mac failed for ${c.displayName}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    if (!bulk) {
      timings.push({
        displayName: c.displayName,
        elapsedMs: 0,
        truncated: false,
        count: 0,
      });
      continue;
    }

    for (const v of bulk.browserViewportBboxes) {
      allViewports.push(v);
    }

    let kept = 0;
    for (const e of bulk.elements) {
      const cx = Math.round(e.bbox.x + e.bbox.w / 2);
      const cy = Math.round(e.bbox.y + e.bbox.h / 2);
      allElements.push({
        ...e,
        windowIndex: i,
        centerX: cx,
        centerY: cy,
      });
      kept++;
    }
    timings.push({
      displayName: c.displayName,
      elapsedMs: bulk.elapsedMs,
      truncated: bulk.truncatedByWalltime,
      count: kept,
    });
    logger.debug?.(
      `[pipeline] bulk ${c.displayName} elements=${kept} viewports=${bulk.browserViewportBboxes.length} elapsed=${bulk.elapsedMs}ms truncated=${bulk.truncatedByWalltime}`,
    );
  }

  return { elements: allElements, browserViewports: allViewports, candidateTimings: timings };
}

/**
 * Steps 8 + 9 — filter to meaningful elements, score, and convert to
 * `Mark[]` ranked by score (highest first). The returned marks have
 * sequential IDs starting at 1 in score order. Step 10 (truncation)
 * is the caller's responsibility — it knows the textSomCap and the
 * circle cap.
 */
export function filterAndScoreToMarks(
  elements: PipelineElement[],
  candidates: CandidateWindow[],
  region: Rect,
  cursor: { x: number; y: number } | null,
  browserViewports: Rect[],
): {
  marks: Mark[];
  browserViewports: BrowserViewportHint[];
} {
  // Group elements by candidate so per-window visibleRects filtering
  // applies correctly.
  const byWindow = new Map<number, PipelineElement[]>();
  for (const el of elements) {
    const arr = byWindow.get(el.windowIndex) ?? [];
    arr.push(el);
    byWindow.set(el.windowIndex, arr);
  }

  const kept: PipelineElement[] = [];
  for (const [windowIndex, list] of byWindow) {
    const cand = candidates[windowIndex];
    if (!cand) continue;
    const filtered = filterMeaningfulElements(list, {
      region,
      visibleRects: cand.visibleRects,
      browserViewports,
    });
    for (const e of filtered) kept.push(e);
  }

  // Score + sort.
  const foregroundWindowIndex = candidates.findIndex((c) => c.isForeground);
  const scored = kept
    .map((el) => ({ el, score: scoreElement(el, { region, cursor, foregroundWindowIndex }) }))
    .sort((a, b) => b.score - a.score);

  // Deduplicate by (bbox center, role bucket) — Win can return multiple
  // wrappers around the same control; the first (highest-scored) wins.
  const seen = new Set<string>();
  const marks: Mark[] = [];
  for (const { el } of scored) {
    const { bucket } = classifyRole(el.role, el.subrole);
    const key = `${bucket}|${Math.round(el.centerX / 4)}|${Math.round(el.centerY / 4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = candidates[el.windowIndex];
    marks.push({
      id: marks.length + 1,
      x: el.centerX,
      y: el.centerY,
      name: el.name,
      role: bucket,
      automationId: el.automationId,
      source: "uia",
      confidence: 1.0,
      uiaSource: cand?.isSystemChrome
        ? cand.appIdentifier.toLowerCase().includes("explorer")
          ? "desktop"
          : "taskbar"
        : "foreground",
      sourceWindowName: cand?.displayName,
    });
  }

  const viewports: BrowserViewportHint[] = browserViewports.map((v) => ({
    bbox: v,
  }));

  return { marks, browserViewports: viewports };
}

// ── helpers ─────────────────────────────────────────────────────────

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const xr = Math.min(a.x + a.w, b.x + b.w);
  const yr = Math.min(a.y + a.h, b.y + b.h);
  if (xr <= x || yr <= y) return null;
  return { x, y, w: xr - x, h: yr - y };
}

/**
 * Subtract `cutter` from every rect in `regions`. Returns the remaining
 * uncovered area split into up-to-4 sub-rects per input (the L-shaped
 * remainder when one rect is partially occluded by another).
 */
function subtractRect(regions: Rect[], cutter: Rect): Rect[] {
  const out: Rect[] = [];
  for (const r of regions) {
    const hit = rectIntersection(r, cutter);
    if (!hit) {
      out.push(r);
      continue;
    }
    if (hit.x === r.x && hit.y === r.y && hit.w === r.w && hit.h === r.h) {
      // Fully covered — nothing left.
      continue;
    }
    // Top strip
    if (hit.y > r.y) {
      out.push({ x: r.x, y: r.y, w: r.w, h: hit.y - r.y });
    }
    // Bottom strip
    if (hit.y + hit.h < r.y + r.h) {
      out.push({
        x: r.x,
        y: hit.y + hit.h,
        w: r.w,
        h: r.y + r.h - (hit.y + hit.h),
      });
    }
    // Left strip
    if (hit.x > r.x) {
      out.push({ x: r.x, y: hit.y, w: hit.x - r.x, h: hit.h });
    }
    // Right strip
    if (hit.x + hit.w < r.x + r.w) {
      out.push({
        x: hit.x + hit.w,
        y: hit.y,
        w: r.x + r.w - (hit.x + hit.w),
        h: hit.h,
      });
    }
  }
  return out;
}

function visibleAreaInTarget(visibleRects: Rect[], target: Rect): number {
  let total = 0;
  for (const r of visibleRects) {
    const hit = rectIntersection(r, target);
    if (hit) total += hit.w * hit.h;
  }
  return total;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
