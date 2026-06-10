/**
 * Tool dispatch for the browser bridge MCP server.
 *
 * Execution layer: every browser_* tool shells out to the bundled agent-browser
 * CLI (see agentBrowserClient.ts) against the user's LOCAL browser that
 * launcher.ts starts. We do NOT speak raw CDP ourselves — agent-browser (Vercel
 * Labs, native Rust CDP daemon) owns snapshot/ref/click/dialog/console/iframe
 * etc., including cross-origin OOPIF handling that a hand-rolled AX walk can't
 * easily do.
 *
 * One session per agent process: the launched browser's CDP port lives in
 * module-level state and is passed as `--cdp <port>` to every agent-browser
 * call. State is a closure because the MCP server is in-process with exactly
 * one agent.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { runAgentBrowser } from "./agentBrowserClient.js";
import { tryLaunchIsolated } from "./launcher.js";
import type { BridgeState, BrowserKind } from "./types.js";

interface BridgeSession {
  state: BridgeState;
  kind?: BrowserKind;
  port?: number;
  pid?: number;
}

const session: BridgeSession = { state: "detached" };

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Require an attached browser; returns the CDP port or an error result. */
function requirePort(): number | CallToolResult {
  if (session.state !== "attached" || session.port === undefined) {
    return err("browser bridge is not attached. Call browser_attach first.");
  }
  return session.port;
}

/** Map an agent-browser failure into an MCP error result. */
function fail(prefix: string, error?: string): CallToolResult {
  return err(`${prefix}${error ? `: ${error}` : ""}`);
}

function statusObject() {
  return {
    state: session.state,
    browserKind: session.kind,
    cdpPort: session.port,
  };
}

async function handleAttach(): Promise<CallToolResult> {
  if (session.state === "attached" && session.port !== undefined) {
    return ok(`already attached: ${JSON.stringify(statusObject(), null, 2)}`);
  }
  if (session.state === "attaching") {
    return err("attach already in progress");
  }
  session.state = "attaching";
  const launch = await tryLaunchIsolated();
  if (!launch.ok || launch.port === undefined) {
    session.state = "detached";
    return err(`attach failed: ${launch.reason ?? "unknown"}`);
  }
  // Attach agent-browser to the launcher's browser over CDP. `connect` persists
  // the endpoint in agent-browser's session so subsequent --cdp calls target
  // the same browser.
  const connect = await runAgentBrowser(["connect", String(launch.port)], {
    cdpPort: launch.port,
    timeoutMs: 15_000,
  });
  if (!connect.ok) {
    // Launch succeeded but agent-browser couldn't attach — tear the browser
    // down so we don't leak it.
    if (launch.pid) {
      try {
        process.kill(launch.pid);
      } catch {
        // already gone
      }
    }
    session.state = "detached";
    return fail("attach failed (agent-browser connect)", connect.error);
  }
  session.kind = launch.kind;
  session.port = launch.port;
  session.pid = launch.pid;
  session.state = "attached";
  return ok(`attached: ${JSON.stringify(statusObject(), null, 2)}`);
}

async function handleStatus(): Promise<CallToolResult> {
  const base = statusObject();
  // Surface a blocking dialog if one is open — agent-browser tracks this
  // natively (no hand-rolled javascriptDialogOpening listener needed).
  let pendingDialog: string | undefined;
  if (session.state === "attached" && session.port !== undefined) {
    const d = await runAgentBrowser(["dialog", "status"], {
      cdpPort: session.port,
      timeoutMs: 5_000,
    });
    if (d.ok && d.stdout && !/no dialog/i.test(d.stdout)) {
      pendingDialog = d.stdout.trim();
    }
  }
  return ok(
    JSON.stringify(pendingDialog ? { ...base, pendingDialog } : base, null, 2),
  );
}

