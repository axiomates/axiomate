/**
 * Browser launcher — isolated-profile path (Phase 2a).
 *
 * Spawns a Chromium-family browser with `--remote-debugging-port` against a
 * dedicated profile dir under `~/.axiomate/browser-bridge/profile`. The
 * spawned process is detached so the agent's lifecycle doesn't tie to it;
 * `browser_detach` kills the PID explicitly when the bridge is torn down.
 *
 * Direct port of hermes_cli/browser_connect.py. Binary tables, spawn flags,
 * and the CDP-ready retry loop match upstream so the operational behavior
 * (which browsers are tried, in what order, with what flags) stays
 * consistent with hermes-agent.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, Socket } from "node:net";
import { execa } from "execa";
import type { BrowserKind } from "./types.js";

export const DEFAULT_CDP_PORT = 9222;

/** Candidate binaries on macOS, in preference order. */
const DARWIN_APPS: Array<{ kind: BrowserKind; path: string }> = [
  { kind: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { kind: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
  { kind: "brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
  { kind: "vivaldi", path: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" },
  { kind: "opera", path: "/Applications/Opera.app/Contents/MacOS/Opera" },
  { kind: "arc", path: "/Applications/Arc.app/Contents/MacOS/Arc" },
  { kind: "thorium", path: "/Applications/Thorium.app/Contents/MacOS/Thorium" },
  { kind: "chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
];

/**
 * Candidate binaries on Windows, expressed as (env-var, suffix) so we can
 * resolve %ProgramFiles% / %ProgramFiles(x86)% / %LOCALAPPDATA% at runtime.
 */
const WINDOWS_INSTALL_PARTS: Array<{
  kind: BrowserKind;
  env: "ProgramFiles" | "ProgramFiles(x86)" | "LOCALAPPDATA";
  suffix: string;
}> = [
  { kind: "chrome", env: "ProgramFiles", suffix: "Google\\Chrome\\Application\\chrome.exe" },
  { kind: "chrome", env: "ProgramFiles(x86)", suffix: "Google\\Chrome\\Application\\chrome.exe" },
  { kind: "chrome", env: "LOCALAPPDATA", suffix: "Google\\Chrome\\Application\\chrome.exe" },
  { kind: "edge", env: "ProgramFiles", suffix: "Microsoft\\Edge\\Application\\msedge.exe" },
  { kind: "edge", env: "ProgramFiles(x86)", suffix: "Microsoft\\Edge\\Application\\msedge.exe" },
  { kind: "brave", env: "ProgramFiles", suffix: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
  { kind: "brave", env: "ProgramFiles(x86)", suffix: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
  { kind: "brave", env: "LOCALAPPDATA", suffix: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
  { kind: "vivaldi", env: "LOCALAPPDATA", suffix: "Vivaldi\\Application\\vivaldi.exe" },
  { kind: "opera", env: "LOCALAPPDATA", suffix: "Programs\\Opera\\opera.exe" },
];

export interface BrowserCandidate {
  kind: BrowserKind;
  path: string;
}

/**
 * Resolved candidate binaries that exist on disk, in preference order.
 * Pure (no FS in test build): callers can stub `existsSync` via fs mocking.
 */
export function getBrowserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserCandidate[] {
  if (platform === "darwin") {
    return DARWIN_APPS.filter((c) => existsSync(c.path));
  }
  if (platform === "win32") {
    const out: BrowserCandidate[] = [];
    for (const { kind, env: envKey, suffix } of WINDOWS_INSTALL_PARTS) {
      const base = env[envKey];
      if (!base) continue;
      const path = join(base, suffix);
      if (existsSync(path)) out.push({ kind, path });
    }
    return out;
  }
  return [];
}

/** Default isolated-profile dir under the user's home. */
export function isolatedProfileDir(): string {
  return join(homedir(), ".axiomate", "browser-bridge", "profile");
}

/**
 * Pick a free TCP port by binding to 0 and reading what the OS handed back.
 * Avoids colliding with whatever the user might already have on 9222.
 */
export async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not resolve listening port"));
      }
    });
  });
}

/**
 * One TCP connect attempt with a timeout. Used by the readiness retry loop —
 * we don't speak HTTP here; CDP listens on a TCP socket and accepting the
 * connection is sufficient evidence that the port is live.
 */
export async function probeCdpEndpoint(
  host: string,
  port: number,
  timeoutMs: number = 1000,
): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const sock: Socket = createConnection({ host, port });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // Already destroyed — ignore.
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Poll the CDP port until it accepts connections, or give up. Mirrors
 * hermes_cli/cli.py:7940-7949 (10 attempts × 500ms = 5s window).
 */
export async function waitForCdpReady(
  host: string,
  port: number,
  attempts: number = 10,
  intervalMs: number = 500,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probeCdpEndpoint(host, port, 1000)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * `GET /json/version` returns the top-level browser-target debugger URL.
 * `chrome-remote-interface` does this internally on connect, but we expose
 * it for diagnostics and direct-WebSocket callers.
 */
export async function discoverWebSocketUrl(
  host: string,
  port: number,
): Promise<string> {
  const res = await fetch(`http://${host}:${port}/json/version`);
  if (!res.ok) {
    throw new Error(
      `CDP /json/version returned ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) {
    throw new Error("CDP /json/version did not include webSocketDebuggerUrl");
  }
  return body.webSocketDebuggerUrl;
}

export interface LaunchResult {
  ok: boolean;
  pid?: number;
  binary?: string;
  kind?: BrowserKind;
  port?: number;
  reason?: string;
}

export interface LaunchOptions {
  /** Override the auto-picked free port (mostly for tests). */
  port?: number;
  /** Override the default isolated profile dir. */
  userDataDir?: string;
  /** Pin to a specific binary (skips candidate search). */
  binary?: string;
  /** Pin browser kind when a custom binary is supplied. */
  kind?: BrowserKind;
}

/**
 * Spawn the first available Chromium-family browser with the isolated-profile
 * flags set. Detaches the child so it survives the agent process; release
 * paths kill the PID explicitly.
 *
 * Returns `{ok:false, reason}` on no-binary-found / port-in-use / spawn-error
 * so the caller can surface a clean MCP tool result instead of throwing
 * past the dispatch layer.
 */
export async function tryLaunchIsolated(
  opts: LaunchOptions = {},
): Promise<LaunchResult> {
  const platform = process.platform;
  let chosen: BrowserCandidate | null = null;
  if (opts.binary) {
    chosen = { kind: opts.kind ?? "unknown", path: opts.binary };
  } else {
    const candidates = getBrowserCandidates(platform);
    chosen = candidates[0] ?? null;
  }
  if (!chosen) {
    return {
      ok: false,
      reason: `no Chromium-family browser found on ${platform}`,
    };
  }
  const userDataDir = opts.userDataDir ?? isolatedProfileDir();
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const port = opts.port ?? (await pickFreePort());

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  try {
    const child = execa(chosen.path, args, {
      detached: true,
      windowsHide: platform === "win32",
      stdio: "ignore",
      cleanup: false,
    });
    // Detach so the child outlives this process — we don't await it.
    child.unref?.();
    const pid = child.pid;
    const ready = await waitForCdpReady("127.0.0.1", port);
    if (!ready) {
      return {
        ok: false,
        pid,
        binary: chosen.path,
        kind: chosen.kind,
        port,
        reason: `CDP did not become ready on port ${port} within 5s`,
      };
    }
    return { ok: true, pid, binary: chosen.path, kind: chosen.kind, port };
  } catch (err) {
    return {
      ok: false,
      binary: chosen.path,
      kind: chosen.kind,
      port,
      reason: `spawn failed: ${(err as Error).message}`,
    };
  }
}

/**
 * String the user can paste into a terminal if the auto-launcher fails —
 * mirrors hermes' "manual fallback" pattern. Diagnostics-only; no shell
 * escaping needed because the user runs it themselves.
 */
export function manualLaunchCommand(
  port: number,
  platform: NodeJS.Platform,
): string | null {
  const userDataDir = isolatedProfileDir();
  if (platform === "darwin") {
    const c = DARWIN_APPS.find((c) => existsSync(c.path));
    if (!c) return null;
    return `"${c.path}" --remote-debugging-port=${port} --user-data-dir="${userDataDir}" --no-first-run --no-default-browser-check`;
  }
  if (platform === "win32") {
    const c = getBrowserCandidates("win32")[0];
    if (!c) return null;
    return `"${c.path}" --remote-debugging-port=${port} --user-data-dir="${userDataDir}" --no-first-run --no-default-browser-check`;
  }
  return null;
}
