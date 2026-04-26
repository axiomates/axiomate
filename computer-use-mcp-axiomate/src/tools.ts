/**
 * MCP tool schemas for the computer-use server.
 *
 * Coordinate descriptions are baked in at tool-list build time from the
 * `chicago_coordinate_mode` gate. The model sees exactly ONE coordinate
 * convention in the param descriptions and never learns the other exists.
 * The host (`serverDef.ts`) reads the same frozen gate value for
 * `scaleCoord` — both must agree or clicks land in the wrong space.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { CoordinateMode } from "./types.js";

// See packages/desktop/computer-use-mcp/COORDINATES.md before touching any
// model-facing coordinate text. Chrome's browserTools.ts:143 is the reference
// phrasing — "pixels from the left edge", no geometry, no number to do math with.
const COORD_DESC: Record<CoordinateMode, { x: string; y: string }> = {
  pixels: {
    x: "Horizontal pixel position read directly from the most recent screenshot image, measured from the left edge. The server handles all scaling.",
    y: "Vertical pixel position read directly from the most recent screenshot image, measured from the top edge. The server handles all scaling.",
  },
  normalized_0_100: {
    x: "Horizontal position as a percentage of screen width, 0.0–100.0 (0 = left edge, 100 = right edge).",
    y: "Vertical position as a percentage of screen height, 0.0–100.0 (0 = top edge, 100 = bottom edge).",
  },
};

const FRONTMOST_GATE_DESC =
  "The frontmost application must be in the session allowlist at the time of this call, or this tool returns an error and does nothing.";

/**
 * Item schema for the `actions` array in `computer_batch`, `teach_step`, and
 * `teach_batch`. All three dispatch through the same `dispatchAction` path
 * with the same validation — keep this enum in sync with `BATCHABLE_ACTIONS`
 * in toolCalls.ts.
 */
const BATCH_ACTION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "key",
        "type",
        "mouse_move",
        "left_click",
        "left_click_drag",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
        "scroll",
        "hold_key",
        "screenshot",
        "cursor_position",
        "left_mouse_down",
        "left_mouse_up",
        "wait",
      ],
      description: "The action to perform.",
    },
    coordinate: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "(x, y) for click/mouse_move/scroll/left_click_drag end point.",
    },
    start_coordinate: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "(x, y) drag start — left_click_drag only. Omit to drag from current cursor.",
    },
    text: {
      type: "string",
      description:
        "For type: the text. For key/hold_key: the chord string. For click/scroll: modifier keys to hold.",
    },
    scroll_direction: {
      type: "string",
      enum: ["up", "down", "left", "right"],
    },
    scroll_amount: { type: "integer", minimum: 0, maximum: 100 },
    duration: {
      type: "number",
      description: "Seconds (0–100). For hold_key/wait.",
    },
    repeat: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "For key: repeat count.",
    },
  },
  required: ["action"],
};

/**
 * Build the tool list. Parameterized by capabilities and coordinate mode so
 * descriptions are honest and unambiguous (plan §1 — "Unfiltered + honest").
 *
 * `coordinateMode` MUST match what the host passes to `scaleCoord` at tool-
 * -call time. Both should read the same frozen-at-load gate constant.
 *
 * `installedAppNames` — optional pre-sanitized list of app display names to
 * enumerate in the `request_access` description. The caller is responsible
 * for sanitization (length cap, character allowlist, sort, count cap) —
 * this function just splices the list into the description verbatim. Omit
 * to fall back to the generic "display names or bundle IDs" wording.
 */
