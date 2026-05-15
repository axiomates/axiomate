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
      name: "browser_attach",
      description:
        "Attach to a freshly-spawned isolated-profile Chromium via Chrome DevTools Protocol. Profile lives at ~/.axiomate/browser-bridge/profile (no user logins, no extensions) so this never interferes with the user's running browser. Idempotent — calling again returns the current state. Note: taking over the user's real browser profile (with their logins) is not supported because Chrome 136+ silently disables --remote-debugging-port on the default user-data-dir.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_status",
      description:
        "Inspect the current bridge state without changing it. Returns attached/detached, profile, browser kind, CDP port.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_detach",
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
      name: "browser_console",
      description:
        "Read browser console output (log/warn/error/info) and uncaught exception stacks. Or pass `expression` to evaluate JavaScript in the page context (like typing into DevTools Console) and get the result back. Without `expression` you get the accumulated console buffer since the last attach or clear. Useful for debugging web pages — console errors typically point at the exact problem more directly than UI state.",
      inputSchema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              "Optional JavaScript expression to evaluate in the page context. Returned by value.",
          },
          clear: {
            type: "boolean",
            description: "If true, clear the console buffer after reading (default false).",
            default: false,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_get_images",
      description:
        "List every `<img>` element on the current page with src, alt, and natural dimensions. Returns JSON. Useful for discovering visual content the AX-tree snapshot doesn't surface, or for picking an image to download / feed to a vision tool.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Max number of images to return (default 50).",
            default: 50,
            minimum: 1,
            maximum: 500,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_vision",
      description:
        "Take a screenshot of the visible viewport and return it inline as an image content block. Use when the AX-snapshot does not reveal what you need: CAPTCHAs, canvas/SVG content, image-only buttons, custom layout that does not surface accessible names. The MCP host's own vision pipeline (if any) consumes the image. No on-screen overlay is drawn by this call.",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["png", "jpeg"],
            default: "png",
            description: "Image format. jpeg is smaller; png preserves detail.",
          },
          quality: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "JPEG quality 1-100 (ignored for PNG). Default 80.",
          },
          fullPage: {
            type: "boolean",
            default: false,
            description: "If true, capture the entire scrollable page, not just the viewport.",
          },
        },
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
