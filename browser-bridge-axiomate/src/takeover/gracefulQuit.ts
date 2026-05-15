/**
 * Gracefully close a running browser before takeover.
 *
 * Win: POST `taskkill /pid <pid>` without /f — sends a polite close
 * message (WM_CLOSE for GUI processes) that lets Chrome's "do you want to
 * save your form?" / "you have N tabs" dialogs fire normally. If the user
 * hits Cancel, we time out and abort the takeover.
 *
 * Mac: try `osascript -e 'tell application "Google Chrome" to quit'`
 * first (clean — closes saving state). If TCC Automation is denied
 * (-1743), fall back to SIGTERM which loses session data more reliably
 * but doesn't need the permission.
 *
 * The 5s budget covers Chrome's normal shutdown (typically <1s). If the
 * user is actively using a form with unsaved changes and dismisses the
 * confirm, we abort — never force-kill the browser without the user
 * having approved takeover in the first place.
 */

import { execa } from "execa";
import type { BrowserKind } from "../types.js";

export interface QuitResult {
  ok: boolean;
  reason?: string;
  /** True if the process is gone at return time. */
  exited: boolean;
}

const POLL_INTERVAL_MS = 100;
const QUIT_TIMEOUT_MS = 5000;

/**
 * Bundle-id for AppleScript addressing. We `tell application "<name>" to
 * quit` rather than `tell application id "<bundle>"` because the name form
 * is more permissive when the user has renamed the .app (rare but happens
 * with portable installs).
 */
const MAC_APP_NAME: Record<BrowserKind, string> = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  brave: "Brave Browser",
  vivaldi: "Vivaldi",
  opera: "Opera",
  thorium: "Thorium",
  chromium: "Chromium",
  arc: "Arc",
  unknown: "",
};

export async function gracefulQuit(
  pid: number,
  kind: BrowserKind,
  platform: NodeJS.Platform = process.platform,
): Promise<QuitResult> {
  if (platform === "win32") {
    return await winQuit(pid);
  }
  if (platform === "darwin") {
    return await macQuit(pid, kind);
  }
  return { ok: false, exited: false, reason: `unsupported platform ${platform}` };
}

async function winQuit(pid: number): Promise<QuitResult> {
  try {
    // `taskkill` without /f sends WM_CLOSE; Chrome handles it like the
    // user clicked the close button on the last window.
    await execa("taskkill", ["/pid", String(pid)], { reject: false });
  } catch {
    // taskkill not found — fall through to wait + SIGTERM ladder below.
  }
  const exited = await waitForExit(pid, QUIT_TIMEOUT_MS);
  if (exited) return { ok: true, exited: true };
  // Polite close did not work — likely an unsaved-changes prompt is up.
  // Do NOT escalate to force-kill here; the user can re-issue takeover
  // after dismissing the dialog.
  return {
    ok: false,
    exited: false,
    reason: `pid ${pid} still alive after ${QUIT_TIMEOUT_MS}ms; an in-browser dialog may have blocked quit`,
  };
}

async function macQuit(
  pid: number,
  kind: BrowserKind,
): Promise<QuitResult> {
  const appName = MAC_APP_NAME[kind];
  if (appName) {
    try {
      const r = await execa(
        "osascript",
        ["-e", `tell application "${appName}" to quit`],
        { reject: false },
      );
      // Exit code 1 + stderr matching -1743 = Automation TCC denied.
      const denied = r.exitCode !== 0 && /-1743/.test(r.stderr ?? "");
      if (!denied) {
        const exited = await waitForExit(pid, QUIT_TIMEOUT_MS);
        if (exited) return { ok: true, exited: true };
      } else {
        // Automation TCC denied — fall through to SIGTERM. Caller is
        // expected to have run preflight; this is a defensive path.
      }
    } catch {
      // osascript missing or errored — fall through.
    }
  }
  // SIGTERM fallback. Loses session-restore-relevant state more
  // aggressively than osascript, but doesn't need Automation TCC.
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone — treat as success.
    return { ok: true, exited: true };
  }
  const exited = await waitForExit(pid, QUIT_TIMEOUT_MS);
  if (exited) return { ok: true, exited: true };
  return {
    ok: false,
    exited: false,
    reason: `pid ${pid} still alive after SIGTERM + ${QUIT_TIMEOUT_MS}ms`,
  };
}

async function waitForExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return !processAlive(pid);
}

function processAlive(pid: number): boolean {
  try {
    // signal 0 = existence check; no signal sent.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
