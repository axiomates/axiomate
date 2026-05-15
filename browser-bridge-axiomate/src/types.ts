/**
 * Public types for browser-bridge-axiomate.
 *
 * Shape mirrors hermes-agent's browser tool surface (Playwright-MCP /
 * browser-use refs scheme): elements are addressed by string ids like
 * `e1`, `e2`, ... assigned at snapshot time, valid until the next
 * snapshot or a navigation event invalidates them.
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

export type BridgeState =
  | "detached"
  | "attaching"
  | "attached"
  | "released";

export type BridgeProfile = "isolated";

export interface BridgeStatus {
  state: BridgeState;
  profile?: BridgeProfile;
  browserKind?: BrowserKind;
  cdpPort?: number;
  /** Outer viewport in screen pixels at attach time (best-effort). */
  viewport?: { x: number; y: number; w: number; h: number };
}

export interface PageRef {
  ref: string;
  role: string;
  name: string;
  description?: string;
  frameId: string;
  backendNodeId: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Indented text tree, one line per ref: `- button "Submit" [e5]`. */
  ariaText: string;
  refs: Record<string, PageRef>;
}
