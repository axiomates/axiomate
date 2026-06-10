/**
 * Public types for browser-bridge-axiomate.
 *
 * The page-interaction layer is delegated to the agent-browser CLI, so the
 * bridge no longer models AX trees / refs itself — those live in agent-browser's
 * stdout. What remains here is the small surface the launcher + session state
 * need.
 */

export type BrowserKind =
  | "chrome"
  | "edge"
  | "brave"
  | "chromium"
  | "vivaldi"
  | "opera"
  | "arc"
  | "thorium"
  | "unknown";

export type BridgeState = "detached" | "attaching" | "attached";