async function handleDetach(): Promise<CallToolResult> {
  if (session.state === "detached") {
    return ok("already detached");
  }
  const port = session.port;
  if (port !== undefined) {
    await runAgentBrowser(["close"], { cdpPort: port, timeoutMs: 10_000 });
  }
  if (session.pid) {
    try {
      process.kill(session.pid);
    } catch {
      // Process may have exited or be unkillable — caller can clean up.
    }
  }
  session.kind = undefined;
  session.port = undefined;
  session.pid = undefined;
  session.state = "detached";
  return ok("detached");
}

// ── Page interaction (all attach to session.port via --cdp) ──────────────────

async function handleNavigate(args: { url: string }): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["open", args.url], {
    cdpPort: port,
    timeoutMs: 45_000,
  });
  return r.ok ? ok(`navigated to ${args.url}`) : fail("navigate failed", r.error);
}

async function handleSnapshot(args: {
  interactive?: boolean;
  urls?: boolean;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const flags = ["snapshot", "--compact"];
  if (args?.interactive) flags.push("--interactive");
  if (args?.urls) flags.push("--urls");
  const r = await runAgentBrowser(flags, { cdpPort: port, timeoutMs: 45_000 });
  if (!r.ok) return fail("snapshot failed", r.error);
  // agent-browser emits the ref-addressed aria tree (@e1, @e2, ...) directly;
  // pass it through for the model to address with browser_click etc.
  return ok(r.stdout || "(empty page)");
}

async function handleClick(args: {
  ref: string;
  button?: "left" | "middle" | "right";
  clickCount?: number;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const cmd =
    args.clickCount === 2 ? ["dblclick", args.ref] : ["click", args.ref];
  if (args.button && args.button !== "left") cmd.push("--button", args.button);
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 30_000 });
  return r.ok ? ok(`clicked ${args.ref}`) : fail("click failed", r.error);
}

async function handleType(args: {
  ref: string;
  text: string;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["fill", args.ref, args.text], {
    cdpPort: port,
    timeoutMs: 30_000,
  });
  return r.ok ? ok(`typed into ${args.ref}`) : fail("type failed", r.error);
}

async function handlePress(args: { key: string }): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["press", args.key], {
    cdpPort: port,
    timeoutMs: 15_000,
  });
  return r.ok ? ok(`pressed ${args.key}`) : fail("press failed", r.error);
}

async function handleScroll(args: {
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const dir = args.direction ?? "down";
  const cmd = ["scroll", dir];
  if (typeof args.amount === "number") cmd.push(String(args.amount));
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 15_000 });
  return r.ok ? ok(`scrolled ${dir}`) : fail("scroll failed", r.error);
}

async function handleHistory(
  verb: "back" | "forward" | "reload",
): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser([verb], { cdpPort: port, timeoutMs: 45_000 });
  return r.ok ? ok(verb) : fail(`${verb} failed`, r.error);
}

async function handleTabList(): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["tab", "list"], {
    cdpPort: port,
    timeoutMs: 15_000,
  });
  return r.ok ? ok(r.stdout || "(no tabs)") : fail("tab list failed", r.error);
}

async function handleTabNew(args: { url?: string }): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["tab", "new"], {
    cdpPort: port,
    timeoutMs: 15_000,
  });
  if (!r.ok) return fail("tab new failed", r.error);
  if (args?.url) {
    const nav = await runAgentBrowser(["open", args.url], {
      cdpPort: port,
      timeoutMs: 45_000,
    });
    if (!nav.ok) return fail("tab new (navigate) failed", nav.error);
  }
  return ok(r.stdout || "opened new tab");
}

async function handleTabClose(): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["tab", "close"], {
    cdpPort: port,
    timeoutMs: 15_000,
  });
  return r.ok ? ok("closed tab") : fail("tab close failed", r.error);
}

async function handleTabSwitch(args: {
  targetId: string;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["tab", args.targetId], {
    cdpPort: port,
    timeoutMs: 15_000,
  });
  return r.ok ? ok(`switched to tab ${args.targetId}`) : fail("tab switch failed", r.error);
}

