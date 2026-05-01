/**
 * click_target — system-driven visual search loop with VL decision-making.
 *
 * Replaces the old left_click/right_click/middle_click coordinate-guessing
 * approach. The system drives the loop: each round it prepares a screenshot,
 * builds available actions based on current state, assembles a prompt, and
 * sends it to the VL model. VL picks one action; the system executes it
 * and transitions to the next state.
 *
 * State machine:
 *   FULL_SCAN ──move_to──→ [confirm] ──yes──→ CLICKED ✓
 *             ──zoom────→ ZOOMED     └─no──→ FULL_SCAN (with feedback)
 *             ──give_up─→ FAILED ✗
 *
 *   ZOOMED ──move_to──→ [confirm] ──yes──→ CLICKED ✓
 *          ──pick_som─→ [confirm]  └─no──→ ZOOMED (with feedback)
 *          ──zoom─────→ ZOOMED (deeper)
 *          ──give_up──→ FAILED ✗
 */
import type { ComputerUseHostAdapter } from "./types.js";
import type { ComputerUseOverrides } from "./types.js";
import { allowedAppsOf } from "./types.js";
import type { ScreenshotResult } from "./executor.js";
import type { CuCallToolResult } from "./toolCalls.js";
import type { DetectedElement, Rect } from "./detection.js";
import {
  computeZoomRect,
  computeRulerIntervals,
  detectElementsInRect,
  shouldOverlaySoM,
} from "./detection.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function screenshotAllowlist(adapter: ComputerUseHostAdapter, overrides: ComputerUseOverrides): string[] {
  if (adapter.executor.capabilities.platform !== "darwin") return [];
  return allowedAppsOf(overrides).map(a => a.appIdentifier);
}

// ── State types ─────────────────────────────────────────────────────────

type ActionFeedback =
  | { kind: "spatial"; message: string }
  | { kind: "action"; message: string };

type ClickState =
  | { phase: "full_scan"; feedback: ActionFeedback | null }
  | {
      phase: "zoomed";
      rect: Rect;
      som: DetectedElement[] | null;
      feedback: ActionFeedback | null;
    }
  | { phase: "clicked"; message: string }
  | { phase: "failed"; reason: string };

type VlAction =
  | { type: "move_to"; x: number; y: number }
  | { type: "zoom"; cx: number; cy: number; size?: number }
  | { type: "pick_som"; id: number }
  | { type: "give_up"; reason: string };

// ── Result helpers ──────────────────────────────────────────────────────

function okText(text: string): CuCallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CuCallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ── Available actions per state ─────────────────────────────────────────

function availableActions(state: ClickState): VlAction["type"][] {
  switch (state.phase) {
    case "full_scan":
      return ["move_to", "zoom", "give_up"];
    case "zoomed":
      return state.som
        ? ["move_to", "zoom", "pick_som", "give_up"]
        : ["move_to", "zoom", "give_up"];
    default:
      return [];
  }
}

// ── VL prompt assembly ──────────────────────────────────────────────────

