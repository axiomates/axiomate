/**
 * Phase 1.5 step 8 — filter to meaningful + visible elements.
 *
 * Input: raw bulk-pull elements from one candidate window plus the
 * candidate's occlusion-clipped visible rects and the target region.
 * Output: elements that survive every drop rule. No ordering applied
 * here — that's step 9's job (`score.ts`).
 */
import type { PipelineElement, Rect } from "./types.js";
import { classifyRole, isNameUseful } from "./score.js";

export interface FilterContext {
  /** Target region — screenshot rect or zoom region in physical pixels. */
  region: Rect;
  /** Per-candidate post-restore visible rects (occlusion-clipped). */
  visibleRects: Rect[];
}

export function filterMeaningfulElements(
  elements: PipelineElement[],
  ctx: FilterContext,
): PipelineElement[] {
  const out: PipelineElement[] = [];
  for (const el of elements) {
    if (!shouldKeep(el, ctx)) continue;
    out.push(el);
  }
  return out;
}

function shouldKeep(el: PipelineElement, ctx: FilterContext): boolean {
  // Drop: degenerate bbox.
  if (el.bbox.w <= 0 || el.bbox.h <= 0) return false;

  // Drop: explicitly off-screen / hidden per platform.
  if (el.isOffscreen) return false;
  if (el.hidden === true) return false;

  // Drop: bbox does not intersect the target region.
  if (!rectsIntersect(el.bbox, ctx.region)) return false;

  // Drop: element center is in an occluded area (no visible rect of
  // its candidate window covers it). visibleRects may be empty when
  // we don't have occlusion data — skip the test then.
  if (ctx.visibleRects.length > 0) {
    if (!pointInAnyRect(el.centerX, el.centerY, ctx.visibleRects)) {
      return false;
    }
  }

  // Browser web-content elements ARE kept now. Previously we dropped
  // every element whose center fell inside a BrowserViewport rect on
  // the theory that page interaction belongs to the CDP bridge. But
  // the bridge attaches to a SEPARATE isolated Chrome — it can't see
  // the user's real Chrome. If the user is actively reading or
  // operating a page in their own browser, dropping its elements
  // leaves the model with nothing actionable. UIA/AX exposure of
  // Chromium is sparse and noisy, but partial coverage is strictly
  // better than no coverage. The routing hint still tells the model
  // it can use browser_attach for cleaner snapshots when that fits.

  // Drop: BrowserViewport sentinel rows themselves — they're not
  // clickable elements. The viewport rects are still surfaced
  // separately via the SoM block's routing hint.
  if (el.role === "BrowserViewport") return false;

  // Role-based decision.
  const { bucket, isActionable, isContainer } = classifyRole(el.role, el.subrole);

  if (isActionable) {
    return true;
  }
  if (isContainer) {
    // Container kept ONLY if it has a useful name (provides semantic
    // grouping context the model can read in the SoM list).
    return isNameUseful(el.name, bucket);
  }
  // Everything else (Text, Image, Custom, Unknown): keep when it has a
  // useful name. Pure-decoration nameless static text is noise.
  return isNameUseful(el.name, bucket);
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function pointInAnyRect(x: number, y: number, rects: Rect[]): boolean {
  for (const r of rects) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  }
  return false;
}
