/**
 * Takeover orchestrator.
 *
 * Chains the per-step modules into one async flow:
 *   1. detectRunningBrowser   — find the user's browser PID + kind
 *   2. preflightMacAutomation — fail fast if TCC will block us
 *   3. gracefulQuit           — close it cleanly (5s budget, no escalation
 *                                past polite-close on Win; SIGTERM
 *                                fallback on Mac if TCC denied)
 *   4. relaunchWithCdp        — same binary + user's profile +
 *                                --remote-debugging-port=<random>
 *   5. CdpClient.connect      — open the WS
 *   6. restoreWindowState     — Page.bringToFront (v1 minimal)
 *
 * Each step returns `{ok, reason?}`. The orchestrator stops at the first
 * non-ok step and surfaces the reason — including a `recoverable` flag so
 * the caller (toolCalls.ts handleTakeover) can decide whether to fall
 * back to the isolated-profile path.
 *
 * The function does NOT mutate the bridge session itself — that's the
 * caller's job. We just spawn + connect; the caller stores the CdpClient.
 */

import { CdpClient } from "../cdpClient.js";
import type { BrowserKind } from "../types.js";
import { detectRunningBrowser } from "./captureState.js";
import { gracefulQuit } from "./gracefulQuit.js";
import { preflightMacAutomation } from "./preflight.js";
import { relaunchWithCdp } from "./relaunch.js";
import { restoreWindowState } from "./restoreState.js";

export interface TakeoverOptions {
  /** Pin to a specific browser kind; defaults to whichever is running. */
  preferredKind?: BrowserKind;
}

export interface TakeoverResult {
  ok: boolean;
  /** True if the failure leaves the user's browser closed but the caller
   * can still safely launch an isolated profile as a fallback. False if
   * the user's browser is still running (e.g., gracefulQuit timed out)
   * and the caller should NOT also spawn an isolated profile alongside. */
  recoverable: boolean;
  client?: CdpClient;
  pid?: number;
  port?: number;
  kind?: BrowserKind;
  reason?: string;
  hint?: string;
  notes: string[];
}

export async function takeoverRealProfile(
  opts: TakeoverOptions = {},
): Promise<TakeoverResult> {
  const notes: string[] = [];

  // Step 1 — detect.
  const proc = await detectRunningBrowser(process.platform, opts.preferredKind);
  if (!proc) {
    return {
      ok: false,
      recoverable: true,
      reason: "no running Chromium-family browser detected",
      notes,
    };
  }
  notes.push(`detected ${proc.kind} pid=${proc.pid}`);

  // Step 2 — TCC preflight (mac no-op on win).
  const pre = await preflightMacAutomation(proc.kind);
  if (!pre.ok) {
    return {
      ok: false,
      recoverable: true,
      kind: proc.kind,
      reason: pre.reason,
      hint: pre.hint,
      notes,
    };
  }
  notes.push("Automation TCC ok");

  // Step 3 — graceful close.
  const quit = await gracefulQuit(proc.pid, proc.kind);
  if (!quit.ok) {
    return {
      ok: false,
      // User's browser is still alive, so isolated-profile fallback can
      // still launch in parallel without colliding.
      recoverable: true,
      kind: proc.kind,
      reason: quit.reason,
      notes,
    };
  }
  notes.push(`closed pid=${proc.pid}`);

  // Step 4 — relaunch with user profile + CDP.
  const launch = await relaunchWithCdp({ kind: proc.kind });
  if (!launch.ok) {
    return {
      ok: false,
      // The user's browser is closed at this point — we couldn't get it
      // back up with CDP. Caller's fallback should: launch the user's
      // browser WITHOUT --remote-debugging-port so they aren't stranded.
      // (Phase 3 enhancement; v1 surfaces the state and lets the model
      // decide.)
      recoverable: false,
      kind: proc.kind,
      reason: `relaunch failed: ${launch.reason}`,
      notes,
    };
  }
  notes.push(`relaunched pid=${launch.pid} port=${launch.port}`);

  // Step 5 — CDP connect.
  let client: CdpClient;
  try {
    client = await CdpClient.connect({ host: "127.0.0.1", port: launch.port! });
  } catch (e) {
    return {
      ok: false,
      recoverable: false,
      kind: proc.kind,
      pid: launch.pid,
      port: launch.port,
      reason: `CDP connect failed: ${(e as Error).message}`,
      notes,
    };
  }
  notes.push("CDP connected");

  // Step 6 — restore.
  const restore = await restoreWindowState(client);
  notes.push(...restore.notes);

  return {
    ok: true,
    recoverable: true,
    client,
    pid: launch.pid,
    port: launch.port,
    kind: proc.kind,
    notes,
  };
}

/**
 * Feature-flag check. Phase 2b is gated until the user explicitly opts
 * in via env var. Defaults off so a regression in the takeover path
 * doesn't disrupt users who only want the isolated profile.
 */
export function isTakeoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AXIOMATE_BROWSER_TAKEOVER === "1";
}
