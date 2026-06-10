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

/**
 * A JavaScript dialog (alert/confirm/prompt/beforeunload) currently blocking
 * the page. Once `Page.enable` is sent, Chrome stops showing native dialog UI
 * and freezes the page's JS thread until `Page.handleJavaScriptDialog` is
 * called, so an open dialog must be surfaced to the agent (via browser_status /
 * browser_snapshot) so it knows to call browser_dialog.
 */
export interface PendingDialog {
  type: string;
  message: string;
  /** Default text for `prompt` dialogs; empty otherwise. */
  defaultPrompt: string;
  /** Wall-clock ms when the dialog opened. */
  openedAt: number;
}

export interface BridgeStatus {
  state: BridgeState;
  profile?: BridgeProfile;
  browserKind?: BrowserKind;
  cdpPort?: number;
  /** Outer viewport in screen pixels at attach time (best-effort). */
  viewport?: { x: number; y: number; w: number; h: number };
  /** Set when a JS dialog is blocking the page and awaiting browser_dialog. */
  pendingDialog?: PendingDialog;
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