function buildVlPrompt(opts: {
  target: string;
  round: number;
  feedback: ActionFeedback | null;
  actions: VlAction["type"][];
  screenW: number;
  screenH: number;
  zoomRect?: Rect | null;
  som: DetectedElement[] | null;
}): string {
  const parts: string[] = [];

  parts.push(`Find and locate on screen: ${opts.target}`);
  parts.push("");

  // Spatial context
  if (opts.zoomRect) {
    const r = opts.zoomRect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    parts.push(
      `Screen resolution: ${opts.screenW}×${opts.screenH}.`,
    );
    parts.push(
      `This is a regional screenshot, center (${cx}, ${cy}), region [${r.x}, ${r.y}] - [${r.x + r.w}, ${r.y + r.h}], size ${r.w}×${r.h}.`,
    );
    parts.push(`Use the rulers to specify move_to coordinates.`);
  } else {
    parts.push(
      `Screen resolution: ${opts.screenW}×${opts.screenH}. This is a full-screen screenshot.`,
    );
    parts.push(`Use the rulers on the edges to read coordinates.`);
  }
  parts.push("");

  // Feedback from previous round
  if (opts.feedback && !(opts.feedback.kind === "spatial" && opts.zoomRect)) {
    parts.push(`Previous action result: ${opts.feedback.message}`);
    parts.push("");
  }

  // Available actions
  parts.push("Available actions:");
  for (const action of opts.actions) {
    switch (action) {
      case "move_to":
        parts.push(
          "- move_to(x, y): Read the target position from the rulers and move the cursor there.",
        );
        break;
      case "zoom":
        parts.push(
          "- zoom(cx, cy, size?): Zoom into a region centered at (cx, cy). Default size 300; smaller = more detail.",
        );
        break;
      case "pick_som":
        parts.push(
          "- pick_som(id): Select a numbered element from the image. Only available when SoM markers are visible.",
        );
        break;
      case "give_up":
        parts.push("- give_up(reason): The target cannot be found.");
        break;
    }
  }

  // SoM element list
  if (opts.som && opts.som.length > 0) {
    parts.push("");
    parts.push(
      `${opts.som.length} numbered elements are marked on the image. Use pick_som(id) to select one.`,
    );
  }

  parts.push("");
  parts.push("Respond with a JSON object for your chosen action.");

  return parts.join("\n");
}

/**
 * Build the JSON schema for the VL action response.
 * Only includes currently available action types.
 */
