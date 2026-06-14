import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every runAgentBrowser call so we can assert the argv each tool builds.
const calls = vi.hoisted(() => [] as Array<{ args: string[]; opts: any }>);
// Capture pids passed to jailProcess (Chrome + daemon) so attach can be asserted
// to bind both to the kill-on-exit job.
const jailedPids = vi.hoisted(() => [] as number[]);
const mockState = vi.hoisted(() => ({
  // Default: every agent-browser call succeeds with empty stdout.
  result: { ok: true, stdout: "", stderr: "" } as any,
  // Per-subcommand stdout overrides keyed by the first arg.
  stdoutByCmd: {} as Record<string, string>,
  launchOk: true,
  // When true, tryLaunchIsolated THROWS (models mkdirSync EACCES / pickFreePort
  // reject that sit outside its own try) — used to prove attach never wedges in
  // the "attaching" state.
  launchThrows: false,
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
  // attach reads this to jail the daemon; a fixed pid is fine — jailProcess is
  // mocked to record calls, not signal anything.
  readDaemonPid: vi.fn(() => 5252),
}));

// Record jailed pids so a test can assert attach jails BOTH the Chrome pid and
// the daemon pid. The real module is a Bun/Windows-only FFI no-op under vitest;
// mocking it keeps the assertion explicit and platform-independent.
vi.mock("./processJail.js", () => ({
  jailProcess: vi.fn(async (pid?: number) => {
    if (pid !== undefined) jailedPids.push(pid);
  }),
}));

vi.mock("./launcher.js", () => ({
  tryLaunchIsolated: vi.fn(async () => {
    if (mockState.launchThrows) throw new Error("mkdirSync EACCES");
    return mockState.launchOk
      ? { ok: true, pid: 4242, kind: "chrome", port: 9222, userDataDir: "/p" }
      : { ok: false, reason: "no browser found" };
  }),
  // isSessionAlive probes the CDP port; mockState.browserAlive controls it so
  // tests can simulate the browser dying. The process.kill half is stubbed in
  // beforeEach (see killSpy) so liveness is driven purely by this probe.
  probeCdpEndpoint: vi.fn(async () => mockState.browserAlive),
}));

