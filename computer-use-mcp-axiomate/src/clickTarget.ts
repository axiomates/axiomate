/**
 * vision_locate — enter guided visual element-locating mode.
 *
 * When called, sets an active locate session and returns a screenshot with
 * guidance. The AI first uses zoom to identify the target precisely, then
 * uses mouse_move + screenshot to position and visually verify the
 * lime-green cursor ring on the target. Once visually confirmed, AI calls
 * `accept()` to snapshot the current cursor coordinates and display id,
 * exiting the loop. Coordinates can then be used with any action tool
 * (left_click, scroll, drag, etc.).
 *
 * The loop injects state-aware guidance into tool responses to help AI
 * maintain attention through the iterative positioning process.
 */

import type { ComputerUseHostAdapter } from "./types.js";
import type { ComputerUseOverrides } from "./types.js";
import { allowedAppsOf } from "./types.js";
import type { CuCallToolResult } from "./toolCalls.js";

function screenshotAllowlist(adapter: ComputerUseHostAdapter, overrides: ComputerUseOverrides): string[] {
  if (adapter.executor.capabilities.platform !== "darwin") return [];
  return allowedAppsOf(overrides).map(a => a.appIdentifier);
}

// ── Locate state (managed by mcpServer.ts session dispatcher) ───────────

/**
 * One SoM (Set-of-Mark) detection result. Stored on `LocateState.marks`
 * after a zoom runs UI-element detection. AI can pass `mark_id: id` to
 * `mouse_move` to jump cursor to (x, y) without estimating pixel positions.
 * Coords are in the same virtual-coord space as the rulers / mouse_move params.
 */
export interface Mark {
  id: number;
  x: number;
  y: number;
  name: string;
  role: string;
  automationId?: string;
  source: "uia";
  confidence: number;
  /** Which UIA source produced this mark: "taskbar", "desktop", "foreground". */
  uiaSource?: string;
}

export interface LocateState {
  /** Natural-language description of what to find. */
  target: string;
  /** Runtime platform for platform-specific guidance text. */
  platform: string;
  /** True after a mouse_move has been made inside this loop. Gates the
   *  screenshot injection — only asks AI to "describe what you see" after
   *  the cursor has actually moved. */
  moved: boolean;
  /**
   * Marks detected on the most recent `zoom` inside this loop. REPLACED
   * (not accumulated) on each zoom. `mouse_move(mark_id: N)` resolves N
   * against this list. Cleared on `som: false`.
   */
  marks: Mark[];
}

// ── Injection text builders ────────────────────────────────────────────

export function buildLocateInjection(
  state: LocateState,
  toolName: string,
): string {
  const t = state.target;
  const isWin = state.platform === "win32";

  switch (toolName) {
    case "vision_locate":
      return (
        `[Vision Locate: "${t}"]\n` +
        `DO NOT guess coordinates.\n\n` +
        `A screenshot has been taken. Follow these steps:\n` +
        `1. Locate "${t}" in the image. ZOOM FIRST. Zoom returns pixel-accurate rulers and auto-detects SoM marks (red numbered circles) when the region qualifies. If marks are available, jumping to one with mouse_move(mark_id: N) is much faster than estimating coordinates.\n` +
        `2. Move the cursor onto the target: mouse_move(mark_id: N) if zoom found a matching mark, or mouse_move(coordinate: [x, y]) from the rulers.\n` +
        `3. Call screenshot to verify the lime-green cursor circle is on the target.\n` +
        `4. If the green circle is directly on "${t}", call accept() to snapshot the current cursor position.\n` +
        `   If off target, zoom on the cursor area to see precisely where it landed, refine, and repeat mouse_move → screenshot.\n` +
        `Loop steps 1-4 as needed. Two zoom + mark_id rounds is faster than five rounds of guessing coordinates. Do NOT give up early — zoom is the quickest path to a correct click.\n\n` +
        `Important: accept() does NOT validate the target for you — only call it after VL has visually confirmed the ring is on "${t}". After accept(), you'll receive the current coordinates and display id — use them with any tool (left_click, scroll, drag, etc.).`
      );

    case "mouse_move":
      return (
        `[Vision Locate: "${t}"]\n` +
        `Cursor moved. Now call screenshot to verify the lime-green circle is on "${t}".\n` +
        `- If the green circle is directly on the target → call accept() to snapshot the current cursor position.\n` +
        `- If off target or uncertain → ZOOM on the cursor area to see exactly where the circle landed. Use zoom rulers or SoM marks to refine, then mouse_move again.\n` +
        `- For small/clustered targets, zoom should have been your first step — if you skipped it and the cursor missed, zoom now.`
      );

    case "screenshot": {
      const verifyPrompt = state.moved
        ? `Briefly describe what the green circle is currently on. `
        : ``;
      return (
        `[Vision Locate: "${t}"]\n` +
        `${verifyPrompt}Check the lime-green circle in this screenshot:\n` +
        `- GREEN CIRCLE VISIBLE AND ON "${t}" → call accept() to snapshot the current cursor position.\n` +
        `- GREEN CIRCLE VISIBLE BUT OFF TARGET → zoom on the cursor area to see the offset precisely, then mouse_move with refined coordinates.\n` +
        `- GREEN CIRCLE NOT VISIBLE → call mouse_move to [100, 100] then screenshot to recover. Never accept on faith when you can't see the ring.\n` +
        `- TARGET HARD TO IDENTIFY → zoom on the target area first — the full-screen view is often too compressed when elements are small.`
      );
    }

    case "zoom": {
      const markCount = state.marks.length;
      const markHint =
        markCount > 0
          ? `\nDETECTED ${markCount} structured UI element${markCount === 1 ? "" : "s"} — see the red numbered circles on the image and the "Marks" text block above. To jump to one of them, call \`mouse_move\` with \`mark_id: N\` (no coordinates needed) — that jumps the cursor to mark N's recorded center. If your target ISN'T marked, fall back to reading coordinates from the rulers.`
          : `\nNo structured marks were detected in this region (or the region is too dense for a useful overlay). Read coordinates from the rulers and call mouse_move with explicit coordinates.`;
      return (
        `[Vision Locate: "${t}"]\n` +
        `Use the zoomed view to identify the target precisely.${markHint}\n` +
        `Note: coordinates in mouse_move always refer to the full-screen coordinate space (same numbers shown on the zoom rulers).`
      );
    }

    default:
      return `[Vision Locate: "${t}"]`;
  }
}

// ── Init handler ───────────────────────────────────────────────────────

/**
 * Handle vision_locate tool call: take a screenshot and return it with guidance.
 * The caller (mcpServer.ts dispatch) sets the active locate session.
 */
export async function handleVisionLocate(
  adapter: ComputerUseHostAdapter,
  args: { description: string },
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult & { locateLoop: LocateState }> {
  adapter.logger.debug(`[vision_locate] INIT target="${args.description}"`);

  const shot = await adapter.executor.screenshot({
    allowedAppIdentifiers: screenshotAllowlist(adapter, overrides),
    displayId: overrides.selectedDisplayId,
    coordinateGrid: "full",
  });

  const loopState: LocateState = {
    target: args.description,
    platform: adapter.executor.capabilities.platform,
    moved: false,
    marks: [],
  };

  return {
    content: [
      { type: "image", data: shot.base64, mimeType: "image/jpeg" },
    ],
    screenshot: shot,
    locateLoop: loopState,
  };
}
