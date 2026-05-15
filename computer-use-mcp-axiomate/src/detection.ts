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
  /** Which UIA source produced this element: "taskbar", "desktop", "foreground". */
  uiaSource?: string;
}

export interface DetectionStats {
  traversedCount: number;
  matchedCount: number;
  returnedCount: number;
  truncated: boolean;
  truncationReason?: "traversal_budget" | "output_budget";
}

/**
 * A web-content viewport surfaced by native enumeration (UIA's
 * Chrome_RenderWidgetHostHWND / MozillaWindowClass, mac's AXWebArea) but
 * intentionally NOT a clickable Mark — page-content interaction belongs
 * to the CDP-backed browser bridge. The bbox tells the model where the
 * page is on screen so it can route to `browser_attach` / `browser_snapshot`.
 */
export interface BrowserViewport {
  bbox: { x: number; y: number; w: number; h: number };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}


/**
 * Detection sources for the SoM overlay. UIAutomation is wired today; the
 * remaining entries are placeholders for future structured sources.
 * When additional sources land, they should merge here via
 * dedup-by-IoU + confidence aggregation inside `detectElementsMultiSource`.
 */
export type DetectionSource = "uia" | "grounder" | "ocr";

export interface SoMSummaryTile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  sampleNames: string[];
  roleCounts: Array<{ role: string; count: number }>;
}

export interface SoMSummary {
  totalCount: number;
  shownCount: number;
  hiddenCount: number;
  roleCounts: Array<{ role: string; count: number }>;
  queryHits: Mark[];
  tiles: SoMSummaryTile[];
}


