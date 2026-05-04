/**
 * screen_locate — enter guided element-locating mode.
 *
 * When called, sets an active locate session and returns a screenshot with
 * guidance. The AI uses mouse_move + screenshot (and zoom for small/dense
 * areas) to position the lime-green cursor ring on the target. Once
 * confirmed, AI calls `accept()` to capture coordinates and display id,
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
}

export interface LocateState {
  /** Natural-language description of what to find. */
  target: string;
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

  switch (toolName) {
    case "screen_locate":
      return (
        `[Screen Locate: "${t}"]\n` +
        `DO NOT guess coordinates — estimating pixel positions from a downscaled image misses 30-60% of the time on small UI elements.\n\n` +
        `A screenshot has been taken. Follow these steps:\n` +
        `1. Locate "${t}" in the image. Read its coordinates from the rulers.\n` +
        `   If the target is small or in a crowded area (e.g. taskbar icons), use zoom to get a closer look before estimating coordinates.\n` +
        `2. Call mouse_move with those coordinates.\n` +
        `3. After mouse_move, call screenshot to verify the lime-green cursor circle is on the target.\n` +
        `4. If the green circle is directly on "${t}", call accept() to capture its position.\n` +
        `   If off target, refine coordinates and repeat mouse_move → screenshot.\n` +
        `Loop steps 2-4 as many times as needed. Two rounds is normal; five is fine for small targets. Do NOT give up early. Use zoom freely to inspect small or dense areas.\n\n` +
        `After accept(), you'll receive the exact coordinates and display id — use them with any tool (left_click, scroll, drag, etc.).`
      );

    case "mouse_move":
      return (
        `[Screen Locate: "${t}"]\n` +
        `Cursor moved. Now call screenshot to verify the lime-green circle is on "${t}".\n` +
        `- If the green circle is directly on the target → call accept() to capture the position.\n` +
        `- If off target → call mouse_move with refined coordinates, then screenshot again.\n` +
        `- If unsure → use zoom to inspect the area around the cursor more closely.`
      );

    case "screenshot": {
      const verifyPrompt = state.moved
        ? `Briefly describe what the green circle is currently on. `
        : ``;
      return (
        `[Screen Locate: "${t}"]\n` +
        `${verifyPrompt}Check the lime-green circle in this screenshot:\n` +
        `- GREEN CIRCLE VISIBLE AND ON "${t}" → call accept() to capture the position.\n` +
        `- GREEN CIRCLE VISIBLE BUT OFF TARGET → call mouse_move with refined coordinates, then screenshot again. Loop as many times as needed.\n` +
        `- GREEN CIRCLE NOT VISIBLE → call mouse_move to [100, 100] then screenshot to recover. Never accept on faith when you can't see the ring.\n` +
        `- TARGET HARD TO IDENTIFY → use zoom on the area to see more detail before adjusting.`
      );
    }

    case "zoom": {
      const markCount = state.marks.length;
      const markHint =
        markCount > 0
          ? `\nDETECTED ${markCount} UI element${markCount === 1 ? "" : "s"} via UIAutomation — see the red numbered circles on the image and the "Marks" text block above. To jump to one of them, call \`mouse_move\` with \`mark_id: N\` (no coordinates needed) — that jumps the cursor to mark N's recorded center. If your target ISN'T marked (UIA misses some custom-drawn controls), fall back to reading coordinates from the rulers.`
          : `\nNo UIAutomation marks were detected in this region (or the region is too dense — >25 elements). Read coordinates from the rulers and call mouse_move with explicit coordinates.`;
      return (
        `[Screen Locate: "${t}"]\n` +
        `Use the zoomed view to identify the target precisely.${markHint}\n` +
        `Note: coordinates in mouse_move always refer to the full-screen coordinate space (same numbers shown on the zoom rulers).`
      );
    }

    default:
      return `[Screen Locate: "${t}"]`;
  }
}

// ── Init handler ───────────────────────────────────────────────────────

/**
 * Handle screen_locate tool call: take a screenshot and return it with guidance.
 * The caller (mcpServer.ts dispatch) sets the active locate session.
 */
export async function handleScreenLocate(
  adapter: ComputerUseHostAdapter,
  args: { description: string },
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult & { locateLoop: LocateState }> {
  adapter.logger.debug(`[screen_locate] INIT target="${args.description}"`);

  const shot = await adapter.executor.screenshot({
    allowedAppIdentifiers: screenshotAllowlist(adapter, overrides),
    displayId: overrides.lastScreenshot?.displayId,
    coordinateGrid: "full",
  });

  const loopState: LocateState = {
    target: args.description,
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
