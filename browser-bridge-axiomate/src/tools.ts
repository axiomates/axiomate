/**
 * Tool schemas for `mcp__browser-bridge__*`.
 *
 * Each tool maps 1:1 to a CDP operation (or a small composition).
 * Page-element refs (`e1`, `e2`, ...) are produced by `browser_snapshot`
 * and consumed by `browser_click` / `browser_type`. The model never sees
 * screen pixel coords for page content — the OS layer's coordinate space
 * stops at the BrowserViewport sentinel.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export function buildBrowserBridgeTools(): Tool[] {
  return [
    {
      name: "browser_takeover",
      description:
        "Attach to a browser via Chrome DevTools Protocol. By default uses an isolated profile (~/.axiomate/browser-bridge/profile, no logins, no extensions); pass profile='user' to take over the user's running browser (logins, cookies, extensions) — this gracefully closes their browser and relaunches it with CDP enabled. User-profile takeover requires the AXIOMATE_BROWSER_TAKEOVER=1 env var to be implicitly the default; passing profile='user' explicitly works regardless of the env var. Idempotent — calling again returns the current state.",
      inputSchema: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            enum: ["isolated", "user"],
            description:
              "isolated (default) launches a fresh profile; user takes over the running browser with the user's real profile (logins/cookies/extensions). User-profile takeover may fail recoverably (falls back to isolated) or non-recoverably.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_takeover_status",
      description:
        "Inspect the current bridge state without changing it. Returns attached/detached, profile (isolated|user), browser kind, CDP port.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_release",
      description:
        "Tear down the CDP connection and kill the isolated browser process. Use at the end of a browser-driven task.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_navigate",
      description:
        "Navigate the active page to a URL. Waits for the load event before returning.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute URL to navigate to.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Snapshot the current page's accessibility tree. Returns an indented text view with refs (e1, e2, ...) plus a refs map. Refs stay valid until the next snapshot or a navigation event.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_click",
      description:
        "Click an element addressed by a snapshot ref (e.g. e5). Resolves the ref to its CSS-box center and dispatches a CDP mouse event inside the page — no OS-side click.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "Snapshot ref like `e5`.",
          },
          button: {
            type: "string",
            enum: ["left", "middle", "right"],
            default: "left",
          },
          clickCount: {
            type: "integer",
            default: 1,
            minimum: 1,
            maximum: 3,
          },
        },
        required: ["ref"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_type",
      description:
        "Focus an element by ref, then insert text via CDP. Does not clear existing content — call browser_press with key='Backspace' first if needed.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          text: { type: "string" },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_press",
      description:
        "Dispatch a key event to the focused element. `key` is a CDP key name (e.g. 'Enter', 'Tab', 'ArrowDown', 'Backspace').",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_scroll",
      description:
        "Scroll the page or an element by `deltaY` (vertical) and `deltaX` (horizontal) pixels. Positive deltaY scrolls down.",
      inputSchema: {
        type: "object",
        properties: {
          deltaX: { type: "number", default: 0 },
          deltaY: { type: "number", default: 200 },
          ref: {
            type: "string",
            description:
              "Optional snapshot ref to scroll over (uses its center). If omitted, scrolls at viewport center.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_back",
      description: "Navigate back one entry in history.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_forward",
      description: "Navigate forward one entry in history.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_reload",
      description: "Reload the active page.",
      inputSchema: {
        type: "object",
        properties: {
          ignoreCache: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_tab_new",
      description: "Open a new tab. Optionally navigates to `url`.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_tab_close",
      description:
        "Close a tab by `targetId`, or the active tab if omitted.",
      inputSchema: {
        type: "object",
        properties: {
          targetId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_tab_switch",
      description:
        "Activate (focus) a tab by `targetId`. The bridge then snapshots/clicks against this tab.",
      inputSchema: {
        type: "object",
        properties: {
          targetId: { type: "string" },
        },
        required: ["targetId"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_tab_list",
      description:
        "List all open tabs with their targetId, url, and title.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_zoom",
      description:
        "Set the page zoom factor (1.0 = 100%, 1.5 = 150%, etc.). Affects CSS rendering only.",
      inputSchema: {
        type: "object",
        properties: {
          factor: { type: "number", minimum: 0.25, maximum: 5 },
        },
        required: ["factor"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_dialog",
      description:
        "Respond to a JavaScript dialog (alert / confirm / prompt). action='accept' or 'dismiss'; promptText is used only for prompt dialogs.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["accept", "dismiss"] },
          promptText: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_cdp",
      description:
        "Escape hatch: send an arbitrary CDP method with params. Returns the raw result. Use for protocol surfaces not covered by other tools.",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string" },
          params: { type: "object" },
          sessionId: {
            type: "string",
            description:
              "Optional CDP session id for routing into an attached child target.",
          },
        },
        required: ["method"],
        additionalProperties: false,
      },
    },
  ];
}
