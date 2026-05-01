/**
 * click_target — enter guided click loop mode.
 *
 * When called, sets activeClickTarget in the session and returns a screenshot
 * with guidance. The AI then uses normal MCP tools (mouse_move, screenshot,
 * zoom, left_click) to find and click the target. The session dispatcher
 * injects state-aware guidance into each tool's response while the loop is
 * active. left_click execution clears the loop.
 *
 * This replaces the old VL side-query loop. The AI does its own visual
 * reasoning through normal tool call/result feedback — same approach as
 * the 70% success rate version, but with click_target as the mode entry point.
 */
import type { ComputerUseHostAdapter } from "./types.js";
import type { ComputerUseOverrides } from "./types.js";
import { allowedAppsOf } from "./types.js";
import type { CuCallToolResult } from "./toolCalls.js";

function screenshotAllowlist(adapter: ComputerUseHostAdapter, overrides: ComputerUseOverrides): string[] {
  if (adapter.executor.capabilities.platform !== "darwin") return [];
  return allowedAppsOf(overrides).map(a => a.appIdentifier);
}

// ── Click loop state (managed by mcpServer.ts session dispatcher) ──────

export interface ClickLoopState {
  target: string;
  button: "left" | "right" | "middle";
  count: 1 | 2 | 3;
  phase: "init" | "moving" | "verifying";
}

// ── Injection text builders ────────────────────────────────────────────

export function buildClickLoopInjection(
  state: ClickLoopState,
  toolName: string,
): string {
  const t = state.target;

  switch (toolName) {
    case "click_target":
      return (
        `[Click Target: "${t}"]\n` +
        `DO NOT guess coordinates — estimating pixel positions from a downscaled image misses 30-60% of the time on small UI elements.\n\n` +
        `A screenshot has been taken. Follow these steps:\n` +
        `1. Locate "${t}" in the image. Read its coordinates from the rulers.\n` +
        `   If the target is small or in a crowded area (e.g. taskbar icons), use zoom to get a closer look before estimating coordinates.\n` +
        `2. Call mouse_move with those coordinates.\n` +
        `3. After mouse_move, call screenshot to verify the lime-green cursor circle is on the target.\n` +
        `4. If the green circle is directly on "${t}", call left_click (no arguments) to click.\n` +
        `   If off target, refine coordinates and repeat mouse_move → screenshot.\n` +
        `Loop steps 2-4 as many times as needed. Two rounds is normal; five is fine for small targets. Do NOT give up early. Use zoom freely to inspect small or dense areas.`
      );

    case "mouse_move":
      return (
        `[Click Target: "${t}"]\n` +
        `Cursor moved. Now call screenshot to verify the lime-green circle is on "${t}".\n` +
        `- If the green circle is directly on the target → call left_click (no args) to commit.\n` +
        `- If off target → call mouse_move with refined coordinates, then screenshot again.\n` +
        `- If unsure → use zoom to inspect the area around the cursor more closely.`
      );

    case "screenshot":
      return (
        `[Click Target: "${t}"]\n` +
        `Check the lime-green circle in this screenshot:\n` +
        `- GREEN CIRCLE VISIBLE AND ON "${t}" → call left_click (no arguments) to click.\n` +
        `- GREEN CIRCLE VISIBLE BUT OFF TARGET → call mouse_move with refined coordinates, then screenshot again. Loop as many times as needed.\n` +
        `- GREEN CIRCLE NOT VISIBLE → call mouse_move to [100, 100] then screenshot to recover. Never click on faith when you can't see the ring.\n` +
        `- TARGET HARD TO IDENTIFY → use zoom on the area to see more detail before adjusting.`
      );

    case "zoom":
      return (
        `[Click Target: "${t}"]\n` +
        `Use the zoomed view to identify the target precisely. Read coordinates from the rulers, then call mouse_move to position the cursor.\n` +
        `Note: coordinates in mouse_move/left_click always refer to the full-screen coordinate space (same numbers shown on the zoom rulers).`
      );

    default:
      return `[Click Target: "${t}"]`;
  }
}

/**
 * Advance the click loop state based on which tool was called.
 */
export function advanceClickLoopPhase(
  state: ClickLoopState,
  toolName: string,
): ClickLoopState["phase"] {
  switch (toolName) {
    case "mouse_move":
      return "moving";
    case "screenshot":
      return "verifying";
    default:
      return state.phase;
  }
}

// ── Init handler ───────────────────────────────────────────────────────

/**
 * Handle click_target tool call: take a screenshot and return it with
 * guidance. The caller (mcpServer.ts dispatch) sets activeClickTarget.
 */
export async function handleClickTargetInit(
  adapter: ComputerUseHostAdapter,
  args: { description: string; button?: string; count?: number },
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult & { clickLoop: ClickLoopState }> {
  const button = (args.button ?? "left") as "left" | "right" | "middle";
  if (!["left", "right", "middle"].includes(button)) {
    return {
      content: [{ type: "text", text: `Invalid button: "${button}". Use left, right, or middle.` }],
      isError: true,
      clickLoop: { target: args.description, button, count: 1, phase: "init" },
    };
  }
  const count = (args.count ?? 1) as 1 | 2 | 3;
  if (![1, 2, 3].includes(count)) {
    return {
      content: [{ type: "text", text: `Invalid count: ${count}. Use 1, 2, or 3.` }],
      isError: true,
      clickLoop: { target: args.description, button, count: 1, phase: "init" },
    };
  }

  adapter.logger.debug(`[click_target] INIT target="${args.description}" button=${button} count=${count}`);

  const shot = await adapter.executor.screenshot({
    allowedAppIdentifiers: screenshotAllowlist(adapter, overrides),
    displayId: overrides.lastScreenshot?.displayId,
    coordinateGrid: "full",
  });

  const loopState: ClickLoopState = {
    target: args.description,
    button,
    count,
    phase: "init",
  };

  return {
    content: [
      { type: "image", data: shot.base64, mimeType: "image/jpeg" },
    ],
    screenshot: shot,
    clickLoop: loopState,
  };
}