import {
  __resetBridgeForTesting,
  dispatchBrowserBridgeTool,
  shutdownBridge,
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
  jailedPids.length = 0;
  mockState.result = { ok: true, stdout: "", stderr: "" };
  mockState.stdoutByCmd = {};
  mockState.launchOk = true;
  mockState.launchThrows = false;
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

  it("jails BOTH the launched Chrome pid and the daemon pid on attach", async () => {
    await attach();
    // The kernel-reap safety net (Windows Job Object) only protects pids we
    // explicitly jail. Chrome (4242 from the launcher mock) must be jailed
    // before connect; the daemon (5252 from readDaemonPid mock) after connect.
    expect(jailedPids).toContain(4242);
    expect(jailedPids).toContain(5252);
  });

  it("reports not-attached for tools before attach", async () => {
    const r = await dispatchBrowserBridgeTool("browser_snapshot", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not attached/i);
  });

  it("a page call after the browser died fails FAST with a re-attach hint (not a passthrough timeout)", async () => {
    await attach();
    calls.length = 0;
    // Browser dies; the AI calls click directly (no status first).
    mockState.browserAlive = false;
    const r = await dispatchBrowserBridgeTool("browser_click", { ref: "@e1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/was closed|re-?attach|relaunch/i);
    // Crucially, the call was NOT forwarded to agent-browser (which would spend
    // ~6s on CDP discovery and return a cryptic error).
    expect(calls.some((c) => c.args[0] === "click")).toBe(false);
  });

  it("re-attach when still alive is a no-op early-return (no new connect)", async () => {
    await attach();
    calls.length = 0;
    // Browser still alive → "already attached" fast path, no relaunch.
    const r = await dispatchBrowserBridgeTool("browser_attach", {});
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/already attached/i);
    expect(calls.some((c) => c.args[0] === "connect")).toBe(false);
  });

  it("re-attach after the browser died relaunches instead of falsely echoing the stale session", async () => {
    await attach();
    calls.length = 0;
    // Browser died: in-memory state is still "attached", but a probe must catch
    // it. attach must NOT take the "already attached" early-return — it must
    // detect death (markDetached) and relaunch (fresh connect).
    mockState.browserAlive = false;
    const r = await dispatchBrowserBridgeTool("browser_attach", {});
    expect(r.isError).toBeFalsy();
    // Proof it relaunched rather than echoing stale state: a fresh connect ran,
    // and the message is a real attach, not "already attached".
    expect(calls.some((c) => c.args[0] === "connect")).toBe(true);
    expect(text(r)).not.toMatch(/already attached/i);
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

  it("detach kills our Chrome pid and closes our daemon", async () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    await attach();
    calls.length = 0;
    await dispatchBrowserBridgeTool("browser_detach", {});
    // Closes our own daemon (pinned --session, never close --all).
    expect(calls.some((c) => c.args[0] === "close")).toBe(true);
    // Kills the Chrome pid we launched (4242 from the mock).
    expect(killSpy).toHaveBeenCalledWith(4242);
  });

  it("shutdownBridge tears down the same way on process exit", async () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    await attach();
    calls.length = 0;
    await shutdownBridge();
    expect(calls.some((c) => c.args[0] === "close")).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4242);
    // And state is reset so a later call requires re-attach.
    const snap = await dispatchBrowserBridgeTool("browser_snapshot", {});
    expect(snap.isError).toBe(true);
  });

  it("a THROW during launch never wedges the session in 'attaching'", async () => {
    mockState.launchThrows = true;
    const r1 = await attach();
    expect(r1.isError).toBe(true);
    // The bug this guards: a throw left state='attaching' so every later attach
    // returned "already in progress" until restart. State must be back to
    // detached, so a subsequent (now-succeeding) attach works.
    expect(text(r1)).not.toMatch(/already in progress/i);
    mockState.launchThrows = false;
    const r2 = await attach();
    expect(r2.isError).toBeFalsy();
    expect(text(r2)).toMatch(/attached/i);
  });

  it("status detecting a dead browser reports detached", async () => {
    await attach();
    // Browser dies out from under us.
    mockState.browserAlive = false;
    const r = await dispatchBrowserBridgeTool("browser_status", {});
    expect(text(r)).toMatch(/browser exited/i);
    // And subsequent page calls require re-attach (state was reset).
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

  it("double=true → dblclick", async () => {
    await dispatchBrowserBridgeTool("browser_click", { ref: "@e1", double: true });
    expect(lastCall().args).toEqual(["dblclick", "@e1"]);
  });

  it("click never forwards a --button flag (agent-browser click has none)", async () => {
    await dispatchBrowserBridgeTool("browser_click", {
      ref: "@e1",
      button: "right",
    } as { ref: string });
    // The bogus button arg is dropped, not translated into a silent left-click
    // with a misleading --button flag appended.
    expect(lastCall().args).toEqual(["click", "@e1"]);
    expect(lastCall().args).not.toContain("--button");
  });

  it("type → type @ref text (does not clear existing content)", async () => {
    await dispatchBrowserBridgeTool("browser_type", { ref: "@e2", text: "hi" });
    expect(lastCall().args).toEqual(["type", "@e2", "hi"]);
  });

  it("press → press key", async () => {
    await dispatchBrowserBridgeTool("browser_press", { key: "Enter" });
    expect(lastCall().args).toEqual(["press", "Enter"]);
  });

  it("scroll → scroll dir amount", async () => {
    await dispatchBrowserBridgeTool("browser_scroll", { direction: "down", amount: 300 });
    expect(lastCall().args).toEqual(["scroll", "down", "300"]);
  });

  it("scroll with selector → scroll dir amount --selector", async () => {
    await dispatchBrowserBridgeTool("browser_scroll", {
      direction: "up",
      amount: 100,
      selector: "@e9",
    });
    expect(lastCall().args).toEqual(["scroll", "up", "100", "--selector", "@e9"]);
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

  it("tab_new with url → tab new <url>", async () => {
    await dispatchBrowserBridgeTool("browser_tab_new", { url: "https://x.test" });
    expect(lastCall().args).toEqual(["tab", "new", "https://x.test"]);
  });

  it("tab_close with targetId → tab close <id>", async () => {
    await dispatchBrowserBridgeTool("browser_tab_close", { targetId: "t2" });
    expect(lastCall().args).toEqual(["tab", "close", "t2"]);
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

  it("console with expression → eval <expression>, returns eval stdout", async () => {
    mockState.stdoutByCmd["eval"] = "42";
    const r = await dispatchBrowserBridgeTool("browser_console", {
      expression: "document.querySelectorAll('button').length",
    });
    expect(lastCall().args).toEqual([
      "eval",
      "document.querySelectorAll('button').length",
    ]);
    expect(text(r)).toBe("42");
  });

  it("get_images applies the schema limit in page eval", async () => {
    await dispatchBrowserBridgeTool("browser_get_images", { limit: 3 });
    expect(lastCall().args[0]).toBe("eval");
    expect(lastCall().args[1]).toContain(".slice(0,3)");
  });

  it("maps a failed agent-browser call to an MCP error", async () => {
    mockState.result = { ok: false, stdout: "", stderr: "", error: "boom" };
    const r = await dispatchBrowserBridgeTool("browser_navigate", { url: "https://x.test" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/navigate failed: boom/);
  });

  it("snapshot passes optional schema fields through", async () => {
    await dispatchBrowserBridgeTool("browser_snapshot", {
      interactive: true,
      urls: true,
      depth: 4,
      selector: "#main",
    });
    expect(lastCall().args).toEqual([
      "snapshot",
      "--compact",
      "--interactive",
      "--urls",
      "--depth",
      "4",
      "--selector",
      "#main",
    ]);
  });
});

describe("browser-bridge semantic + interaction tools (find/upload/select/hover/wait)", () => {
  beforeEach(async () => {
    await attach();
    calls.length = 0;
  });

  it("find role with name → always emits explicit action before --name", async () => {
    await dispatchBrowserBridgeTool("browser_find", {
      locator: "role",
      value: "button",
      name: "Submit",
    });
    // action defaults to click and MUST precede --name, else agent-browser
    // parses --name as the action slot ("Unknown subaction").
    expect(lastCall().args).toEqual([
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Submit",
    ]);
  });

  it("find with no action defaults to explicit click", async () => {
    await dispatchBrowserBridgeTool("browser_find", { locator: "text", value: "Next" });
    expect(lastCall().args).toEqual(["find", "text", "Next", "click"]);
  });

  it("find with fill action carries the text positionally", async () => {
    await dispatchBrowserBridgeTool("browser_find", {
      locator: "label",
      value: "Email",
      action: "fill",
      text: "a@b.test",
    });
    expect(lastCall().args).toEqual(["find", "label", "Email", "fill", "a@b.test"]);
  });

  it("find drops text for non-fill actions and adds --exact", async () => {
    await dispatchBrowserBridgeTool("browser_find", {
      locator: "text",
      value: "Next",
      action: "hover",
      text: "ignored",
      exact: true,
    });
    expect(lastCall().args).toEqual(["find", "text", "Next", "hover", "--exact"]);
  });

  it("upload → upload <selector> <files...>", async () => {
    await dispatchBrowserBridgeTool("browser_upload", {
      selector: "@e3",
      files: ["/a.png", "/b.png"],
    });
    expect(lastCall().args).toEqual(["upload", "@e3", "/a.png", "/b.png"]);
  });

  it("select → select <selector> <values...>", async () => {
    await dispatchBrowserBridgeTool("browser_select", {
      selector: "#country",
      values: ["US", "CA"],
    });
    expect(lastCall().args).toEqual(["select", "#country", "US", "CA"]);
  });

  it("hover → hover <selector>", async () => {
    await dispatchBrowserBridgeTool("browser_hover", { selector: "@e4" });
    expect(lastCall().args).toEqual(["hover", "@e4"]);
  });

  it("wait selector → wait <selector>", async () => {
    await dispatchBrowserBridgeTool("browser_wait", { selector: "#spinner" });
    expect(lastCall().args).toEqual(["wait", "#spinner"]);
  });

  it("wait ms → wait <ms>", async () => {
    await dispatchBrowserBridgeTool("browser_wait", { ms: 500 });
    expect(lastCall().args).toEqual(["wait", "500"]);
  });

  it("wait conditions map to their flags", async () => {
    await dispatchBrowserBridgeTool("browser_wait", { url: "**/done" });
    expect(lastCall().args).toEqual(["wait", "--url", "**/done"]);
    await dispatchBrowserBridgeTool("browser_wait", { loadState: "networkidle" });
    expect(lastCall().args).toEqual(["wait", "--load", "networkidle"]);
    await dispatchBrowserBridgeTool("browser_wait", { text: "Done" });
    expect(lastCall().args).toEqual(["wait", "--text", "Done"]);
    await dispatchBrowserBridgeTool("browser_wait", { fn: "window.ready" });
    expect(lastCall().args).toEqual(["wait", "--fn", "window.ready"]);
  });

  it("wait with no condition errors without shelling out", async () => {
    const r = await dispatchBrowserBridgeTool("browser_wait", {});
    expect(r.isError).toBe(true);
    expect(calls.length).toBe(0);
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
