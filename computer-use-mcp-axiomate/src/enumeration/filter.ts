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
  /** Browser web-content viewport rects from bulk pull's pre-scan.
   *  Elements whose bbox sits inside any of these are dropped — page
   *  content goes through the browser bridge, not click_target. */
  browserViewports: Rect[];
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

  // Drop: element sits inside a browser web-content viewport. Routing
  // hint exists separately; page content belongs to the browser bridge.
  if (ctx.browserViewports.length > 0) {
    for (const vp of ctx.browserViewports) {
      if (rectContainsCenter(vp, el)) {
        return false;
      }
    }
  }

  // Drop: BrowserViewport sentinels themselves — they're not clickable.
  // The pipeline surfaces them via `browserViewports` to the model
  // through a dedicated text-block hint, not via the SoM mark list.
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

function rectContainsCenter(outer: Rect, el: PipelineElement): boolean {
  return (
    el.centerX >= outer.x &&
    el.centerX < outer.x + outer.w &&
    el.centerY >= outer.y &&
    el.centerY < outer.y + outer.h
  );
}
