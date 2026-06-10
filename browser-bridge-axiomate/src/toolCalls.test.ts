import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every runAgentBrowser call so we can assert the argv each tool builds.
const calls = vi.hoisted(() => [] as Array<{ args: string[]; opts: any }>);
const mockState = vi.hoisted(() => ({
  // Default: every agent-browser call succeeds with empty stdout.
  result: { ok: true, stdout: "", stderr: "" } as any,
  // Per-subcommand stdout overrides keyed by the first arg.
  stdoutByCmd: {} as Record<string, string>,
  launchOk: true,
  // isSessionAlive's CDP-probe half (process.kill half always passes since we
  // launch with process.pid). Flip to false to simulate the browser dying.
  browserAlive: true,
}));

vi.mock("./agentBrowserClient.js", () => ({
  AGENT_BROWSER_SESSION: "axiomate-bridge",
  runAgentBrowser: vi.fn(async (args: string[], opts: any) => {
    calls.push({ args, opts });
    const override = mockState.stdoutByCmd[args[0]!];
    if (override !== undefined) return { ok: true, stdout: override, stderr: "" };
    return mockState.result;
  }),
}));

vi.mock("./launcher.js", () => ({
  tryLaunchIsolated: vi.fn(async () =>
    mockState.launchOk
      ? { ok: true, pid: 4242, kind: "chrome", port: 9222 }
      : { ok: false, reason: "no browser found" },
  ),
  // isSessionAlive probes the CDP port; mockState.browserAlive controls it so
  // tests can simulate the browser dying. The process.kill half is stubbed in
  // beforeEach (see killSpy) so liveness is driven purely by this probe.
  probeCdpEndpoint: vi.fn(async () => mockState.browserAlive),
}));

import {
  __resetBridgeForTesting,
  dispatchBrowserBridgeTool,
} from "./toolCalls.js";

function lastCall() {
  return calls[calls.length - 1];
}
function text(r: any): string {
  const c = r.content?.[0];
  return c && "text" in c ? String(c.text) : "";
}

beforeEach(() => {
  calls.length = 0;
  mockState.result = { ok: true, stdout: "", stderr: "" };
  mockState.stdoutByCmd = {};
  mockState.launchOk = true;
  mockState.browserAlive = true;
  // Stub process.kill so the bridge never signals a real PID: the mock pid
  // (4242) isn't ours, and detach/attach-failure call process.kill(pid) for
  // real — under vitest's worker that SIGTERM would kill the test process
  // itself. Returning true keeps liveness's process.kill(pid,0) half happy;
  // the CDP-probe mock is what actually drives alive/dead.
  vi.spyOn(process, "kill").mockReturnValue(true as never);
});
afterEach(() => {
  __resetBridgeForTesting();
  vi.restoreAllMocks();
});

async function attach() {
  return dispatchBrowserBridgeTool("browser_attach", {});
}

describe("browser-bridge attach/detach lifecycle", () => {
  it("attaches by launching a browser and connecting agent-browser to its port", async () => {
    const r = await attach();
    expect(r.isError).toBeFalsy();
    // agent-browser connect was called with the launcher's port.
    const connect = calls.find((c) => c.args[0] === "connect");
    expect(connect?.args).toEqual(["connect", "9222"]);
    expect(connect?.opts.cdpPort).toBe(9222);
    expect(text(r)).toContain('"state": "attached"');
  });

  it("reports not-attached for tools before attach", async () => {
    const r = await dispatchBrowserBridgeTool("browser_snapshot", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not attached/i);
  });

  it("fails attach cleanly when no browser is found", async () => {
    mockState.launchOk = false;
    const r = await attach();
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/attach failed/i);
  });

  it("detach closes the agent-browser session and resets state", async () => {
    await attach();
    const r = await dispatchBrowserBridgeTool("browser_detach", {});
    expect(r.isError).toBeFalsy();
    expect(calls.some((c) => c.args[0] === "close")).toBe(true);
    // After detach, tools require re-attach.
    const snap = await dispatchBrowserBridgeTool("browser_snapshot", {});
    expect(snap.isError).toBe(true);
  });
});