export function buildComputerUseTools(
  caps: {
    screenshotFiltering: "native" | "none";
    platform: string;
    /** Include request_teach_access + teach_step. Read once at server construction. */
    teachMode?: boolean;
  },
  coordinateMode: CoordinateMode,
  installedAppNames?: string[],
): Tool[] {
  const coord = COORD_DESC[coordinateMode];

  // Shared hint suffix for BOTH request_access and request_teach_access —
  // they use the same resolveRequestedApps path, so the model should get
  // the same enumeration for both.
  const installedAppsHint =
    installedAppNames && installedAppNames.length > 0
      ? ` Available applications on this machine: ${installedAppNames.join(", ")}.`
      : "";

  // [x, y]` tuple — param shape for all
  // click/move/scroll tools.
  const coordinateTuple = {
    type: "array",
    items: { type: "number" },
    minItems: 2,
    maxItems: 2,
    description: `(x, y): ${coord.x}`,
  };
  // Modifier hold during click. Shared across all 5 click variants.
  const clickModifierText = {
    type: "string",
    description:
      'Modifier keys to hold during the click (e.g. "shift", "ctrl+shift"). Supports the same syntax as the key tool.',
  };

  const screenshotDesc =
    caps.screenshotFiltering === "native"
      ? "Take a screenshot of the primary display. Applications not in the session allowlist are excluded at the compositor level — only granted apps and the desktop are visible."
      : "Take a screenshot of the primary display. The full screen is captured as-is — every open window is visible.";

  return [
    {
      name: "request_access",
      description:
        "Request user permission to control a set of applications for this session. " +
        (caps.screenshotFiltering === "native"
          ? "Screenshots without an allowlist auto-throw a PermissionRequest — the host surfaces an interactive dialog and the screenshot resumes after the user picks. "
          : "Screenshots do NOT need an allowlist on this platform — call `screenshot` directly. ") +
        "**Do NOT pre-call request_access as a 'setup step'**: input actions (click/type/key/scroll) only need an allowlist when the targeted app's frontmost-window check fails — call those directly first and let the dispatch layer error tell you which app to grant. " +
        "Only call this tool explicitly when (a) the user names a specific app to grant mid-session, or (b) a previous click/type errored because the frontmost app wasn't in the allowlist. " +
        "The user sees a single dialog listing all requested apps and either allows the whole set or denies it. " +
        "Returns the granted apps, denied apps, and screenshot filtering capability.",
      inputSchema: {
        type: "object" as const,
        properties: {
          apps: {
            type: "array",
            items: { type: "string" },
            description:
              "Application display names (e.g. \"Slack\", \"Calendar\") are the recommended input — resolved case-insensitively against installed apps. Bundle identifiers (e.g. \"com.tinyspeck.slackmacgap\") are also accepted, but you don't need to guess them; display names always work." +
              installedAppsHint,
          },
          reason: {
            type: "string",
            description:
              "One-sentence explanation shown to the user in the approval dialog. Explain the task, not the mechanism.",
          },
          clipboardRead: {
            type: "boolean",
            description:
              "Also request permission to read the user's clipboard (separate checkbox in the dialog).",
          },
          clipboardWrite: {
            type: "boolean",
            description:
              "Also request permission to write the user's clipboard. When granted, multi-line `type` calls use the clipboard fast path.",
          },
          systemKeyCombos: {
            type: "boolean",
            description:
              "Also request permission to send system-level key combos (quit app, switch app, lock screen). Without this, those specific combos are blocked.",
          },
        },
        required: ["apps", "reason"],
      },
    },

    {
      name: "screenshot",
      description:
        screenshotDesc +
        (caps.screenshotFiltering === "native"
          ? " If the session allowlist is empty, the dispatch layer auto-throws a PermissionRequest (not a hard error) and the host application surfaces an interactive dialog where the user picks apps to allow; the screenshot then resumes automatically. "
          : " No allowlist setup is required — just call this tool directly with no arguments. ") +
        "**Do NOT pre-call request_access for the screenshot itself, and do NOT fall back to shell commands like `screencapture` if you see a permission-related result. Retry once if the call appears interrupted.** " +
        "The returned image is what subsequent click coordinates are relative to. " +
        "If the user names a specific application (e.g. \"截 Slack\", \"show me Chrome\"), prefer `screenshot_window` to capture only that app's frontmost window.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "screenshot_window",
      description:
        "Capture only the frontmost window of a specific application. The returned frame contains that app's window pixels and nothing else — other apps and the desktop are not visible. macOS-only currently (uses CGWindowListCreateImage); other platforms return a clean error and the LLM should fall back to `screenshot`. " +
        "Use this when the user names a specific app — e.g. \"show me Slack\", \"截 Chrome\", \"capture iTerm\" — and you do not need surrounding context. Use plain `screenshot` for full-screen / multi-app context, or when you need to click afterward. " +
        "IMPORTANT: This tool is for inspection only. Coordinates in any subsequent click call refer to the FULL screen, never the window-cropped image — the cursor lives at screen coords. If you intend to click afterward, take a full `screenshot` to read coordinates from.",
      inputSchema: {
        type: "object" as const,
        properties: {
          bundle_id: {
            type: "string",
            description:
              'Bundle id of the target app, e.g. "com.tinyspeck.slackmacgap" for Slack or "com.google.Chrome" for Chrome. If you only know the user-facing name, look it up via `request_access` (its app picker shows bundle ids) or call `screenshot` first to identify what is on screen.',
          },
        },
        required: ["bundle_id"],
      },
    },

    {
      name: "zoom",
      description:
        "Take a higher-resolution screenshot of a specific region of the last full-screen screenshot. Use this liberally to inspect small text, button labels, or fine UI details that are hard to read in the downsampled full-screen image. " +
        "Requires a prior `screenshot` call — the region coords map into that screenshot's pixel space. If you haven't taken a screenshot yet, call `screenshot` first. " +
        "IMPORTANT: Coordinates in subsequent click calls always refer to the full-screen screenshot, never the zoomed image. This tool is read-only for inspecting detail.",
      inputSchema: {
        type: "object" as const,
        properties: {
          region: {
            type: "array",
            items: { type: "integer" },
            minItems: 4,
            maxItems: 4,
            description:
              "(x0, y0, x1, y1): Rectangle to zoom into, in the coordinate space of the most recent full-screen screenshot. x0,y0 = top-left, x1,y1 = bottom-right.",
          },
        },
        required: ["region"],
      },
    },

    {
      name: "left_click",
      description: `Left-click at the given coordinates. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "double_click",
      description: `Double-click at the given coordinates. Selects a word in most text editors. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "triple_click",
      description: `Triple-click at the given coordinates. Selects a line in most text editors. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "right_click",
      description: `Right-click at the given coordinates. Opens a context menu in most applications. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "middle_click",
      description: `Middle-click (scroll-wheel click) at the given coordinates. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "type",
      description: `Type text into whatever currently has keyboard focus. ${FRONTMOST_GATE_DESC} Newlines are supported. For keyboard shortcuts use \`key\` instead.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Text to type." },
        },
        required: ["text"],
      },
    },

    {
      name: "key",
      description:
        `Press a key or key combination (e.g. "return", "escape", "cmd+a", "ctrl+shift+tab"). ${FRONTMOST_GATE_DESC} ` +
        "System-level combos (quit app, switch app, lock screen) require the `systemKeyCombos` grant — without it they return an error. All other combos work.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: 'Modifiers joined with "+", e.g. "cmd+shift+a".',
          },
          repeat: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Number of times to repeat the key press. Default is 1.",
          },
        },
        required: ["text"],
      },
    },

    {
      name: "scroll",
      description: `Scroll at the given coordinates. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          scroll_direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Direction to scroll.",
          },
          scroll_amount: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "Number of scroll ticks.",
          },
        },
        required: ["coordinate", "scroll_direction", "scroll_amount"],
      },
    },

    {
      name: "left_click_drag",
      description: `Press, move to target, and release. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: {
            ...coordinateTuple,
            description: `(x, y) end point: ${coord.x}`,
          },
          start_coordinate: {
            ...coordinateTuple,
            description: `(x, y) start point. If omitted, drags from the current cursor position. ${coord.x}`,
          },
        },
        required: ["coordinate"],
      },
    },

    {
      name: "mouse_move",
      description: `Move the mouse cursor without clicking. Useful for triggering hover states. ${FRONTMOST_GATE_DESC}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
        },
        required: ["coordinate"],
      },
    },

    {
      name: "open_application",
      description:
        "Bring an application to the front, launching it if necessary. The target application must already be in the session allowlist — call request_access first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          app: {
            type: "string",
            description:
              "Display name (e.g. \"Slack\") is preferred. Bundle identifiers (e.g. \"com.tinyspeck.slackmacgap\") are also accepted.",
          },
        },
        required: ["app"],
      },
    },

    {
      name: "switch_display",
      description:
        "Switch which monitor subsequent screenshots capture. Use this when the " +
        "application you need is on a different monitor than the one shown. " +
        "The screenshot tool tells you which monitor it captured and lists " +
        "other attached monitors by name — pass one of those names here. " +
        "After switching, call screenshot to see the new monitor. " +
        'Pass "auto" to return to automatic monitor selection.',
      inputSchema: {
        type: "object" as const,
        properties: {
          display: {
            type: "string",
            description:
              'Monitor name from the screenshot note (e.g. "Built-in Retina Display", ' +
              '"LG UltraFine"), or "auto" to re-enable automatic selection.',
          },
        },
        required: ["display"],
      },
    },

    {
      name: "list_granted_applications",
      description:
        "List the applications currently in the session allowlist, plus the active grant flags and coordinate mode. No side effects.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "read_clipboard",
      description:
        "Read the current clipboard contents as text. Requires the `clipboardRead` grant.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "write_clipboard",
      description:
        "Write text to the clipboard. Requires the `clipboardWrite` grant.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },

    {
      name: "wait",
      description: "Wait for a specified duration.",
      inputSchema: {
        type: "object" as const,
        properties: {
          duration: {
            type: "number",
            description: "Duration in seconds (0–100).",
          },
        },
        required: ["duration"],
      },
    },

    {
      name: "cursor_position",
      description:
        "Get the current mouse cursor position. Returns image-pixel coordinates relative to the most recent screenshot, or logical points if no screenshot has been taken.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "hold_key",
      description:
        `Press and hold a key or key combination for the specified duration, then release. ${FRONTMOST_GATE_DESC} ` +
        "System-level combos require the `systemKeyCombos` grant.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: 'Key or chord to hold, e.g. "space", "shift+down".',
          },
          duration: {
            type: "number",
            description: "Duration in seconds (0–100).",
          },
        },
        required: ["text", "duration"],
      },
    },

    {
      name: "left_mouse_down",
      description:
        `Press the left mouse button at the current cursor position and leave it held. ${FRONTMOST_GATE_DESC} ` +
        "Use mouse_move first to position the cursor. Call left_mouse_up to release. Errors if the button is already held.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "left_mouse_up",
      description:
        `Release the left mouse button at the current cursor position. ${FRONTMOST_GATE_DESC} ` +
        "Pairs with left_mouse_down. Safe to call even if the button is not currently held.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "computer_batch",
      description:
        "Execute a sequence of actions in ONE tool call. Each individual tool call requires a model→API round trip (seconds); " +
        "batching a predictable sequence eliminates all but one. Use this whenever you can predict the outcome of several actions ahead — " +
        "e.g. click a field, type into it, press Return. Actions execute sequentially and stop on the first error. " +
        `${FRONTMOST_GATE_DESC} The frontmost check runs before EACH action inside the batch — if an action opens a non-allowed app, the next action's gate fires and the batch stops there. ` +
        "Mid-batch screenshot actions are allowed for inspection but coordinates in subsequent clicks always refer to the PRE-BATCH full-screen screenshot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          actions: {
            type: "array",
            minItems: 1,
            items: BATCH_ACTION_ITEM_SCHEMA,
            description:
              'List of actions. Example: [{"action":"left_click","coordinate":[100,200]},{"action":"type","text":"hello"},{"action":"key","text":"Return"}]',
          },
        },
        required: ["actions"],
      },
    },

    ...(caps.teachMode ? buildTeachTools(coord, installedAppsHint) : []),
  ];
}

