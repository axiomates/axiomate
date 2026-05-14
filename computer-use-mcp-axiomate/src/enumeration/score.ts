/**
 * Phase 1.5 step 9 — element scoring.
 *
 * Fixed dynamic formula. Input: one `PipelineElement` + the target region
 * + optional cursor position. Output: an integer score. Higher = more
 * salient. Used to sort elements before truncation to TEXT_SOM_CAP.
 *
 * Derived from the previous in-walker `score_element_shallow` (Win) and
 * its Mac analog, then promoted to TS so heuristics are tunable without
 * a native rebuild.
 */
import type { PipelineElement, Rect } from "./types.js";

/**
 * Win/Mac role normalization to a single bucket family. Mac AX roles
 * ("AXButton") get short-form mapped; Win UIA roles ("Button") pass
 * through verbatim. Returns the bucket plus an `isActionable` flag so
 * the scorer doesn't have to re-classify.
 */
export function classifyRole(
  role: string,
  subrole?: string,
): { bucket: string; isActionable: boolean; isContainer: boolean } {
  const r = role.startsWith("AX") ? axRoleToShort(role, subrole) : role;
  const actionable = ACTIONABLE_BUCKETS.has(r);
  const container = CONTAINER_BUCKETS.has(r);
  return { bucket: r, isActionable: actionable, isContainer: container };
}

function axRoleToShort(role: string, subrole?: string): string {
  // Mirrors mac napi's ax_role_to_short, plus subrole disambiguation.
  if (subrole === "AXCloseButton") return "Button";
  if (subrole === "AXMinimizeButton") return "Button";
  if (subrole === "AXZoomButton") return "Button";
  if (subrole === "AXFullScreenButton") return "Button";
  if (subrole === "AXSearchField") return "Edit";
  if (subrole === "AXSecureTextField") return "Edit";
  switch (role) {
    case "AXButton":
    case "AXPopUpButton":
    case "AXDisclosureTriangle":
    case "AXMenuButton":
    case "AXDockItem":
      return "Button";
    case "AXTextField":
    case "AXTextArea":
      return "Edit";
    case "AXCheckBox":
      return "CheckBox";
    case "AXRadioButton":
      return "RadioButton";
    case "AXLink":
      return "Hyperlink";
    case "AXMenuItem":
    case "AXMenuBarItem":
      return "MenuItem";
    case "AXTabButton":
      return "TabItem";
    case "AXStaticText":
      return "Text";
    case "AXImage":
      return "Image";
    case "AXList":
      return "List";
    case "AXRow":
    case "AXCell":
      return "ListItem";
    case "AXScrollBar":
      return "ScrollBar";
    case "AXSlider":
      return "Slider";
    case "AXOutline":
    case "AXBrowser":
      return "Tree";
    case "AXGroup":
    case "AXScrollArea":
    case "AXSplitGroup":
    case "AXToolbar":
      return "Group";
    case "AXWindow":
      return "Window";
    default:
      return "Unknown";
  }
}

const ACTIONABLE_BUCKETS = new Set([
  "Button",
  "Edit",
  "Hyperlink",
  "MenuItem",
  "TabItem",
  "CheckBox",
  "RadioButton",
  "ComboBox",
  "Slider",
  "SplitButton",
  "TreeItem",
  "ListItem",
]);

const CONTAINER_BUCKETS = new Set([
  "Window",
  "Pane",
  "Group",
  "Document",
  "TitleBar",
  "AppBar",
  "MenuBar",
  "Separator",
  "SemanticZoom",
  "Tree",
  "Table",
  "DataGrid",
  "List",
  "Menu",
  "Tab",
  "StatusBar",
  "ToolBar",
]);

/** True when `name` is genuine semantic signal (not just role echo). */
export function isNameUseful(name: string, bucket: string): boolean {
  if (!name) return bucket === "Edit"; // empty editable field is OK
  const lower = name.trim().toLowerCase();
  if (lower.length === 0) return false;
  return !(
    lower === "image" ||
    lower === "group" ||
    lower === "toolbar" ||
    lower === "window" ||
    lower === "application" ||
    lower === "pane" ||
    lower === "document" ||
    lower === "container"
  );
}

export interface ScoreContext {
  region: Rect;
  cursor: { x: number; y: number } | null;
  /** Index of the foreground app in the candidate list (or -1). */
  foregroundWindowIndex: number;
}

/**
 * The fixed scoring formula. Higher = more salient.
 *
 * Composition:
 *   role          actionable: +200, container: +20, other: +80
 *   name bonus    +20 when name is useful
 *   region        intersects: +40, center inside: +25 more
 *   cursor        up to +30 with linear falloff over 200px
 *   foreground    +50 when the element's window is foreground
 *   depth         -8 per level (deeper = less salient)
 *   penalties     -120 for container >90% of region, -50 for <8x8
 */
export function scoreElement(el: PipelineElement, ctx: ScoreContext): number {
  const { bucket, isActionable, isContainer } = classifyRole(el.role, el.subrole);
  let score = 0;

  if (isActionable) score += 200;
  else if (isContainer) score += 20;
  else score += 80;

  if (isNameUseful(el.name, bucket)) score += 20;

  if (rectsIntersect(el.bbox, ctx.region)) {
    score += 40;
  } else {
    score -= 80;
  }
  if (pointInRect(el.centerX, el.centerY, ctx.region)) {
    score += 25;
  }

  if (ctx.cursor) {
    const dx = el.centerX - ctx.cursor.x;
    const dy = el.centerY - ctx.cursor.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const FALLOFF = 200;
    if (dist < FALLOFF) {
      score += Math.round(30 * (1 - dist / FALLOFF));
    }
  }

  if (
    ctx.foregroundWindowIndex >= 0 &&
    el.windowIndex === ctx.foregroundWindowIndex
  ) {
    score += 50;
  }

  score -= Math.min(el.depth, 30) * 8;

  // Whole-region container penalty: only for actual container roles. A
  // Button that fills the screen is genuine signal and shouldn't get
  // penalized.
  const bboxArea = Math.max(0, el.bbox.w) * Math.max(0, el.bbox.h);
  const regionArea = Math.max(1, ctx.region.w) * Math.max(1, ctx.region.h);
  if (isContainer && bboxArea > regionArea * 0.9) {
    score -= 120;
  }

  if (el.bbox.w > 0 && el.bbox.h > 0 && el.bbox.w < 8 && el.bbox.h < 8) {
    score -= 50;
  }

  return score;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