function buildActionSchema(
  actions: VlAction["type"][],
): object {
  const actionSchemas: object[] = [];

  if (actions.includes("move_to")) {
    actionSchemas.push({
      type: "object",
      properties: {
        type: { type: "string", const: "move_to" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["type", "x", "y"],
    });
  }
  if (actions.includes("zoom")) {
    actionSchemas.push({
      type: "object",
      properties: {
        type: { type: "string", const: "zoom" },
        cx: { type: "number" },
        cy: { type: "number" },
        size: { type: "number" },
      },
      required: ["type", "cx", "cy"],
    });
  }
  if (actions.includes("pick_som")) {
    actionSchemas.push({
      type: "object",
      properties: {
        type: { type: "string", const: "pick_som" },
        id: { type: "integer" },
      },
      required: ["type", "id"],
    });
  }
  if (actions.includes("give_up")) {
    actionSchemas.push({
      type: "object",
      properties: {
        type: { type: "string", const: "give_up" },
        reason: { type: "string" },
      },
      required: ["type", "reason"],
    });
  }

  return { oneOf: actionSchemas };
}

// ── Confirmation ────────────────────────────────────────────────────────

/**
 * Confirm the cursor is on the target. Two images (full + zoom around
 * cursor) + optional UIAutomation hint. No SoM, no rulers on these
 * images — only the green cursor circle highlight.
 */
async function confirmCursorOnTarget(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  target: string,
  vx: number,
  vy: number,
  lastScreenshot: ScreenshotResult | undefined,
): Promise<boolean> {
  if (!overrides.vlQuery) return true;

  // macOS: empty allowedAppIdentifiers triggers PermissionRequest auto-throw.
  // Skip cursor confirmation on macOS for now — the path needs a different
  // approach (pass real allowedApps or use a different screenshot method).
  if (adapter.executor.capabilities.platform === "darwin") return true;

  // 1. Full screenshot (scaled, with cursor)
  const fullShot = await adapter.executor.screenshot({
    allowedAppIdentifiers: screenshotAllowlist(adapter, overrides),
    displayId: lastScreenshot?.displayId,
  });

  // 2. Zoom around cursor (~150px region, high-res)
  const screenW = lastScreenshot?.width ?? fullShot.width;
  const screenH = lastScreenshot?.height ?? fullShot.height;
  const zoomRect = computeZoomRect(vx, vy, 150, screenW, screenH);

  const zoomShot = await adapter.executor.zoom(
    zoomRect,
    [],
    lastScreenshot?.displayId,
  );

  // 3. UIAutomation hit-test (reference only)
  let elementHint = "";
  if (adapter.executor.elementFromPoint && lastScreenshot) {
    try {
      const physX =
        vx * ((lastScreenshot.displayWidth ?? lastScreenshot.width) / lastScreenshot.width) +
        (lastScreenshot.originX ?? 0);
      const physY =
        vy * ((lastScreenshot.displayHeight ?? lastScreenshot.height) / lastScreenshot.height) +
        (lastScreenshot.originY ?? 0);
      const el = await adapter.executor.elementFromPoint(physX, physY);
      if (el?.name) {
        elementHint = `UIAutomation reports element under cursor: ${el.name} (role: ${el.role ?? "unknown"}) (reference only, may be inaccurate)`;
      }
    } catch {
      // Self-drawn UI / games won't have automation info
    }
  }

  // 4. VL confirmation — two images, no coordinates, just visual overlap
  const promptParts = [
    `Target: ${target}`,
    elementHint,
    "Image 1 is the full-screen screenshot. Image 2 is a zoomed detail around the cursor. The cursor is highlighted with a green circle.",
    "Do NOT reason about coordinates. Only judge visually: is the cursor (green circle) covering the target? Answer yes or no.",
  ].filter(Boolean);

  const result = await overrides.vlQuery({
    images: [fullShot.base64, zoomShot.base64],
    prompt: promptParts.join("\n"),
  });

  const answer = result.text.trim().toLowerCase();
  return answer.startsWith("yes");
}

// ── State transitions ───────────────────────────────────────────────────

async function transition(
  state: ClickState,
  action: VlAction,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  target: string,
  button: string, // validated by caller: "left" | "right" | "middle"
  count: number, // validated by caller: 1 | 2 | 3
  lastScreenshot: ScreenshotResult, // guaranteed set — prepareView runs first
): Promise<ClickState> {
  switch (action.type) {
    case "move_to": {
      const ratioX = (lastScreenshot.displayWidth ?? lastScreenshot.width) / lastScreenshot.width;
      const ratioY =
        (lastScreenshot.displayHeight ?? lastScreenshot.height) / lastScreenshot.height;
      const physX =
        Math.round(action.x * ratioX) + (lastScreenshot.originX ?? 0);
      const physY =
        Math.round(action.y * ratioY) + (lastScreenshot.originY ?? 0);

      await adapter.executor.moveMouse(physX, physY);
      await sleep(50);

      const confirmed = await confirmCursorOnTarget(
        adapter,
        overrides,
        target,
        action.x,
        action.y,
        lastScreenshot,
      );
      if (confirmed) {
        await adapter.executor.click(physX, physY, button as "left" | "right" | "middle", count as 1 | 2 | 3);
        return {
          phase: "clicked",
          message: `Clicked ${button} on "${target}" at (${action.x}, ${action.y})`,
        };
      }

      const feedback: ActionFeedback = { kind: "action", message: `Cursor moved to (${action.x}, ${action.y}) but did not cover the target. Adjust coordinates or try a different approach.` };
      if (state.phase === "zoomed") {
        return { ...(state as ClickState & { phase: "zoomed" }), feedback };
      }
      return { phase: "full_scan", feedback };
    }

    case "zoom": {
      const size = action.size ?? 300;
      const rect = computeZoomRect(
        action.cx,
        action.cy,
        size,
        lastScreenshot.width,
        lastScreenshot.height,
      );
      return {
        phase: "zoomed",
        rect,
        som: null,
        feedback: { kind: "spatial", message: `Zoomed to region [${rect.x},${rect.y}]-[${rect.x + rect.w},${rect.y + rect.h}], size ${rect.w}×${rect.h}.` },
      };
    }

    case "pick_som": {
      // state.phase === "zoomed" && state.som !== null guaranteed —
      // pick_som is only in availableActions() when both hold, and
      // the main loop validates action.type ∈ availableActions.
      const zoomedState = state as ClickState & { phase: "zoomed" };
      const som = zoomedState.som!;
      const el = som.find((e) => e.id === action.id);
      if (!el) {
        return { ...zoomedState, feedback: { kind: "action", message: `SoM #${action.id} does not exist. Available: ${som.map((e) => e.id).join(", ")}.` } };
      }

      const ratioX = (lastScreenshot.displayWidth ?? lastScreenshot.width) / lastScreenshot.width;
      const ratioY =
        (lastScreenshot.displayHeight ?? lastScreenshot.height) / lastScreenshot.height;
      const physX =
        Math.round(el.center.x * ratioX) +
        (lastScreenshot.originX ?? 0);
      const physY =
        Math.round(el.center.y * ratioY) +
        (lastScreenshot.originY ?? 0);

      await adapter.executor.moveMouse(physX, physY);
      await sleep(50);

      const confirmed = await confirmCursorOnTarget(
        adapter,
        overrides,
        target,
        el.center.x,
        el.center.y,
        lastScreenshot,
      );
      if (confirmed) {
        await adapter.executor.click(physX, physY, button as "left" | "right" | "middle", count as 1 | 2 | 3);
        return {
          phase: "clicked",
          message: `Clicked ${button} on "${target}" (SoM #${action.id})`,
        };
      }
      return { ...zoomedState, feedback: { kind: "action", message: `SoM #${action.id} missed the target. Pick another element or adjust.` } };
    }

    case "give_up":
      return { phase: "failed", reason: action.reason };
  }
}

// ── View preparation ────────────────────────────────────────────────────

async function prepareView(
  state: ClickState,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  lastScreenshot: ScreenshotResult | undefined,
): Promise<{ imageBase64: string; updatedState: ClickState; screenshot?: ScreenshotResult }> {
  switch (state.phase) {
    case "full_scan": {
      const shot = await adapter.executor.screenshot({
        allowedAppIdentifiers: screenshotAllowlist(adapter, overrides),
        displayId: lastScreenshot?.displayId,
        coordinateGrid: "full",
      });
      return { imageBase64: shot.base64, updatedState: state, screenshot: shot };
    }

    case "zoomed": {
      if (!lastScreenshot) {
        const shot = await adapter.executor.screenshot({
          allowedAppIdentifiers: screenshotAllowlist(adapter, overrides),
          coordinateGrid: "full",
        });
        return {
          imageBase64: shot.base64,
          updatedState: { phase: "full_scan", feedback: { kind: "action", message: "No prior screenshot for zoom. Showing full screen." } },
          screenshot: shot,
        };
      }

      const zoomed = await adapter.executor.zoom(
        state.rect,
        [],
        lastScreenshot.displayId,
        "full",
      );

      // SoM overlay: check area condition first (without element count),
      // then enumerate elements only if the area is small enough, then do
      // the full check including element count.
      let updatedState: ClickState = state;
      const sw = lastScreenshot.width;
      const sh = lastScreenshot.height;
      const areaRatio = (state.rect.w * state.rect.h) / (sw * sh);
      if (areaRatio <= 0.15 && adapter.executor.enumerateVisibleElements) {
        const vtpRatio = {
          ratioX: (lastScreenshot.displayWidth ?? lastScreenshot.width) / lastScreenshot.width,
          ratioY: (lastScreenshot.displayHeight ?? lastScreenshot.height) / lastScreenshot.height,
          originX: lastScreenshot.originX ?? 0,
          originY: lastScreenshot.originY ?? 0,
        };
        const elements = await detectElementsInRect(
          adapter.executor,
          state.rect,
          vtpRatio,
        );
        if (shouldOverlaySoM(state.rect, sw, sh, elements.length)) {
          // TODO: draw SoM markers on the image via Rust NAPI
          // For now, mark elements available for pick_som
          updatedState = { ...state, som: elements };
        }
      }

      return { imageBase64: zoomed.base64, updatedState };
    }

    default:
      throw new Error(`prepareView called in terminal state: ${state.phase}`);
  }
}

// ── Main loop ───────────────────────────────────────────────────────────

const MAX_ROUNDS = 8;

export async function handleClickTarget(
  adapter: ComputerUseHostAdapter,
  args: { description: string; button?: string; count?: number },
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  if (!overrides.vlQuery) {
    return errorResult(
      "click_target requires a VL model. Configure vlModel in ~/.axiomate.json.",
    );
  }

  const button = args.button ?? "left";
  if (!["left", "right", "middle"].includes(button))
    return errorResult(`Invalid button: "${button}". Use left, right, or middle.`);
  const count = args.count ?? 1;
  if (![1, 2, 3].includes(count))
    return errorResult(`Invalid count: ${count}. Use 1, 2, or 3.`);

  let lastScreenshot = overrides.lastScreenshot;

  let state: ClickState = { phase: "full_scan", feedback: null };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (state.phase === "clicked") return { ...okText(state.message), screenshot: lastScreenshot };
    if (state.phase === "failed")
      return errorResult(
        `Could not find: "${args.description}". Reason: ${state.reason}`,
      );

    // Check abort
    if (overrides.isAborted?.()) {
      return errorResult("click_target aborted by user.");
    }

    // Prepare view (screenshot + optional SoM)
    const { imageBase64, updatedState, screenshot: viewShot } = await prepareView(
      state,
      adapter,
      overrides,
      lastScreenshot,
    );
    state = updatedState;
    if (viewShot) lastScreenshot = viewShot;

    // After prepareView, lastScreenshot is guaranteed set (full_scan takes one)
    const screenW = lastScreenshot!.width;
    const screenH = lastScreenshot!.height;

    // Build prompt and query VL
    const actions = availableActions(state);
    const prompt = buildVlPrompt({
      target: args.description,
      round,
      feedback: state.phase === "full_scan" || state.phase === "zoomed"
        ? state.feedback
        : null,
      actions,
      screenW,
      screenH,
      zoomRect: state.phase === "zoomed" ? state.rect : null,
      som: state.phase === "zoomed" ? state.som : null,
    });
    const schema = buildActionSchema(actions);

    let vlResult;
    try {
      vlResult = await overrides.vlQuery({
        images: [imageBase64],
        prompt,
        schema,
      });
    } catch (err) {
      adapter.logger.warn(
        `[click_target] vlQuery failed: ${err instanceof Error ? err.message : err}`,
      );
      const retryFeedback: ActionFeedback = { kind: "action", message: "VL query failed. Retrying..." };
      if (state.phase === "zoomed") {
        state = { ...state, feedback: retryFeedback };
      } else {
        state = { phase: "full_scan", feedback: retryFeedback };
      }
      continue;
    }

    // Parse VL action
    let action: VlAction;
    try {
      const parsed = vlResult.parsed ?? JSON.parse(vlResult.text);
      action = parsed as VlAction;
    } catch {
      adapter.logger.warn(
        `[click_target] VL returned unparseable response: ${vlResult.text}`,
      );
      const parseFeedback: ActionFeedback = { kind: "action", message: "Invalid response format. Please respond with a valid JSON action." };
      if (state.phase === "zoomed") {
        state = { ...state, feedback: parseFeedback };
      } else {
        state = { phase: "full_scan", feedback: parseFeedback };
      }
      continue;
    }

    // Validate action type is available
    if (!actions.includes(action.type)) {
      state = {
        ...state,
        feedback: { kind: "action", message: `Action "${action.type}" is not available. Available: ${actions.join(", ")}.` },
      } as ClickState;
      continue;
    }

    // Execute transition — lastScreenshot guaranteed set by prepareView above
    state = await transition(
      state,
      action,
      adapter,
      overrides,
      args.description,
      button,
      count,
      lastScreenshot!,
    );
  }

  // Check terminal states after loop
  if (state.phase === "clicked") return { ...okText(state.message), screenshot: lastScreenshot };
  if (state.phase === "failed")
    return errorResult(
      `Could not find: "${args.description}". Reason: ${state.reason}`,
    );

  return errorResult(
    `Exhausted ${MAX_ROUNDS} rounds trying to find "${args.description}"`,
  );
}
