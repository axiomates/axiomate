/**
 * Thin wrapper around the bundled agent-browser CLI (Vercel Labs, Apache-2.0
 * native Rust CDP daemon). Every browser_* tool is implemented by shelling out
 * to an agent-browser subcommand against the user's LOCAL browser that
 * launcher.ts started — we always pass `--cdp <port>` so agent-browser attaches
 * to our browser and never downloads/launches its own Chrome.
 *
 * Why a wrapper: (1) one place to inject `--cdp <port>` + `--session <name>` so
 * agent-browser's stateful `connect` persistence can't leak across our calls,
 * (2) uniform error/exit handling into MCP-friendly results, (3) a single seam
 * if the CLI contract shifts.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentBrowserPath } from "./agentBrowser.js";

/**
 * Per-PROCESS agent-browser session name. Each axiomate process gets its own
 * `axiomate-bridge-<pid>` daemon so concurrent axiomate instances never share
 * (and stomp) one daemon: a fixed name made instance B's `ensure_daemon`
 * silently reuse instance A's daemon — wrong browser, crossed wires, and a
 * shutdown in A would tear down B. The pid suffix isolates them. It also lets
 * shutdown target ONLY our own daemon (`--session <this> close`), never the
 * `close --all` sledgehammer that would kill every instance's daemon.
 */
export const AGENT_BROWSER_SESSION = `axiomate-bridge-${process.pid}`;

/**
 * Read the real PID of OUR daemon from agent-browser's `<session>.pid` file.
 *
 * The daemon writes its own process id there at startup (agent-browser
 * daemon.rs). We need the DAEMON's pid — not the foreground CLI's, which exits
 * in ~200ms — so we can jail it (processJail.ts) and have the kernel reap it
 * when axiomate exits. The CLI we spawn is a different, short-lived process, so
 * its pid is useless for that.
 *
 * Socket dir mirrors agent-browser's own resolution (connection.rs get_socket_dir):
 * AGENT_BROWSER_SOCKET_DIR override, else ~/.agent-browser. Returns undefined if
 * the file is missing/unreadable/not-a-number (daemon not up yet, or a layout we
 * don't recognize) — the caller treats jailing as best-effort.
 */
export function readDaemonPid(): number | undefined {
  const dir = process.env.AGENT_BROWSER_SOCKET_DIR || join(homedir(), ".agent-browser");
  try {
    const raw = readFileSync(join(dir, `${AGENT_BROWSER_SESSION}.pid`), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export interface AgentBrowserResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Non-zero exit / spawn failure detail, for surfacing to the agent. */
  error?: string;
}

export interface AgentBrowserRunOptions {
  /** CDP port of the launcher-started browser to attach to. */
  cdpPort?: number;
  /** Per-call timeout (ms). Snapshots/navigation can be slow. */
  timeoutMs?: number;
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Spawn agent-browser and resolve on the process's `exit` event with whatever
 * stdout/stderr we buffered — NOT on stream `close`.
 *
 * Why not execa (or anything that awaits `close`): agent-browser's `connect`
 * forks a long-lived DETACHED daemon (cli/src/connection.rs:677-696) that it
 * spawns with `stderr(Stdio::piped())`. On Windows that detached child inherits
 * the foreground process's handle table, so the inherited stderr pipe's
 * write-end stays open in the daemon for the daemon's whole lifetime. The
 * foreground process exits in ~200ms with its output complete, but the pipe
 * never reaches EOF — so `close` never fires and execa's promise hangs forever.
 * execa's own `timeout` can't rescue it: the foreground process has already
 * exited, so there's nothing left to SIGTERM while the pipe stays open. That
 * was the "browser_attach runs forever" bug.
 *
 * Resolving on `exit` (process gone) instead of `close` (pipes drained) sidesteps
 * the inherited-handle entirely: by `exit` the foreground process has flushed
 * all of its own output, and we then destroy our read ends so the inherited
 * write-end in the daemon can't keep us alive. We still enforce timeoutMs by
 * killing the process group as a backstop for a genuinely stuck command.
 */
function spawnAgentBrowser(
  bin: string,
  argv: string[],
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    const child = spawn(bin, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (o: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Drop our read ends so the daemon's inherited write-end can't keep the
      // event loop (or this handle) alive after we've already resolved.
      try {
        child.stdout?.destroy();
      } catch {
        /* already gone */
      }
      try {
        child.stderr?.destroy();
      } catch {
        /* already gone */
      }
      resolve(o);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    // Resolve on `exit` (process terminated), NOT `close` (all stdio EOF) — see
    // the function-level comment for why `close` never arrives here.
    child.on("exit", (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut: false });
    });
    child.on("error", (e) => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: e instanceof Error ? e.message : String(e),
      });
    });
  });
}

