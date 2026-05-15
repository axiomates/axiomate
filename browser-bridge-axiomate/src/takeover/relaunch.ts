/**
 * Relaunch the browser with the user's profile + CDP enabled.
 *
 * Differs from `launcher.ts`'s isolated-profile path in three ways:
 *  1. Uses the user's REAL `--user-data-dir` (their logins, extensions,
 *     bookmarks). Discovered via `profilePaths.ts`.
 *  2. Adds `--restore-last-session` so Chrome reopens the tabs the user
 *     just had open. (User's "On startup" Chrome setting can override this
 *     — that's a documented limitation.)
 *  3. OMITS `--no-first-run` and `--no-default-browser-check` — those
 *     force a clean-profile dance that's exactly what we're avoiding.
 *
 * The binary path needs to be resolved against the running browser's kind,
 * since `getBrowserCandidates` returns multiple candidates and we want the
 * one matching what the user just had open. We fall back to the first
 * matching candidate if `binary` isn't preset on `BrowserProcessInfo`.
 */

import { existsSync } from "node:fs";
import { execa } from "execa";

import {
  getBrowserCandidates,
  pickFreePort,
  waitForCdpReady,
} from "../launcher.js";
import { defaultProfilePath } from "./profilePaths.js";
import type { BrowserKind } from "../types.js";

export interface RelaunchOptions {
  kind: BrowserKind;
  /** Override binary path (e.g., test fixtures). */
  binary?: string;
  /** Override user-data-dir (escape hatch for non-default profiles). */
  userDataDir?: string;
  /** Override the auto-picked port. */
  port?: number;
}

export interface RelaunchResult {
  ok: boolean;
  pid?: number;
  port?: number;
  binary?: string;
  userDataDir?: string;
  reason?: string;
}

export async function relaunchWithCdp(
  opts: RelaunchOptions,
): Promise<RelaunchResult> {
  const platform = process.platform;

  const binary = opts.binary ?? findBinaryFor(opts.kind, platform);
  if (!binary || !existsSync(binary)) {
    return {
      ok: false,
      reason: `no installed binary found for ${opts.kind} on ${platform}`,
    };
  }

  const profile =
    opts.userDataDir ??
    defaultProfilePath(opts.kind, platform)?.userDataDir ??
    null;
  if (!profile) {
    return {
      ok: false,
      reason: `no default profile path known for ${opts.kind} on ${platform}`,
    };
  }
  if (!existsSync(profile)) {
    return {
      ok: false,
      reason: `profile dir does not exist: ${profile}`,
    };
  }

  const port = opts.port ?? (await pickFreePort());
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--restore-last-session",
  ];

  try {
    const child = execa(binary, args, {
      detached: true,
      windowsHide: platform === "win32",
      stdio: "ignore",
      cleanup: false,
    });
    child.unref?.();
    const pid = child.pid;
    const ready = await waitForCdpReady("127.0.0.1", port);
    if (!ready) {
      return {
        ok: false,
        pid,
        port,
        binary,
        userDataDir: profile,
        reason: `CDP did not become ready on port ${port} within 5s`,
      };
    }
    return { ok: true, pid, port, binary, userDataDir: profile };
  } catch (err) {
    return {
      ok: false,
      port,
      binary,
      userDataDir: profile,
      reason: `spawn failed: ${(err as Error).message}`,
    };
  }
}

function findBinaryFor(
  kind: BrowserKind,
  platform: NodeJS.Platform,
): string | undefined {
  const candidates = getBrowserCandidates(platform);
  return candidates.find((c) => c.kind === kind)?.path;
}