export function summarizeMarks(
  marks: Mark[],
  rect: Rect,
  opts?: {
    shownCount?: number;
    query?: string;
  },
): SoMSummary {
  const shownCount = Math.max(0, Math.min(opts?.shownCount ?? marks.length, marks.length));
  const hiddenCount = Math.max(0, marks.length - shownCount);
  const q = (opts?.query ?? "").trim().toLowerCase();

  const roleMap = new Map<string, number>();
  for (const mark of marks) {
    const role = (mark.role || "Unknown").trim() || "Unknown";
    roleMap.set(role, (roleMap.get(role) ?? 0) + 1);
  }
  const roleCounts = [...roleMap.entries()]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));

  const queryHits = q
    ? marks.filter(mark => {
        const hay = `${mark.name ?? ""} ${mark.role ?? ""} ${mark.automationId ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
    : [];

  const tiles = buildAdaptiveTiles(rect, marks);

  return {
    totalCount: marks.length,
    shownCount,
    hiddenCount,
    roleCounts,
    queryHits,
    tiles,
  };
}

function buildAdaptiveTiles(rect: Rect, marks: Mark[]): SoMSummaryTile[] {
  if (marks.length === 0) return [];

  const aspect = rect.h > 0 ? rect.w / rect.h : 1;
  const tileDefs =
    marks.length > 120
      ? aspect >= 1.6
        ? { cols: 3, rows: 2 }
        : aspect <= 0.625
          ? { cols: 2, rows: 3 }
          : { cols: 3, rows: 3 }
      : aspect >= 1.8
        ? { cols: 3, rows: 1 }
        : aspect <= 0.56
          ? { cols: 1, rows: 3 }
          : { cols: 2, rows: 2 };

  const { cols, rows } = tileDefs;
  const tileW = Math.max(1, Math.ceil(rect.w / cols));
  const tileH = Math.max(1, Math.ceil(rect.h / rows));
  const out: SoMSummaryTile[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = rect.x + col * tileW;
      const y = rect.y + row * tileH;
      const w = col === cols - 1 ? rect.x + rect.w - x : tileW;
      const h = row === rows - 1 ? rect.y + rect.h - y : tileH;
      const inTile = marks.filter(mark =>
        mark.x >= x &&
        mark.y >= y &&
        mark.x < x + w &&
        mark.y < y + h,
      );
      if (inTile.length === 0) continue;

      const roleMap = new Map<string, number>();
      for (const mark of inTile) {
        const role = (mark.role || "Unknown").trim() || "Unknown";
        roleMap.set(role, (roleMap.get(role) ?? 0) + 1);
      }
      const roleCounts = [...roleMap.entries()]
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role))
        .slice(0, 3);

      const sampleNames = inTile
        .map(mark => mark.name?.trim())
        .filter((name): name is string => !!name)
        .slice(0, 3);

      out.push({
        id: tileId(col, row, cols),
        x,
        y,
        w,
        h,
        count: inTile.length,
        sampleNames,
        roleCounts,
      });
    }
  }

  return out.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function tileId(col: number, row: number, cols: number): string {
  const idx = row * cols + col;
  return `T${idx + 1}`;
}

/**
 * Maximum number of SoM red circles to overlay (fallback). Returns 0
 * only when there are no elements. The text-SoM list cap (TEXT_SOM_CAP
 * in toolCalls.ts) is independent and much larger (200) — circle and
 * text caps are decoupled by design; circles must stay visually sparse,
 * the text list can carry every interactable.
 */
const OVERLAY_LIMIT = 20;

export function overlaySoMLimit(marks: Mark[]): number {
  return Math.min(marks.length, OVERLAY_LIMIT);
}

/**
 * Compute a dynamic cap for the on-image circle overlay based on image
 * area. Scales like ruler spacing does — sparse for full-screen,
 * packed-in for small zooms. Target density: ~1 circle per 220×220
 * image-pixel tile (≈ 48400 px²). At 1920×1080 this yields ~43 circles;
 * at 400×400 zoom it yields ~3 which the clamp raises to 5.
 *
 * Clamped to [MIN_CIRCLES, MAX_CIRCLES] so tiny zoom regions still
 * show a handful of candidates and large multi-monitor captures don't
 * become unreadable.
 *
 * Independent of the text-SoM list cap (TEXT_SOM_CAP in toolCalls.ts,
 * currently 200): circles must stay sparse because visual density
 * beyond ~50 numbered tiles is unreadable, but the text list has no
 * such constraint. Mark IDs are shared across both views, so any
 * circled id is also in the text list — but text-listed ids may have
 * no circle. Models look up id → metadata via text, not via the image.
 */
const MIN_CIRCLES = 5;
const MAX_CIRCLES = 50;
const TARGET_CIRCLE_TILE_PX = 220;

export function computeDynamicOverlayCap(imageW: number, imageH: number): number {
  if (imageW <= 0 || imageH <= 0) return MIN_CIRCLES;
  const tileArea = TARGET_CIRCLE_TILE_PX * TARGET_CIRCLE_TILE_PX;
  const raw = Math.round((imageW * imageH) / tileArea);
  return Math.max(MIN_CIRCLES, Math.min(MAX_CIRCLES, raw));
}

/**
 * Farthest-point spatial sampling. Produces a subset of size ≤ `cap`
 * whose members are spread out on the image plane. The FIRST mark in
 * `marks` (which is typically the highest-priority element from the
 * UIA walk — e.g. foreground focused control) is always included; each
 * subsequent pick maximizes min-distance to the already-picked set.
 *
 * Returns marks in picked-order, not input-order. Callers that care
 * about stable id↔text-list pairing should re-sort by id after
 * sampling.
 *
 * Complexity: O(cap × n). `cap` is tiny (≤ 50) and `n` is typically
 * a few hundred, so this stays well under 10k comparisons per call.
 */
export function selectSpatiallyDistributedMarks(marks: Mark[], cap: number): Mark[] {
  if (cap <= 0 || marks.length === 0) return [];
  if (marks.length <= cap) return marks;
  const picked: Mark[] = [marks[0]!];
  const remaining: Mark[] = marks.slice(1);
  while (picked.length < cap && remaining.length > 0) {
    let bestIdx = 0;
    let bestMinDistSq = -1;
    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i]!;
      let minDistSq = Infinity;
      for (const p of picked) {
        const dx = m.x - p.x;
        const dy = m.y - p.y;
        const d = dx * dx + dy * dy;
        if (d < minDistSq) minDistSq = d;
        if (minDistSq <= bestMinDistSq) break;
      }
      if (minDistSq > bestMinDistSq) {
        bestMinDistSq = minDistSq;
        bestIdx = i;
      }
    }
    picked.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return picked;
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
