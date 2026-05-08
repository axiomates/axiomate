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
    x: "Horizontal pixel position, measured from the LEFT edge of the screen (x increases rightward).",
    y: "Vertical pixel position, measured from the TOP edge of the screen (y increases downward).",
  },
  normalized_0_100: {
    x: "Horizontal position as a percentage of screen width, 0.0–100.0 (0 = LEFT edge, 100 = RIGHT edge; x increases rightward).",
    y: "Vertical position as a percentage of screen height, 0.0–100.0 (0 = TOP edge, 100 = BOTTOM edge; y increases downward).",
  },
};

const FRONTMOST_GATE_DESC =
  "The frontmost application must be in the session allowlist at the time of this call, or this tool returns an error and does nothing.";

/**
 * Per-platform variant of the frontmost-gate hint. Mac path keeps the
 * full text because SCContentFilter's compositor allowlist is real and
 * AI needs to know to grant apps before interacting with them. Win path
 * has no equivalent compositor filtering and `request_access` is hidden
 * from the tool list entirely on Win — the hint becomes meaningless
 * noise that pushes AI to invoke a non-existent setup flow.
 */
function frontmostHintFor(platform: string): string {
  if (platform === "win32") return "";
  return ` ${FRONTMOST_GATE_DESC}`;
}

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
        "left_click_drag",
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
    display_id: {
      type: "integer",
      minimum: 0,
      description:
        "Which monitor the action targets. Source: the `display_id` returned by `switch_display`, `cursor_position`, `accept`, or the monitor note on a screenshot. Optional.",
    },
    coordinate: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "(x, y) for click/mouse_move/scroll/left_click_drag end point.",
    },
    mark_id: {
      type: "integer",
      minimum: 1,
      description:
        "For mouse_move only — jump to SoM mark N from the most recent zoom. Do NOT pass both `coordinate` and `mark_id` on the same action.",
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
 * to fall back to the generic "display names or app identifiers" wording.
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
  const isWin = caps.platform === "win32";
  const frontmostHint = frontmostHintFor(caps.platform);

  // Platform-divergent app-identifier surfaces. The two platforms genuinely
  // disagree on what an "app identifier" is — mac uses CFBundleIdentifier
  // (reverse-DNS), Windows uses full exe path or display name. Showing
  // mac examples to a Windows user (or vice versa) gives the LLM a
  // confusing mental model and it tries to guess "com.example.app"
  // strings on Windows that resolve to nothing. We fork at runtime
  // here so each platform's LLM only sees its own examples.
  const appIdentifierExample = isWin
    ? '"C:\\\\Program Files\\\\Microsoft VS Code\\\\Code.exe" (classic .exe) or "shell:AppsFolder\\\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" (UWP / Microsoft Store)'
    : '"com.tinyspeck.slackmacgap" for Slack or "com.google.Chrome" for Chrome';
  const appIdentifierAcceptedNote = isWin
    ? 'On Windows, app identifiers come in two forms: classic .exe full paths (Chrome / Slack / VS Code, returned by list_running_apps for currently-running classic apps) and UWP / Microsoft Store launcher URIs of the form `shell:AppsFolder\\\\<AppID>` (Calculator / Photos / Settings / modern Notepad — auto-resolved when you pass the friendly name). You generally do not type these by hand; pass values you received from list_running_apps / screenshot_window output. Friendly display names like "Slack" / "Calculator" / "Photos" also work — open_application resolves them against the registry walk + Get-StartApps automatically.'
    : 'CFBundleIdentifier strings (e.g. "com.tinyspeck.slackmacgap") are also accepted, but you don\'t need to guess them; display names always work.';

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
    description: `[x, y] array of two non-negative numbers: ${coord.x}`,
  };
  // Optional display override for action tools — use value from accept().
  const displayIdProp = {
    type: "integer",
    minimum: 0,
    description:
      "Which monitor the click should land on. Source: the \`display_id\` returned by \`switch_display\`, \`cursor_position\`, \`accept\`, or the monitor note on a screenshot. Optional — when omitted, the click targets the monitor of the last screenshot taken. That is safe when clicking at the current cursor position, but on multi-monitor setups it may be the wrong screen.",
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

  const allTools: Tool[] = [
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
              "Application display names (e.g. \"Slack\", \"Calendar\") are the recommended input — resolved case-insensitively against installed apps. " +
              appIdentifierAcceptedNote +
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
      name: "screen_locate",
      description:
        "**Locate a UI element described in natural language** — e.g. \"Chrome icon in the taskbar\", \"Send button\", \"the X to close this dialog\". Use this when you need to find the exact position of something before clicking, scrolling, or dragging it. " +
        "Returns a screenshot and step-by-step guidance: use `mouse_move` + `screenshot` (and `zoom` for small/dense areas) to position the lime-green cursor ring on the target, then call `accept` to capture its coordinates and display. " +
        "Do NOT pre-call `screenshot` to \"look first\" — call `screen_locate` directly with the description; the screenshot comes back as part of the response." +
        frontmostHint,
      inputSchema: {
        type: "object" as const,
        properties: {
          description: {
            type: "string",
            description: "What to locate, in natural language.",
          },
        },
        required: ["description"],
      },
    },

    {
      name: "accept",
      description:
        "Confirm the current cursor position and return its coordinates. Only available inside an active `screen_locate` loop — outside the loop this returns an error asking you to call `screen_locate` first.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "screenshot",
      description:
        screenshotDesc +
        (caps.screenshotFiltering === "native"
          ? " If the session allowlist is empty, the dispatch layer auto-throws a PermissionRequest (not a hard error) and the host application surfaces an interactive dialog where the user picks apps to allow; the screenshot then resumes automatically. **Do NOT pre-call request_access for the screenshot itself, and do NOT fall back to shell commands like `screencapture` if you see a permission-related result. Retry once if the call appears interrupted.** "
          : " No allowlist setup is required — just call this tool directly with no arguments. ") +
        "\n\n**⚠ Tool selection: if the user's intent is to click or interact with a UI element they describe by name or appearance (e.g. \"click the Chrome icon in the taskbar\", \"click Send\", \"open Settings\"), call `screen_locate` instead — it ALSO returns a screenshot AND walks you through locating the target. Once found, use `accept()` to get coordinates, then any action tool (left_click, scroll, drag, etc.). Use this `screenshot` tool only when the goal is to OBSERVE or READ the screen (verifying state, reading text, planning, debugging) — not as the first step of a click.**\n\n" +
        "**The mouse cursor IS rendered in the image with a thick lime-green CIRCLE outline drawn around it** (the ring is added so the cursor remains unmissable at any image scale / JPEG compression). The cursor's pointer tip sits at the CENTER of the green ring. Use the green ring as ground-truth for where input will land.\n\n" +
        "**Coordinate system: x increases LEFT→RIGHT, y increases TOP→BOTTOM.** (0, 0) is the top-left corner. The ruler numbers on each edge show the valid coordinate range — the largest numbers at the right/bottom edges are the screen width/height.\n\n" +
        "If the user names a specific application and just wants to SEE it (e.g. \"show me Slack\", \"截 Chrome\"), prefer `screenshot_window` to capture only that app's frontmost window.",
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate_grid: {
            type: "string" as const,
            enum: ["none", "edge", "full"],
            description:
              "Overlay coordinate rulers on all four edges of the screenshot. " +
              "Numbers on rulers show pixel coordinates. " +
              "'none' (default): clean screenshot without any overlay. " +
              "'edge': four-edge rulers only (no crossing lines). " +
              "'full': four-edge rulers + semi-transparent grid lines across the image.",
          },
        },
        required: [],
      },
    },

    {
      name: "screenshot_window",
      description:
        "Capture only the frontmost window of a specific application. The returned frame contains that app's window pixels and nothing else — other apps and the desktop are not visible. macOS uses CGWindowListCreateImage; Windows uses PrintWindow with PW_RENDERFULLCONTENT (DWM-aware so Chrome / Electron / WebView2 capture cleanly, not black). On either platform if the named app has no visible top-level window the tool returns null with a diagnostic and the LLM should fall back to full-screen `screenshot`. " +
        "Use this when the user names a specific app — e.g. \"show me Slack\", \"截 Chrome\", \"capture iTerm\" — and you do not need surrounding context. Use plain `screenshot` for full-screen / multi-app context. " +
        "**Before calling this with an app identifier you only know by user-facing name (e.g. \"WeChat\", \"QQ\"), call `list_running_apps` first to get the exact id.** The bare display name is often wrong: \"WeChat\" is now `Weixin.exe`, \"Visual Studio Code\" is `Code.exe`, etc. Do NOT guess installation paths from memory. " +
        "The returned image shows only the target app's window — no surrounding desktop or other windows. " +
        "SoM (Set-of-Mark) auto-detects interactive elements INSIDE the window (buttons, text fields, icons, links) and overlays red numbered circles; pass `som: false` to suppress. " +
        "**Optional `coordinate_grid`** adds rulers to the window screenshot, using the window's screen position so coordinates match the global screenshot coordinate space — useful for precise positioning reference within the window. Default: `none` (no rulers).",
      inputSchema: {
        type: "object" as const,
        properties: {
          app_identifier: {
            type: "string",
            description:
              `Identifier for the target app — ${isWin ? "a full executable path on Windows" : "a CFBundleIdentifier (reverse-DNS string) on macOS"}, e.g. ${appIdentifierExample}. ${appIdentifierAcceptedNote} If you only know the user-facing name, **call \`list_running_apps\` first** — it returns the exact identifier for every currently-running app with a visible window. Do not guess install paths from common conventions; many apps live at non-standard paths (Weixin vs WeChat, scoop installs, custom directories).`,
          },
          coordinate_grid: {
            type: "string" as const,
            enum: ["none", "edge", "full"],
            description:
              "Overlay coordinate rulers on the window screenshot. 'edge' = rulers on edges only, 'full' = full grid with interior lines, 'none' = no rulers (default). Ruler numbers use the window's screen position so they match the global coordinate space.",
          },
          som: {
            type: "boolean",
            description:
              "Whether to run SoM (Set-of-Mark) detection on the captured window — red numbered circles overlaid on interactive elements (buttons, text fields, icons, links) inside the window. Default true (auto-detects when ≤25 elements are found). Set to false to suppress element detection.",
          },
        },
        required: ["app_identifier"],
      },
    },

    {
      name: "zoom",
      description:
        "Zoom into a region of the last screenshot to get pixel-accurate coordinates for small or clustered UI elements. " +
        "Returns a high-resolution view with coordinate rulers AND auto-detected SoM (Set-of-Mark) annotations — red numbered circles overlaid on interactive elements (buttons, text fields, icons, links). " +
        "Call `mouse_move(mark_id: N)` to jump the cursor directly to a detected element — far faster and more reliable than estimating coordinates from rulers. " +
        "Works after any `screenshot` or `screen_locate` call (both set the reference screenshot).\n\n" +
        "Use zoom as your primary precision tool when the target is small (taskbar icons, toolbar buttons, form fields, tree items) or in a dense area. For large, isolated targets the full-screen rulers may suffice, but when in doubt, zoom.\n\n" +
        "Two parameter formats:\n" +
        "1. `center: [cx, cy], size: N` — pick a center point and side length. 100-300 px is usually enough for a button row or toolbar area; use 400-800 px for a form section.\n" +
        "2. `region: [x0, y0, x1, y1]` — top-left and bottom-right corners.\n\n" +
        "The region is automatically clipped to screen bounds if it extends past the edges. Coordinate rulers on the returned image reflect the actual captured area.\n\n" +
        "SoM markers auto-overlay when the region has ≤25 elements and ≤15% screen area. Pass `som: false` to suppress markers (clears any prior zoom's marks — `mouse_move(mark_id: N)` will error until the next zoom).",
      inputSchema: {
        type: "object" as const,
        properties: {
          center: {
            type: "array",
            items: { type: "integer" },
            minItems: 2,
            maxItems: 2,
            description:
              "(cx, cy): Center point of the square zoom region in the coordinate space of the most recent full-screen screenshot. Use with `size`.",
          },
          size: {
            type: "integer",
            minimum: 10,
            description:
              "Side length of the square zoom region in pixels. Use with `center`. Minimum 10 pixels.",
          },
          region: {
            type: "array",
            items: { type: "integer" },
            minItems: 4,
            maxItems: 4,
            description:
              "(x0, y0, x1, y1): Rectangle to zoom into, in the coordinate space of the most recent full-screen screenshot. x0,y0 = top-left, x1,y1 = bottom-right.",
          },
          som: {
            type: "boolean",
            description:
              "Whether to overlay SoM (Set-of-Mark) detection markers on the zoomed image. Default true (system auto-decides based on element count + region size). " +
              "Set to false if the markers feel noisy or are obscuring details — analogous to passing `coordinate_grid: 'none'` to suppress rulers. " +
              "Setting false clears marks recorded by a prior zoom — `mouse_move(mark_id: N)` will error until the next zoom.",
          },
        },
        required: [],
      },
    },

    {
      name: "left_click",
      description:
        `Left-click at \`coordinate\`, or at the current cursor position if omitted. Pass \`display_id\` when coordinates came from another tool.` +
        frontmostHint,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
          display_id: displayIdProp,
        },
        required: [],
      },
    },

    {
      name: "double_click",
      description:
        `Double-click at \`coordinate\`, or at the current cursor position if omitted. ` +
        `Pass \`display_id\` when coordinates came from another tool.` +
        frontmostHint,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
          display_id: displayIdProp,
        },
        required: [],
      },
    },

    {
      name: "triple_click",
      description:
        `Triple-click at \`coordinate\`, or at the current cursor position if omitted. ` +
        `Pass \`display_id\` when coordinates came from another tool.` +
        frontmostHint,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
          display_id: displayIdProp,
        },
        required: [],
      },
    },

    {
      name: "right_click",
      description:
        `Right-click at \`coordinate\`, or at the current cursor position if omitted. ` +
        `Pass \`display_id\` when coordinates came from another tool.` +
        frontmostHint,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
          display_id: displayIdProp,
        },
        required: [],
      },
    },

    {
      name: "middle_click",
      description:
        `Middle-click at \`coordinate\`, or at the current cursor position if omitted. ` +
        `Pass \`display_id\` when coordinates came from another tool.` +
        frontmostHint,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          text: clickModifierText,
          display_id: displayIdProp,
        },
        required: [],
      },
    },

    {
      name: "type",
      description: `Type text into whatever currently has keyboard focus.${frontmostHint} Newlines are supported. For keyboard shortcuts use \`key\` instead.`,
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
        `Press a key or key combination (e.g. "return", "escape", "cmd+a", "ctrl+shift+tab").${frontmostHint}` +
        (isWin
          ? ""
          : " System-level combos (quit app, switch app, lock screen) require the `systemKeyCombos` grant — without it they return an error. All other combos work."),
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
      description: `Scroll at the given coordinates. Pass \`display_id\` when coordinates came from another tool.${frontmostHint}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          display_id: displayIdProp,
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
      description: `Press, move to target, and release. Pass \`start_display_id\` and \`end_display_id\` when coordinates came from another tool.${frontmostHint}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          start_coordinate: {
            ...coordinateTuple,
            description: `(x, y) start point. If omitted, drags from the current cursor position. ${coord.x}`,
          },
          start_display_id: displayIdProp,
          end_coordinate: {
            ...coordinateTuple,
            description: `(x, y) end point: ${coord.x}`,
          },
          end_display_id: displayIdProp,
        },
        required: ["end_coordinate"],
      },
    },

    {
      name: "mouse_move",
      description:
        `Move the mouse cursor (no click). For hover inspection, precise positioning, or drag setup.\n\n` +
        `Pick EXACTLY ONE way to specify the destination:\n` +
        `  - \`coordinate\`: [x, y] — always available. Read from the ruler edges on any screenshot.\n` +
        `  - \`mark_id\`: integer — shortcut that jumps to red numbered circle N from the most recent zoom. Works after any \`zoom\` that produced SoM marks (default). Errors if no zoom has been done, marks were cleared (\`som: false\`), or N doesn't match a detected mark. When unsure: use \`coordinate\`.\n` +
        `Never pass both.\n\n` +
        `Pass \`display_id\` when coordinates came from another tool.\n\n` +
        `If the response text includes a WARNING about a screen edge, the cursor may be clipped — follow the suggested correction. No warning means the cursor is safely on-screen.${frontmostHint}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          coordinate: coordinateTuple,
          display_id: displayIdProp,
          mark_id: {
            type: "integer",
            minimum: 1,
            description:
              "Jump to red numbered circle N from the most recent zoom that produced SoM marks. Errors if no marks exist (no prior zoom, or `som: false` cleared them) or N doesn't match a detected mark. Use this INSTEAD of `coordinate` — do NOT pass both.",
          },
        },
        required: [],
      },
    },

    {
      name: "open_application",
      description: isWin
        ? "Bring an application to the front, launching it if necessary. Pass the app identifier (full exe path) or display name (e.g. \"Chrome\"). Use `list_running_apps` to find currently-running app paths. Display names also work as a fallback via App Paths registry resolution."
        : "Bring an application to the front, launching it if necessary. The target application must already be in the session allowlist — call request_access first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          app: {
            type: "string",
            description:
              `Display name (e.g. "Slack") is preferred. ${appIdentifierAcceptedNote}`,
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
        "Returns a \`display_id\` you can pass to action tools (click, scroll, etc.). " +
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
      name: "list_running_apps",
      description:
        "List currently running applications that have at least one visible top-level window. Returns each unique app's app_identifier (full exe path on Windows; CFBundleIdentifier on macOS) and display_name. Use this to find the app_identifier when you only know the user-facing name — common before `screenshot_window` or `open_application`. No side effects.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
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
      description: isWin
        ? "Read the current clipboard contents as text."
        : "Read the current clipboard contents as text. Requires the `clipboardRead` grant.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "write_clipboard",
      description: isWin
        ? "Write text to the clipboard."
        : "Write text to the clipboard. Requires the `clipboardWrite` grant.",
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
      description: "Get the current mouse cursor position. Returns (x, y) coordinates in screenshot space and the \`display_id\` of the monitor the cursor is on.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },

    {
      name: "hold_key",
      description:
        `Press and hold a key or key combination for the specified duration, then release.${frontmostHint}` +
        (isWin
          ? ""
          : " System-level combos require the `systemKeyCombos` grant."),
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
        `Press the left mouse button at the current cursor position and leave it held.${frontmostHint} ` +
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
        `Release the left mouse button at the current cursor position.${frontmostHint} ` +
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
        "e.g. click a field, type into it, press Return. Actions execute sequentially and stop on the first error." +
        (frontmostHint ? `${frontmostHint} The frontmost check runs before EACH action inside the batch — if an action opens a non-allowed app, the next action's gate fires and the batch stops there.` : "") +
        " Mid-batch screenshot actions are allowed for inspection but coordinates in subsequent actions always refer to the PRE-BATCH full-screen screenshot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          actions: {
            type: "array",
            minItems: 1,
            items: BATCH_ACTION_ITEM_SCHEMA,
            description:
              'List of actions. Example: [{"action":"mouse_move","coordinate":[100,200]},{"action":"type","text":"hello"},{"action":"key","text":"Return"}]',
          },
        },
        required: ["actions"],
      },
    },

    ...(caps.teachMode ? buildTeachTools(coord, installedAppsHint, appIdentifierAcceptedNote) : []),
  ];

  // On Windows the allowlist concept does nothing — all gates are bypassed
  // (default-open mode), no SCContentFilter compositor filtering exists, and
  // request_access / list_granted_applications / request_teach_access only
  // produce wasted round-trips and dead-end UI dialogs. Hide them from the
  // win tool list entirely so the AI never invokes that flow. Mac path keeps
  // them — SCContentFilter genuinely uses allowedApps for screenshot privacy
  // and the request_access modal is the user-visible grant ceremony.
  if (isWin) {
    return allTools.filter(
      t =>
        t.name !== "request_access" &&
        t.name !== "list_granted_applications" &&
        t.name !== "request_teach_access"
    );
  }
  return allTools;
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
  appIdentifierAcceptedNote: string,
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
              'Application display names (e.g. "Slack", "Calendar") are the recommended input — resolved case-insensitively against installed apps. ' +
              appIdentifierAcceptedNote +
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