async function handleDialog(args: {
  action: "accept" | "dismiss";
  promptText?: string;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const cmd = ["dialog", args.action];
  if (args.action === "accept" && args.promptText !== undefined) {
    cmd.push(args.promptText);
  }
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 10_000 });
  return r.ok ? ok(`dialog ${args.action}`) : fail("dialog failed", r.error);
}

async function handleConsole(args: {
  clear?: boolean;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const cmd = ["console"];
  if (args?.clear) cmd.push("--clear");
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 15_000 });
  return r.ok ? ok(r.stdout || "(no console output)") : fail("console failed", r.error);
}

async function handleZoom(args: { factor: number }): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  // agent-browser has no first-class zoom verb; set it via the page's own API.
  const r = await runAgentBrowser(
    ["eval", `document.body.style.zoom='${Number(args.factor)}'`],
    { cdpPort: port, timeoutMs: 10_000 },
  );
  return r.ok ? ok(`zoom set to ${args.factor}`) : fail("zoom failed", r.error);
}

async function handleGetImages(): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(
    [
      "eval",
      "JSON.stringify([...document.images].map(i=>({src:i.currentSrc||i.src,alt:i.alt||null,w:i.naturalWidth,h:i.naturalHeight})))",
    ],
    { cdpPort: port, timeoutMs: 15_000 },
  );
  return r.ok ? ok(r.stdout || "[]") : fail("get_images failed", r.error);
}

async function handleVision(): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  // Screenshot to stdout as base64 PNG for the model's vision pass.
  const r = await runAgentBrowser(["screenshot", "--base64"], {
    cdpPort: port,
    timeoutMs: 30_000,
  });
  if (!r.ok) return fail("vision failed", r.error);
  return {
    content: [{ type: "image", data: r.stdout.trim(), mimeType: "image/png" }],
  } as CallToolResult;
}

async function handleCdp(args: {
  method: string;
  params?: unknown;
  sessionId?: string;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const cmd = ["cdp", args.method];
  if (args.params !== undefined) cmd.push(JSON.stringify(args.params));
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 30_000 });
  return r.ok ? ok(r.stdout || "{}") : fail("cdp failed", r.error);
}

export async function dispatchBrowserBridgeTool(
  name: string,
  args: any,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "browser_attach":
        return await handleAttach();
      case "browser_status":
        return await handleStatus();
      case "browser_detach":
        return await handleDetach();
      case "browser_navigate":
        return await handleNavigate(args);
      case "browser_snapshot":
        return await handleSnapshot(args ?? {});
      case "browser_click":
        return await handleClick(args);
      case "browser_type":
        return await handleType(args);
      case "browser_press":
        return await handlePress(args);
      case "browser_scroll":
        return await handleScroll(args ?? {});
      case "browser_back":
        return await handleHistory("back");
      case "browser_forward":
        return await handleHistory("forward");
      case "browser_reload":
        return await handleHistory("reload");
      case "browser_tab_new":
        return await handleTabNew(args ?? {});
      case "browser_tab_close":
        return await handleTabClose();
      case "browser_tab_switch":
        return await handleTabSwitch(args);
      case "browser_tab_list":
        return await handleTabList();
      case "browser_zoom":
        return await handleZoom(args);
      case "browser_dialog":
        return await handleDialog(args);
      case "browser_console":
        return await handleConsole(args ?? {});
      case "browser_get_images":
        return await handleGetImages();
      case "browser_vision":
        return await handleVision();
      case "browser_cdp":
        return await handleCdp(args);
      default:
        return err(`unknown tool ${name}`);
    }
  } catch (e) {
    return err(`${name} failed: ${(e as Error).message}`);
  }
}

/** Test-only: reset module state between cases. */
export function __resetBridgeForTesting(): void {
  session.state = "detached";
  session.kind = undefined;
  session.port = undefined;
  session.pid = undefined;
}

