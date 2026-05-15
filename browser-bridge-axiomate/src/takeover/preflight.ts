/**
 * Mac TCC Automation preflight.
 *
 * Probes whether `osascript -e 'tell application "<name>" to ...'` will
 * succeed for the given browser. If TCC denies (-1743), we get a clear
 * error with a hint pointing at System Settings → Privacy & Security →
 * Automation, BEFORE the takeover orchestrator starts closing the user's
 * browser. If we skipped this check and Automation was denied, we'd quit
 * the browser via SIGTERM (succeeds) but lose session-restore data we
 * could have preserved.
 *
 * The probe is a no-op AppleScript: `tell application "<name>" to count
 * windows`. Counts are always allowed when Automation is granted; if
 * denied, AppleScript surfaces -1743 in stderr.
 *
 * Win has no equivalent; this module is a no-op there.
 */

import { execa } from "execa";
import type { BrowserKind } from "../types.js";

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  hint?: string;
}

const APP_NAMES: Record<BrowserKind, string> = {
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

export async function preflightMacAutomation(
  kind: BrowserKind,
  platform: NodeJS.Platform = process.platform,
): Promise<PreflightResult> {
  if (platform !== "darwin") return { ok: true };
  const appName = APP_NAMES[kind];
  if (!appName) {
    return {
      ok: false,
      reason: `unknown browser kind ${kind}`,
    };
  }
  const r = await execa(
    "osascript",
    ["-e", `tell application "${appName}" to count windows`],
    { reject: false },
  );
  if (r.exitCode === 0) return { ok: true };
  if (/-1743/.test(r.stderr ?? "")) {
    return {
      ok: false,
      reason: "automation-denied",
      hint: `System Settings → Privacy & Security → Automation → axiomate, enable ${appName}`,
    };
  }
  // Other osascript failures (browser not running, app name typo) — surface
  // raw stderr so the caller can debug.
  return {
    ok: false,
    reason: `osascript probe failed: ${r.stderr?.trim() || `exit ${r.exitCode}`}`,
  };
}
