/**
 * Restore the relaunched browser window to a sensible state.
 *
 * v1 is intentionally minimal: with `--restore-last-session` Chrome
 * restores tabs and approximate window position on its own, which
 * covers the common case. This module exists so Phase 3 can plug in
 * precise geometry restore (Browser.setWindowBounds + Mac native
 * fullscreen via cmd+ctrl+F chord) without restructuring the takeover
 * orchestrator.
 *
 * Today the only real action is best-effort: bring the new browser
 * window to the foreground via `Page.bringToFront` so the user sees
 * "their browser is back" instead of a possibly-occluded window.
 */

import type { CdpClient } from "../cdpClient.js";

export interface RestoreOptions {
  /** Whether to foreground the browser after takeover. Default true. */
  bringToFront?: boolean;
}

export interface RestoreResult {
  ok: boolean;
  notes: string[];
}

export async function restoreWindowState(
  client: CdpClient,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  const notes: string[] = [];
  if (opts.bringToFront !== false) {
    try {
      await client.send("Page.bringToFront");
      notes.push("foregrounded the browser via Page.bringToFront");
    } catch (e) {
      notes.push(
        `Page.bringToFront failed: ${(e as Error).message} (non-fatal)`,
      );
    }
  }
  return { ok: true, notes };
}
