import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runAgentBrowser shells out via node:child_process spawn (NOT execa) so it can
// resolve on the process `exit` event instead of stream `close` — agent-browser's
// connect daemon inherits and holds the stdout/stderr pipe open forever, so a
// close-based wait (execa) hangs. These tests fake spawn to (a) assert the argv
// we inject and (b) lock in the exit-not-close contract as a regression guard.

interface FakeChildOpts {
  /** Fire `exit` after this many ms (default 0 = next tick). */
  exitAfterMs?: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  /** When true, NEVER emit `close` (models the daemon holding the pipe). */
  neverClose?: boolean;
  /** Emit an `error` event instead of exiting (spawn failure). */
  spawnError?: string;
}

const spawnCalls = vi.hoisted(
  () => [] as Array<{ bin: string; argv: string[] }>,
);
const nextChildOpts = vi.hoisted(() => ({ current: {} as FakeChildOpts }));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { destroy: () => void };
  stderr = new EventEmitter() as EventEmitter & { destroy: () => void };
  killed = false;
  closeEmitted = false;
  constructor(opts: FakeChildOpts) {
    super();
    this.stdout.destroy = () => {};
    this.stderr.destroy = () => {};
    queueMicrotask(() => {
      if (opts.spawnError) {
        this.emit("error", new Error(opts.spawnError));
        return;
      }
      if (opts.stdout) this.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) this.stderr.emit("data", Buffer.from(opts.stderr));
      const fire = () => {
        this.emit("exit", opts.exitCode ?? 0);
        // The daemon-pipe bug: process exits but `close` never comes. When
        // neverClose is set we model exactly that — if runAgentBrowser waited
        // for close it would hang and the test would time out.
        if (!opts.neverClose) {
          this.closeEmitted = true;
          this.emit("close", opts.exitCode ?? 0);
        }
      };
      if (opts.exitAfterMs && opts.exitAfterMs > 0) {
        setTimeout(fire, opts.exitAfterMs);
      } else {
        fire();
      }
    });
  }
  kill(): boolean {
    this.killed = true;
    // A killed process still emits exit; never a close in the bug scenario.
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, argv: string[]) => {
    spawnCalls.push({ bin, argv });
    return new FakeChild(nextChildOpts.current);
  }),
}));

vi.mock("./agentBrowser.js", () => ({
  resolveAgentBrowserPath: vi.fn(() => "/fake/agent-browser"),
}));

import { runAgentBrowser, AGENT_BROWSER_SESSION } from "./agentBrowserClient.js";

beforeEach(() => {
  spawnCalls.length = 0;
  nextChildOpts.current = {};
});
afterEach(() => {
  vi.clearAllMocks();
});

function lastArgv(): string[] {
  return spawnCalls[spawnCalls.length - 1]!.argv;
}

describe("runAgentBrowser argv injection", () => {
  it("prefixes --cdp, --session, and --no-auto-dialog before the subcommand", async () => {
    await runAgentBrowser(["open", "https://x.test"], { cdpPort: 9222 });
    expect(lastArgv()).toEqual([
      "--cdp",
      "9222",
      "--session",
      AGENT_BROWSER_SESSION,
      "--no-auto-dialog",
      "open",
      "https://x.test",
    ]);
  });

  it("always sets --no-auto-dialog (hermes must_respond parity) even without a port", async () => {
    await runAgentBrowser(["snapshot"]);
    expect(lastArgv()).toContain("--no-auto-dialog");
    expect(lastArgv()).not.toContain("--cdp");
    const i = lastArgv().indexOf("--no-auto-dialog");
    expect(i).toBeLessThan(lastArgv().indexOf("snapshot"));
  });

  it("scopes the session name to this process (concurrent-instance isolation)", async () => {
    // A fixed name made instance B reuse instance A's daemon; the pid suffix
    // gives each axiomate its own daemon and lets shutdown target only its own.
    expect(AGENT_BROWSER_SESSION).toBe(`axiomate-bridge-${process.pid}`);
  });

  it("maps a non-zero exit to ok:false with stderr surfaced", async () => {
    nextChildOpts.current = { exitCode: 2, stderr: "boom" };
    const r = await runAgentBrowser(["click", "@e1"], { cdpPort: 9222 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
  });
});

describe("runAgentBrowser daemon-pipe contract (the attach-hangs-forever bug)", () => {
  it("resolves on `exit` even when `close` never fires (daemon holds the pipe)", async () => {
    // This is THE regression test. neverClose models agent-browser's connect
    // daemon keeping the inherited stdout/stderr pipe open forever. If the
    // implementation ever reverts to awaiting `close`, this test hangs and the
    // suite's per-test timeout fails it — exactly the user-facing symptom.
    nextChildOpts.current = {
      exitCode: 0,
      stdout: "✓ Done",
      neverClose: true,
    };
    const r = await runAgentBrowser(["connect", "9333"], {
      cdpPort: 9333,
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("✓ Done");
  });

  it("still captures buffered stdout when exit lags the output (no truncation)", async () => {
    nextChildOpts.current = {
      exitCode: 0,
      stdout: "line one\nline two\n",
      exitAfterMs: 20,
      neverClose: true,
    };
    const r = await runAgentBrowser(["snapshot"], { timeoutMs: 2000 });
    expect(r.ok).toBe(true);
    // Trailing newline stripped, interior newline preserved.
    expect(r.stdout).toBe("line one\nline two");
  });

  it("times out and reports it when the process itself is genuinely stuck", async () => {
    // Process never exits AND never closes — a real hang, not the daemon case.
    // The timeoutMs backstop must kill it and surface a timeout error.
    nextChildOpts.current = { exitAfterMs: 100_000, neverClose: true };
    const r = await runAgentBrowser(["snapshot"], { timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/i);
  });

  it("reports a spawn error (ENOENT) as ok:false", async () => {
    nextChildOpts.current = { spawnError: "spawn ENOENT" };
    const r = await runAgentBrowser(["snapshot"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ENOENT");
  });
});
