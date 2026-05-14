/**
 * Phase 1.5 enumeration pipeline — shared types.
 *
 * The pipeline takes raw `BulkUiElement[]` from one or more candidate
 * windows (via the executor's `enumerateUiElementsBulkFor*` methods) and
 * produces the model-facing artifacts: text SoM list, circle overlay
 * positions, browser-viewport hints. See `pipeline.ts` for the 13-step
 * sequence.
 */
import type { BulkUiElement } from "../executor.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One candidate window slated for bulk enumeration. Built by step 4
 * (`selectCandidates`) from the post-hide visible-windows baseline.
 *
 * `visibleRects` are the occlusion-clipped sub-rects of this window
 * that fall inside the target region (screenshot rect / zoom rect).
 * Used by step 8 to drop elements that fall in occluded areas.
 */
export interface CandidateWindow {
  /** Win HWND or, on Mac, the CGWindowID. 0 if unknown. */
  windowHandle: number;
  /** Bundle id (Mac) or full exe path (Win). */
  appIdentifier: string;
  displayName: string;
  zRank: number;
  isForeground: boolean;
  isSystemChrome: boolean;
  rect: Rect;
  visibleRects: Rect[];
  /**
   * On macOS, set when the candidate identifies a specific window of
   * an app (CGWindowID). On Windows always undefined; the HWND is
   * already the precise root.
   */
  macWindowId?: number;
}

/**
 * One element after bulk pull, with two pieces of post-bulk metadata
 * threaded onto it for the filter / score steps.
 */
export interface PipelineElement extends BulkUiElement {
  /** Index of the candidate window this element came from. */
  windowIndex: number;
  /** Cached: element's bbox center, used by score + spatial sampling. */
  centerX: number;
  centerY: number;
}

/**
 * Web-content viewport rect surfaced by native Phase 1 prune (Win
 * RawView Document, Mac AXWebArea). Surfaced to the model as a hint
 * rather than a clickable mark.
 */
export interface BrowserViewportHint {
  bbox: Rect;
}

/**
 * Cursor + active-locate target — drawn on top of any overlay regardless
 * of whether they're inside any element. Pipeline step 11.
 */
export interface CursorOverlay {
  x: number;
  y: number;
  /** True when an active vision_locate session is running; renderer
   *  draws the lime-green confirmation ring. */
  showLocateRing: boolean;
}

/**
 * Pipeline configuration — caps + thresholds. All overridable by the
 * caller (handleScreenshot / handleZoom / handleScreenshotWindow).
 */
export interface PipelineConfig {
  /** Text SoM list cap (default 200). */
  textSomCap: number;
  /** Probe candidate cap (default 4). */
  probeCap: number;
  /** Per-candidate hide-then-foreground sleep (Win only, default 150ms). */
  winFocusSettleMs: number;
  /** Settle DWM compose after restore (Win only, default 80ms). */
  winRestoreSettleMs: number;
  /** Whether to include the desktop / taskbar as candidates. */
  includeSystemChrome: boolean;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  textSomCap: 200,
  probeCap: 4,
  winFocusSettleMs: 150,
  winRestoreSettleMs: 80,
  includeSystemChrome: true,
};
