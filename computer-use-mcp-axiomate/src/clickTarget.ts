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
      `This is a zoomed regional screenshot, center (${cx}, ${cy}), region [${r.x}, ${r.y}] - [${r.x + r.w}, ${r.y + r.h}], size ${r.w}×${r.h}.`,
    );
    parts.push(`Coordinate system: (0,0) = top-left, x increases rightward, y increases downward. Use the rulers to read coordinates — they show screen-absolute values.`);
  } else {
    parts.push(
      `Screen resolution: ${opts.screenW}×${opts.screenH}. This is a full-screen screenshot.`,
    );
    parts.push(`Coordinate system: (0,0) = top-left, x increases rightward, y increases downward. Use the rulers on the edges to read coordinates.`);
  }
  parts.push("");

  // Feedback from previous round
  if (opts.feedback && !(opts.feedback.kind === "spatial" && opts.zoomRect)) {
    parts.push(`Previous action result: ${opts.feedback.message}`);
    parts.push("");
  }

  // Strategy guidance — adapts to state
  if (opts.zoomRect) {
    parts.push("Strategy: You are zoomed in with more detail visible. Identify the target precisely and use move_to with exact coordinates from the rulers. If still unclear, zoom further with a smaller size.");
  } else {
    parts.push("Strategy: Use move_to if you can clearly identify the target and its exact center. Use zoom if the target is small, in a crowded area, or you are unsure which element is correct.");
  }
  parts.push("");

  // Available actions
  parts.push("Available actions:");
  for (const action of opts.actions) {
    switch (action) {
      case "move_to":
        parts.push(
          "- move_to(x, y): Move the cursor to the target. Read the exact position from the rulers. Only use this when you can clearly identify the target and pinpoint its center.",
        );
        break;
      case "zoom":
        parts.push(
          "- zoom(cx, cy, size?): Zoom into a region to see more detail. Center the zoom on the area where the target likely is. Default size 300; use smaller values (100-200) for dense areas like taskbars or toolbars.",
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
  parts.push("Respond with a single JSON object. Examples:");
  parts.push('  {"type":"move_to","x":150,"y":900}');
  parts.push('  {"type":"zoom","cx":500,"cy":400,"size":200}');
  parts.push('  {"type":"give_up","reason":"not visible"}');

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
): Promise<{ confirmed: boolean; element: string }> {
  if (!overrides.vlQuery) return { confirmed: true, element: "" };

  // macOS: empty allowedAppIdentifiers triggers PermissionRequest auto-throw.
  // Skip cursor confirmation on macOS for now — the path needs a different
  // approach (pass real allowedApps or use a different screenshot method).
  if (adapter.executor.capabilities.platform === "darwin") return { confirmed: true, element: "" };

  adapter.logger.debug(`[click_target] confirmCursorOnTarget target="${target}" vx=${vx} vy=${vy}`);
  const tConfirm = Date.now();

  // 1. Full screenshot (scaled, with cursor)
  const fullShot = await adapter.executor.screenshot({
    allowedAppIdentifiers: screenshotAllowlist(adapter, overrides),
    displayId: lastScreenshot?.displayId,
  });

  // 2. Zoom around cursor (~150px region, high-res)
  const screenW = lastScreenshot?.width ?? fullShot.width;
  const screenH = lastScreenshot?.height ?? fullShot.height;
  const zoomRect = computeZoomRect(vx, vy, 150, screenW, screenH);
  adapter.logger.debug(`[click_target] confirm zoom (cursor check): rect=${JSON.stringify(zoomRect)}`);

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

  // 4. VL confirmation — two images, describe then judge
  const promptParts = [
    `Target: "${target}"`,
    elementHint,
    "Image 1 is the full-screen screenshot. Image 2 is a zoomed detail around the cursor position. The cursor is highlighted with a green circle.",
    "First, describe what UI element the green circle cursor is currently on (be specific — name, icon, label, color).",
    `Then judge: is that element the target "${target}"? Answer with a JSON object: {"element":"<what you see>","match":true/false}`,
  ].filter(Boolean);

  const tVl = Date.now();
  const result = await overrides.vlQuery({
    images: [fullShot.base64, zoomShot.base64],
    prompt: promptParts.join("\n"),
  });

  const raw = result.text.trim();
  let confirmed = false;
  let element = "";
  try {
    // Extract JSON from the response — may be pure JSON, code-fenced, or after free text
    const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? raw.match(/(\{[\s\S]*"match"\s*:[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : raw;
    const parsed = JSON.parse(jsonStr);
    confirmed = parsed.match === true;
    element = parsed.element ?? "";
  } catch {
    const lower = raw.toLowerCase();
    confirmed = lower.includes('"match":true') || lower.includes('"match": true');
    const elMatch = raw.match(/"element"\s*:\s*"([^"]*)"/);
    if (elMatch) element = elMatch[1]!;
  }
  adapter.logger.debug(`[click_target] confirmCursorOnTarget element="${element}" confirmed=${confirmed} vlTime=${Date.now() - tVl}ms totalTime=${Date.now() - tConfirm}ms raw=${raw}`);
  return { confirmed, element };
}

// ── State transitions ───────────────────────────────────────────────────

type ClickStats = { vlCalls: number; parseFails: number; moveTo: number; zoom: number; pickSom: number; giveUp: number; confirmYes: number; confirmNo: number; vlErrors: number; invalidAction: number };

async function transition(
  state: ClickState,
  action: VlAction,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  target: string,
  button: string, // validated by caller: "left" | "right" | "middle"
  count: number, // validated by caller: 1 | 2 | 3
  lastScreenshot: ScreenshotResult, // guaranteed set — prepareView runs first
  stats: ClickStats,
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

      const { confirmed, element } = await confirmCursorOnTarget(
        adapter,
        overrides,
        target,
        action.x,
        action.y,
        lastScreenshot,
      );
      if (confirmed) { stats.confirmYes++; } else { stats.confirmNo++; }
      if (confirmed) {
        await adapter.executor.click(physX, physY, button as "left" | "right" | "middle", count as 1 | 2 | 3);
        return {
          phase: "clicked",
          message: `Clicked ${button} on "${target}" at (${action.x}, ${action.y})`,
        };
      }

      const feedbackMsg = element
        ? `Cursor landed on "${element}" at (${action.x}, ${action.y}), not the target "${target}". Try zooming in to identify it precisely.`
        : `Cursor moved to (${action.x}, ${action.y}) but did not cover the target. Try zooming in to locate it.`;
      const feedback: ActionFeedback = { kind: "action", message: feedbackMsg };
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

      const { confirmed, element } = await confirmCursorOnTarget(
        adapter,
        overrides,
        target,
        el.center.x,
        el.center.y,
        lastScreenshot,
      );
      if (confirmed) { stats.confirmYes++; } else { stats.confirmNo++; }
      if (confirmed) {
        await adapter.executor.click(physX, physY, button as "left" | "right" | "middle", count as 1 | 2 | 3);
        return {
          phase: "clicked",
          message: `Clicked ${button} on "${target}" (SoM #${action.id})`,
        };
      }
      const somFeedback = element
        ? `SoM #${action.id} landed on "${element}", not the target. Pick another element or adjust.`
        : `SoM #${action.id} missed the target. Pick another element or adjust.`;
      return { ...zoomedState, feedback: { kind: "action", message: somFeedback } };
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

      adapter.logger.debug(`[click_target] prepareView zoom (VL action): rect=${JSON.stringify(state.rect)}`);
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

  adapter.logger.debug(`[click_target] START target="${args.description}" button=${button} count=${count}`);
  const t0 = Date.now();
  const stats = { vlCalls: 0, parseFails: 0, moveTo: 0, zoom: 0, pickSom: 0, giveUp: 0, confirmYes: 0, confirmNo: 0, vlErrors: 0, invalidAction: 0 };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (state.phase === "clicked") {
      adapter.logger.debug(`[click_target] END (clicked) ${Date.now() - t0}ms stats=${JSON.stringify(stats)}`);
      return { ...okText(state.message), screenshot: lastScreenshot };
    }
    if (state.phase === "failed") {
      adapter.logger.debug(`[click_target] END (failed) ${Date.now() - t0}ms reason=${(state as { reason: string }).reason} stats=${JSON.stringify(stats)}`);
      return errorResult(
        `Could not find: "${args.description}". Reason: ${state.reason}`,
      );
    }

    // Check abort
    if (overrides.isAborted?.()) {
      adapter.logger.debug(`[click_target] END (aborted) ${Date.now() - t0}ms stats=${JSON.stringify(stats)}`);
      return errorResult("click_target aborted by user.");
    }

    adapter.logger.debug(`[click_target] round=${round} phase=${state.phase}${state.phase === "zoomed" ? ` rect=${JSON.stringify((state as any).rect)}` : ""}`);

    // Prepare view (screenshot + optional SoM)
    const tView = Date.now();
    const { imageBase64, updatedState, screenshot: viewShot } = await prepareView(
      state,
      adapter,
      overrides,
      lastScreenshot,
    );
    adapter.logger.debug(`[click_target] prepareView ${Date.now() - tView}ms imageLen=${imageBase64.length}`);
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

    adapter.logger.debug(`[click_target] VL prompt:\n${prompt}`);
    adapter.logger.debug(`[click_target] VL schema: ${JSON.stringify(schema)}`);

    let vlResult;
    const tVl = Date.now();
    try {
      vlResult = await overrides.vlQuery({
        images: [imageBase64],
        prompt,
        schema,
      });
    } catch (err) {
      stats.vlErrors++;
      adapter.logger.warn(
        `[click_target] vlQuery failed (${Date.now() - tVl}ms): ${err instanceof Error ? err.message : err}`,
      );
      const retryFeedback: ActionFeedback = { kind: "action", message: "VL query failed. Retrying..." };
      if (state.phase === "zoomed") {
        state = { ...state, feedback: retryFeedback };
      } else {
        state = { phase: "full_scan", feedback: retryFeedback };
      }
      continue;
    }

    stats.vlCalls++;
    adapter.logger.debug(`[click_target] VL response (${Date.now() - tVl}ms): text=${vlResult.text} parsed=${JSON.stringify(vlResult.parsed)}`);

    // Parse VL action
    let action: VlAction;
    try {
      let parsed = vlResult.parsed;
      if (!parsed) {
        // Strip markdown code fences if present
        let raw = vlResult.text.trim();
        if (raw.startsWith("```")) {
          raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
        }
        parsed = JSON.parse(raw);
      }
      // Normalize: accept "action" as alias for "type" (VL models often use it)
      if (parsed && typeof parsed === "object" && "action" in parsed && !("type" in parsed)) {
        (parsed as any).type = (parsed as any).action;
        delete (parsed as any).action;
      }
      action = parsed as VlAction;
    } catch {
      stats.parseFails++;
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

    adapter.logger.debug(`[click_target] action: ${JSON.stringify(action)}`);

    // Validate action type is available
    if (!actions.includes(action.type)) {
      stats.invalidAction++;
      adapter.logger.debug(`[click_target] invalid action type "${action.type}" not in [${actions}]`);
      state = {
        ...state,
        feedback: { kind: "action", message: `Action "${action.type}" is not available. Available: ${actions.join(", ")}.` },
      } as ClickState;
      continue;
    }

    // Count action type
    if (action.type === "move_to") stats.moveTo++;
    else if (action.type === "zoom") stats.zoom++;
    else if (action.type === "pick_som") stats.pickSom++;
    else if (action.type === "give_up") stats.giveUp++;

    // Execute transition — lastScreenshot guaranteed set by prepareView above
    const tTransition = Date.now();
    state = await transition(
      state,
      action,
      adapter,
      overrides,
      args.description,
      button,
      count,
      lastScreenshot!,
      stats,
    );
    adapter.logger.debug(`[click_target] transition ${Date.now() - tTransition}ms → phase=${state.phase}`);
  }

  // Check terminal states after loop
  if (state.phase === "clicked") {
    adapter.logger.debug(`[click_target] END (clicked post-loop) ${Date.now() - t0}ms stats=${JSON.stringify(stats)}`);
    return { ...okText(state.message), screenshot: lastScreenshot };
  }
  if (state.phase === "failed") {
    adapter.logger.debug(`[click_target] END (failed post-loop) ${Date.now() - t0}ms stats=${JSON.stringify(stats)}`);
    return errorResult(
      `Could not find: "${args.description}". Reason: ${state.reason}`,
    );
  }

  adapter.logger.debug(`[click_target] END (exhausted) ${Date.now() - t0}ms stats=${JSON.stringify(stats)}`);
  return errorResult(
    `Exhausted ${MAX_ROUNDS} rounds trying to find "${args.description}"`,
  );
}
