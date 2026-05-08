/**
 * UI element detection for SoM (Set of Marks) overlay.
 *
 * DetectedElement represents a UI element found by UIAutomation within a
 * screen region. SoM only draws numbered markers — semantic understanding
 * is left to the VL model.
 */
import type { ComputerExecutor } from "./executor.js";
import type { Mark } from "./clickTarget.js";

export interface DetectedElement {
  id: number;
  bbox: { x: number; y: number; w: number; h: number };
  center: { x: number; y: number };
  /** UIAutomation raw Name property — internal/debug only, not shown to VL. */
  rawName: string;
  /** UIAutomation ControlType (Button, Edit, MenuItem, ...). */
  role?: string;
  automationId?: string;
  /** True for taskbar & desktop icon elements (system chrome). */
  isSystemChrome?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Detect interactable UI elements within a screen region via UIAutomation.
 * Coordinates are in the same virtual coordinate space as the screenshot rulers.
 *
 * The executor's `enumerateVisibleElements` returns raw physical-coordinate
 * elements; this function converts them to virtual coordinates using the
 * same ratio as scaleCoord (displayWidth/imageWidth).
 */
export async function detectElementsInRect(
  executor: ComputerExecutor,
  rect: Rect,
  virtualToPhysical: { ratioX: number; ratioY: number; originX: number; originY: number; windowOnly?: boolean },
): Promise<DetectedElement[]> {
  if (!executor.enumerateVisibleElements) return [];

  // Convert virtual rect → physical rect for UIAutomation query
  const physRect = {
    x: rect.x * virtualToPhysical.ratioX + virtualToPhysical.originX,
    y: rect.y * virtualToPhysical.ratioY + virtualToPhysical.originY,
    w: rect.w * virtualToPhysical.ratioX,
    h: rect.h * virtualToPhysical.ratioY,
  };

  const rawElements = await executor.enumerateVisibleElements(physRect, virtualToPhysical.windowOnly);

  return rawElements.map((el, i) => {
    // Physical → virtual coordinates (inverse of scaleCoord)
    const vx = (el.bbox.x - virtualToPhysical.originX) / virtualToPhysical.ratioX;
    const vy = (el.bbox.y - virtualToPhysical.originY) / virtualToPhysical.ratioY;
    const vw = el.bbox.w / virtualToPhysical.ratioX;
    const vh = el.bbox.h / virtualToPhysical.ratioY;

    return {
      id: i + 1,
      bbox: { x: Math.round(vx), y: Math.round(vy), w: Math.round(vw), h: Math.round(vh) },
      center: { x: Math.round(vx + vw / 2), y: Math.round(vy + vh / 2) },
      rawName: el.name ?? "",
      role: el.role,
      automationId: el.automationId,
      isSystemChrome: el.isSystemChrome ?? false,
    };
  });
}

/**
 * Detection sources for the SoM overlay. UIAutomation is wired today; the
 * other three are placeholders for the future multi-modal detection
 * pipeline (YOLO for icons, GroundingDINO for natural-language queries,
 * OCR for text labels). Each future source will run in parallel with UIA
 * and have its results merged via dedup-by-IoU + confidence aggregation
 * inside `detectElementsMultiSource`.
 */
export type DetectionSource = "uia" | "yolo" | "grounder" | "ocr";

/**
 * Multi-source SoM detector. Today only `uia` is wired — the executor's
 * `enumerateVisibleElements` (Win32 IUIAutomation::FindAll). Other sources
 * are stubbed so the merge structure is in place without forcing the call
 * site to know which sources exist.
 *
 * Returns a flat `Mark[]` ready for direct attachment to
 * `ClickLoopState.marks`. IDs are assigned in-order starting from 1; the
 * mark numbering matches what the renderer draws on the zoomed image so
 * `mouse_move(mark_id: N)` resolution is straightforward.
 *
 * Future merge contract (when yolo/grounder/ocr land): each source produces
 * its own bbox+confidence list; the merger dedups by IoU > 0.5 and aggregates
 * confidence (max across sources, with a small bonus for multi-source agreement).
 * The output `Mark` carries `source` of the highest-confidence contributor.
 */
export async function detectElementsMultiSource(
  executor: ComputerExecutor,
  rect: Rect,
  virtualToPhysical: { ratioX: number; ratioY: number; originX: number; originY: number; windowOnly?: boolean },
  sources: DetectionSource[] = ["uia"],
): Promise<Mark[]> {
  const all: Mark[] = [];
  if (sources.includes("uia")) {
    const uia = await detectElementsInRect(executor, rect, virtualToPhysical);
    for (const el of uia) {
      all.push({
        id: 0, // re-assigned below after merge
        x: el.center.x,
        y: el.center.y,
        name: el.rawName,
        role: el.role ?? "",
        automationId: el.automationId,
        source: "uia",
        confidence: 1.0,
        isSystemChrome: el.isSystemChrome,
      });
    }
  }
  // TODO: yolo / grounder / ocr — call each detector, normalize to the same
  // shape, then run dedup-by-IoU + confidence-aggregate before id assignment.
  return all.map((m, i) => ({ ...m, id: i + 1 }));
}

/**
 * Whether to overlay SoM markers on a zoomed screenshot.
 * System chrome elements (taskbar + desktop icons) don't count toward
 * the ≤25 element limit — they should always get red circles when present
 * in the zoom region, even if many regular elements are also there.
 */
export function shouldOverlaySoM(
  zoomRect: Rect,
  screenW: number,
  screenH: number,
  elementCount: number,
  systemChromeCount = 0,
): boolean {
  const areaRatio =
    (zoomRect.w * zoomRect.h) / (screenW * screenH);
  if (areaRatio > 0.15) return false;
  const nonChromeCount = elementCount - systemChromeCount;
  if (nonChromeCount > 50) return false;
  if (elementCount === 0) return false;
  return true;
}

/**
 * Compute the zoom region rect. Center stays fixed; parts outside the
 * screen boundary are clipped (result may be non-square).
 */
export function computeZoomRect(
  cx: number,
  cy: number,
  size: number,
  screenW: number,
  screenH: number,
): Rect {
  cx = Math.max(0, Math.min(screenW, cx));
  cy = Math.max(0, Math.min(screenH, cy));
  const half = Math.floor(size / 2);
  const x = Math.max(0, cx - half);
  const y = Math.max(0, cy - half);
  const x1 = Math.min(screenW, cx + half);
  const y1 = Math.min(screenH, cy + half);
  return { x, y, w: x1 - x, h: y1 - y };
}

/**
 * Compute ruler tick/label intervals for a given coordinate range,
 * maintaining equivalent visual density to the full-screen rulers
 * (label every ~50 image pixels at 1920px full-screen width).
 */
export function computeRulerIntervals(
  rangeVirtual: number,
  imagePx: number,
): { tick: number; label: number } {
  const rawLabel = (50 * rangeVirtual) / imagePx;
  const label = niceRound(rawLabel);
  const tick = label / 2;
  return { tick, label };
}

const NICE_VALUES = [1, 2, 2.5, 5, 10];

/**
 * Round to nearest "nice" number: one of {1, 2, 2.5, 5} × 10^n.
 * Uses geometric distance (log-ratio) so the comparison is scale-invariant.
 * Extend NICE_VALUES to support finer grids without changing the algorithm.
 */
function niceRound(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / exp;
  let best = NICE_VALUES[0]!;
  let bestDist = Infinity;
  for (const n of NICE_VALUES) {
    const dist = Math.abs(Math.log(frac / n));
    if (dist < bestDist) {
      bestDist = dist;
      best = n;
    }
  }
  return best * exp;
}