/**
 * Run one agent-browser subcommand. Builds argv as
 *   [--cdp <port>] [--session axiomate-bridge] <args...>
 * Never throws on a non-zero exit — returns {ok:false, error} so the dispatch
 * layer can map it to an MCP error result.
 */
export async function runAgentBrowser(
  args: string[],
  opts: AgentBrowserRunOptions = {},
): Promise<AgentBrowserResult> {
  const bin = resolveAgentBrowserPath();
  if (!bin) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error:
        "agent-browser binary not found. Run `pnpm run bootstrap` (dev) or " +
        "ensure agent-browser[.exe] sits next to axiomate.exe (packaged).",
    };
  }

  const argv: string[] = [];
  if (opts.cdpPort !== undefined) argv.push("--cdp", String(opts.cdpPort));
  argv.push("--session", AGENT_BROWSER_SESSION);
  // Align with hermes's default dialog_policy="must_respond": agent-browser
  // OTHERWISE auto-dismisses alert/beforeunload before the agent ever sees
  // them. --no-auto-dialog keeps them open so the agent can inspect via
  // `browser_status` (dialog status) and answer via `browser_dialog`. It's a
  // global flag (same class as --cdp/--session), harmless on commands that
  // can't raise a dialog, so we set it on every call for a consistent policy.
  // (We can't replicate hermes's 300s watchdog or recent_dialogs history —
  // the CLI doesn't expose them — but each call's timeoutMs bounds a stuck
  // dialog to one tool failure, never a permanent agent hang.)
  argv.push("--no-auto-dialog");
  argv.push(...args);

  const result = await spawnAgentBrowser(bin, argv, opts.timeoutMs ?? 30_000);
  const stdout = result.stdout.replace(/\r?\n$/, "");
  const stderr = result.stderr.replace(/\r?\n$/, "");

  if (result.spawnError) {
    // Spawn failed outright (e.g. ENOENT) — never even started.
    return { ok: false, stdout: "", stderr: "", error: result.spawnError };
  }
  if (result.timedOut) {
    return {
      ok: false,
      stdout,
      stderr,
      error: `agent-browser timed out after ${opts.timeoutMs ?? 30_000}ms`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
      error: (stderr || stdout || `exited with code ${result.exitCode}`).slice(
        0,
        600,
      ),
    };
  }
  return { ok: true, stdout, stderr };
}

/** Run and parse `--json` output. Returns null parse on non-ok or bad JSON. */
export async function runAgentBrowserJson<T = unknown>(
  args: string[],
  opts: AgentBrowserRunOptions = {},
): Promise<{ ok: boolean; data?: T; error?: string; raw: string }> {
  const r = await runAgentBrowser([...args, "--json"], opts);
  if (!r.ok) return { ok: false, error: r.error, raw: r.stdout };
  try {
    return { ok: true, data: JSON.parse(r.stdout) as T, raw: r.stdout };
  } catch {
    // Some subcommands emit plain text even with --json; hand back raw.
    return { ok: true, raw: r.stdout };
  }
}