describe("browser-bridge tool → agent-browser subcommand mapping", () => {
  beforeEach(async () => {
    await attach();
    calls.length = 0; // ignore the connect call
  });

  it("navigate → open <url>", async () => {
    await dispatchBrowserBridgeTool("browser_navigate", { url: "https://x.test" });
    expect(lastCall().args).toEqual(["open", "https://x.test"]);
    expect(lastCall().opts.cdpPort).toBe(9222);
  });

  it("snapshot → snapshot --compact, passes stdout through", async () => {
    mockState.stdoutByCmd["snapshot"] = '- button "Go" [ref=e1]';
    const r = await dispatchBrowserBridgeTool("browser_snapshot", {});
    expect(lastCall().args).toContain("snapshot");
    expect(lastCall().args).toContain("--compact");
    expect(text(r)).toContain("[ref=e1]");
  });

  it("click → click @ref", async () => {
    await dispatchBrowserBridgeTool("browser_click", { ref: "@e1" });
    expect(lastCall().args).toEqual(["click", "@e1"]);
  });

  it("click count 2 → dblclick", async () => {
    await dispatchBrowserBridgeTool("browser_click", { ref: "@e1", clickCount: 2 });
    expect(lastCall().args).toEqual(["dblclick", "@e1"]);
  });

  it("type → fill @ref text", async () => {
    await dispatchBrowserBridgeTool("browser_type", { ref: "@e2", text: "hi" });
    expect(lastCall().args).toEqual(["fill", "@e2", "hi"]);
  });

  it("press → press key", async () => {
    await dispatchBrowserBridgeTool("browser_press", { key: "Enter" });
    expect(lastCall().args).toEqual(["press", "Enter"]);
  });

  it("scroll → scroll dir amount", async () => {
    await dispatchBrowserBridgeTool("browser_scroll", { direction: "down", amount: 300 });
    expect(lastCall().args).toEqual(["scroll", "down", "300"]);
  });

  it("back/forward/reload map 1:1", async () => {
    await dispatchBrowserBridgeTool("browser_back", {});
    expect(lastCall().args).toEqual(["back"]);
    await dispatchBrowserBridgeTool("browser_forward", {});
    expect(lastCall().args).toEqual(["forward"]);
    await dispatchBrowserBridgeTool("browser_reload", {});
    expect(lastCall().args).toEqual(["reload"]);
  });

  it("tab_list → tab list", async () => {
    await dispatchBrowserBridgeTool("browser_tab_list", {});
    expect(lastCall().args).toEqual(["tab", "list"]);
  });

  it("tab_switch → tab <id>", async () => {
    await dispatchBrowserBridgeTool("browser_tab_switch", { targetId: "3" });
    expect(lastCall().args).toEqual(["tab", "3"]);
  });

  it("dialog accept with prompt text", async () => {
    await dispatchBrowserBridgeTool("browser_dialog", { action: "accept", promptText: "yes" });
    expect(lastCall().args).toEqual(["dialog", "accept", "yes"]);
  });

  it("console → console, passes output through", async () => {
    mockState.stdoutByCmd["console"] = "log: hello";
    const r = await dispatchBrowserBridgeTool("browser_console", {});
    expect(lastCall().args).toEqual(["console"]);
    expect(text(r)).toContain("log: hello");
  });

  it("maps a failed agent-browser call to an MCP error", async () => {
    mockState.result = { ok: false, stdout: "", stderr: "", error: "boom" };
    const r = await dispatchBrowserBridgeTool("browser_navigate", { url: "https://x.test" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/navigate failed: boom/);
  });
});

describe("browser-bridge status detects a dead browser", () => {
  it("flips to detached when the browser is gone (was: stale 'attached')", async () => {
    await attach();
    // Simulate the user closing the browser: CDP port no longer reachable.
    mockState.browserAlive = false;
    const r = await dispatchBrowserBridgeTool("browser_status", {});
    expect(text(r)).toContain('"state": "detached"');
    expect(text(r)).toMatch(/browser exited/i);
    // And subsequent tools require re-attach.
    const snap = await dispatchBrowserBridgeTool("browser_snapshot", {});
    expect(snap.isError).toBe(true);
    expect(text(snap)).toMatch(/not attached/i);
  });

  it("stays attached while the browser is alive", async () => {
    await attach();
    const r = await dispatchBrowserBridgeTool("browser_status", {});
    expect(text(r)).toContain('"state": "attached"');
  });
});

describe("browser-bridge status surfaces dialogs natively", () => {
  it("includes pendingDialog when agent-browser dialog status reports one", async () => {
    await attach();
    mockState.stdoutByCmd["dialog"] = 'confirm: "Delete everything?"';
    const r = await dispatchBrowserBridgeTool("browser_status", {});
    expect(lastCall().args).toEqual(["dialog", "status"]);
    expect(text(r)).toContain("pendingDialog");
    expect(text(r)).toContain("Delete everything?");
  });
});
