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

import { execa } from "execa";
import { resolveAgentBrowserPath } from "./agentBrowser.js";

/** Fixed session name so all our calls target the same agent-browser session. */
export const AGENT_BROWSER_SESSION = "axiomate-bridge";

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
  argv.push(...args);

  try {
    const result = await execa(bin, argv, {
      timeout: opts.timeoutMs ?? 30_000,
      reject: false,
      stripFinalNewline: true,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error:
          (result.stderr || result.stdout || `exited with code ${result.exitCode}`)
            .slice(0, 600),
      };
    }
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (e) {
    // execa with reject:false still throws on spawn errors (ENOENT) / timeout.
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
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