/**
 * Teach-mode tools. Split out so the spread above stays a single expression;
 * takes `coord` so `teach_step.anchor`'s description uses the same
 * frozen coordinate-mode phrasing as click coords, and `installedAppsHint`
 * so `request_teach_access.apps` gets the same enumeration as
 * `request_access.apps` (same resolution path → same hint).
 */
function buildTeachTools(
  coord: { x: string; y: string },
  installedAppsHint: string,
): Tool[] {
  // Shared between teach_step (top-level) and teach_batch (inside steps[]
  // items). Depends on coord, so it lives inside this factory.
  const teachStepProperties = {
    explanation: {
      type: "string",
      description:
        "Tooltip body text. Explain what the user is looking at and why it matters. " +
        "This is the ONLY place the user sees your words — be complete but concise.",
    },
    next_preview: {
      type: "string",
      description:
        "One line describing exactly what will happen when the user clicks Next. " +
        'Example: "Next: I\'ll click Create Bucket and type the name." ' +
        "Shown below the explanation in a smaller font.",
    },
    anchor: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        `(x, y) — where the tooltip arrow points. ${coord.x} ` +
        "Omit to center the tooltip with no arrow (for general-context steps).",
    },
    actions: {
      type: "array",
      // Empty allowed — "read this, click Next" steps.
      items: BATCH_ACTION_ITEM_SCHEMA,
      description:
        "Actions to execute when the user clicks Next. Same item schema as computer_batch.actions. " +
        "Empty array is valid for purely explanatory steps. Actions run sequentially and stop on first error.",
    },
  } as const;

  return [
    {
      name: "request_teach_access",
      description:
        "Request permission to guide the user through a task step-by-step with on-screen tooltips. " +
        "Use this INSTEAD OF request_access when the user wants to LEARN how to do something " +
        '(phrases like "teach me", "walk me through", "show me how", "help me learn"). ' +
        "On approval the main Axiomate window hides and a fullscreen tooltip overlay appears. " +
        "You then call teach_step repeatedly; each call shows one tooltip and waits for the user to click Next. " +
        "Same app-allowlist semantics as request_access, but no clipboard/system-key flags. " +
        "Teach mode ends automatically when your turn ends.",
      inputSchema: {
        type: "object" as const,
        properties: {
          apps: {
            type: "array",
            items: { type: "string" },
            description:
              'Application display names (e.g. "Slack", "Calendar") or bundle identifiers. Resolved case-insensitively against installed apps.' +
              installedAppsHint,
          },
          reason: {
            type: "string",
            description:
              'What you will be teaching. Shown in the approval dialog as "Axiomate wants to guide you through {reason}". Keep it short and task-focused.',
          },
        },
        required: ["apps", "reason"],
      },
    },

    {
      name: "teach_step",
      description:
        "Show one guided-tour tooltip and wait for the user to click Next. On Next, execute the actions, " +
        "take a fresh screenshot, and return both — you do NOT need a separate screenshot call between steps. " +
        "The returned image shows the state after your actions ran; anchor the next teach_step against it. " +
        "IMPORTANT — the user only sees the tooltip during teach mode. Put ALL narration in `explanation`. " +
        "Text you emit outside teach_step calls is NOT visible until teach mode ends. " +
        "Pack as many actions as possible into each step's `actions` array — the user waits through " +
        "the whole round trip between clicks, so one step that fills a form beats five steps that fill one field each. " +
        "Returns {exited:true} if the user clicks Exit — do not call teach_step again after that. " +
        "Take an initial screenshot before your FIRST teach_step to anchor it.",
      inputSchema: {
        type: "object" as const,
        properties: teachStepProperties,
        required: ["explanation", "next_preview", "actions"],
      },
    },

    {
      name: "teach_batch",
      description:
        "Queue multiple teach steps in one tool call. Parallels computer_batch: " +
        "N steps → one model↔API round trip instead of N. Each step still shows a tooltip " +
        "and waits for the user's Next click, but YOU aren't waiting for a round trip between steps. " +
        "You can call teach_batch multiple times in one tour — treat each batch as one predictable " +
        "SEGMENT (typically: all the steps on one page). The returned screenshot shows the state " +
        "after the batch's final actions; anchor the NEXT teach_batch against it. " +
        "WITHIN a batch, all anchors and click coordinates refer to the PRE-BATCH screenshot " +
        "(same invariant as computer_batch) — for steps 2+ in a batch, either omit anchor " +
        "(centered tooltip) or target elements you know won't have moved. " +
        "Good pattern: batch 5 tooltips on page A (last step navigates) → read returned screenshot → " +
        "batch 3 tooltips on page B → done. " +
        "Returns {exited:true, stepsCompleted:N} if the user clicks Exit — do NOT call again after that; " +
        "{stepsCompleted, stepFailed, ...} if an action errors mid-batch; " +
        "otherwise {stepsCompleted, results:[...]} plus a final screenshot. " +
        "Fall back to individual teach_step calls when you need to react to each intermediate screenshot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: teachStepProperties,
              required: ["explanation", "next_preview", "actions"],
            },
            description:
              "Ordered steps. Validated upfront — a typo in step 5 errors before any tooltip shows.",
          },
        },
        required: ["steps"],
      },
    },
  ];
}
