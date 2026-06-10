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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Per-PROCESS profile dir, used only when the stable profile is already owned
 * by another LIVE axiomate. Chrome's single-instance lock forbids two
 * concurrent instances on one `--user-data-dir` (verified: the 2nd instance's
 * CDP port never opens — the lock forwards it to the 1st), so concurrent
 * axiomate processes MUST get distinct profiles or they collide.
 */
export function perProcessProfileDir(): string {
  return join(homedir(), ".axiomate", "browser-bridge", `profile-${process.pid}`);
}

/**
 * Pick the profile dir for THIS attach.
 *
 * Prefer the stable shared profile so a single axiomate's start/stop debugging
 * cycles keep the user's logged-in session (cookies/Login Data persist there).
 * But if that profile's session sidecar names a DIFFERENT, still-alive owner
 * pid — another axiomate is running and holds the single-instance lock — fall
 * back to a per-pid profile so we don't collide. A stale record (owner dead, or
 * it's our own pid) keeps us on the stable profile, preserving logins.
 */
export function selectProfileDir(): string {
  const stable = isolatedProfileDir();
  const prior = readSessionState(stable);
  if (
    prior &&
    typeof prior.ownerPid === "number" &&
    prior.ownerPid !== process.pid &&
    isPidAlive(prior.ownerPid)
  ) {
    return perProcessProfileDir();
  }
  return stable;
}

/**
 * Path to the small JSON sidecar where we record the browser we launched
 * ({pid, port}). Lives INSIDE the profile dir so it's scoped to that profile.
 * On the next attach we read it to (a) reconnect to a browser that survived an
 * agent crash, or (b) kill a zombie that's still holding the profile's
 * single-instance lock. We never touch the profile's data files, so the user's
 * logged-in session (cookies/Login Data) persists across attaches.
 */
function sessionStatePath(userDataDir: string): string {
  return join(userDataDir, ".bridge-session.json");
}

interface PersistedSession {
  /** Chrome process pid. */
  pid: number;
  port: number;
  kind?: BrowserKind;
  /** axiomate process pid that launched this browser (≠ Chrome pid). Lets a
   *  later attach tell "I previously launched here" from "another live
   *  axiomate owns this profile". Older records without it are treated as
   *  ownerless (safe: falls through to the stale-clear path). */
  ownerPid?: number;
}

function readSessionState(userDataDir: string): PersistedSession | null {
  try {
    const raw = readFileSync(sessionStatePath(userDataDir), "utf8");
    const v = JSON.parse(raw) as Partial<PersistedSession>;
    if (typeof v.pid === "number" && typeof v.port === "number") {
      return {
        pid: v.pid,
        port: v.port,
        kind: v.kind,
        ownerPid: typeof v.ownerPid === "number" ? v.ownerPid : undefined,
      };
    }
  } catch {
    // Missing/corrupt — treat as no prior session.
  }
  return null;
}

function writeSessionState(userDataDir: string, s: PersistedSession): void {
  try {
    writeFileSync(sessionStatePath(userDataDir), JSON.stringify(s), {
      mode: 0o600,
    });
  } catch {
    // Non-fatal: state-file write is an optimization, not correctness.
  }
}

/**
 * Forget the recorded session (called on clean detach). Prevents the next
 * attach from trying to kill a pid that may have been recycled by the OS to an
 * unrelated process. Defaults to the isolated profile dir.
 */
export function clearSessionState(userDataDir: string = isolatedProfileDir()): void {
  try {
    rmSync(sessionStatePath(userDataDir), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Is `pid` a live process we can see? process.kill(pid,0) is the safe
 * cross-platform liveness check in Node (ESRCH = gone, EPERM = alive but not
 * ours). Mirrors toolCalls.isSessionAlive's process half.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Confirm a CDP endpoint is not just an open socket but really a Chrome
 * DevTools endpoint, via GET /json/version. Guards reuse against another
 * process having grabbed the old port.
 */
async function isChromeCdp(port: number): Promise<boolean> {
  try {
    await discoverWebSocketUrl("127.0.0.1", port);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear a stale single-instance lock left by a prior bridge browser that
 * didn't exit cleanly (agent crash without detach). The lock is what makes a
 * fresh launch on the same profile silently forward to the dead instance and
 * never open its own CDP port ("CDP did not become ready").
 *
 * Windows: the lock is held by the PROCESS, not a file — there's no Singleton*
 * artifact to delete (verified: an idle bridge profile has none). Killing the
 * zombie pid releases it. POSIX: Chrome also leaves Singleton{Lock,Socket,
 * Cookie} symlinks that can outlive the process; remove them too.
 *
 * Only ever kills the pid WE recorded in the state file, never an arbitrary
 * process, and never deletes profile DATA — logins survive.
 */
function clearStaleLock(userDataDir: string, prior: PersistedSession): void {
  if (isPidAlive(prior.pid)) {
    try {
      process.kill(prior.pid);
    } catch {
      // Already gone or not ours — best effort.
    }
  }
  if (process.platform !== "win32") {
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        rmSync(join(userDataDir, name), { force: true });
      } catch {
        // best effort
      }
    }
  }
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
  /** True when we reconnected to a browser that survived (no new spawn). */
  reused?: boolean;
  /** Profile dir actually used (stable or per-pid) — for scoped cleanup. */
  userDataDir?: string;
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
  // Stable profile when free; per-pid profile when another live axiomate owns
  // it (Chrome single-instance lock forbids sharing concurrently). A pinned
  // userDataDir (tests) overrides selection.
  const userDataDir = opts.userDataDir ?? selectProfileDir();
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });

  // Reuse-or-clear: a prior bridge browser recorded in the profile's state
  // file may have (a) survived an agent crash — reconnect to it, keeping its
  // tabs and avoiding a needless relaunch — or (b) died but left the profile's
  // single-instance lock held, which would make a fresh launch silently
  // forward to the dead instance and never open CDP. Skip when the caller
  // pinned a port (tests) so this stays deterministic.
  if (opts.port === undefined) {
    const prior = readSessionState(userDataDir);
    // Only consider reusing/clearing a record we OWN (or a legacy ownerless
    // one). A record owned by a different LIVE axiomate means selectProfileDir
    // already routed us to a per-pid profile, so we won't see it here; but if a
    // different owner is DEAD, its browser is ours to clean up.
    const reusable =
      prior &&
      (prior.ownerPid === undefined ||
        prior.ownerPid === process.pid ||
        !isPidAlive(prior.ownerPid));
    if (prior && reusable) {
      if (isPidAlive(prior.pid) && (await isChromeCdp(prior.port))) {
        return {
          ok: true,
          pid: prior.pid,
          binary: chosen.path,
          kind: prior.kind ?? chosen.kind,
          port: prior.port,
          reused: true,
          userDataDir,
        };
      }
      // Stale: kill the zombie holding the lock (+ POSIX Singleton symlinks).
      clearStaleLock(userDataDir, prior);
    }
  }

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
    // We intentionally never await `child`, so swallow its eventual
    // settlement: when the browser later exits (or we kill it), execa would
    // otherwise surface an unhandled promise rejection.
    child.catch(() => {});
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
    // Record what we launched so the next attach can reuse it or clear its
    // stale lock. Only on a confirmed-ready launch with a real pid. ownerPid is
    // THIS axiomate so a concurrent instance can tell our profile is taken.
    if (pid !== undefined) {
      writeSessionState(userDataDir, {
        pid,
        port,
        kind: chosen.kind,
        ownerPid: process.pid,
      });
    }
    return { ok: true, pid, binary: chosen.path, kind: chosen.kind, port, userDataDir };
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
