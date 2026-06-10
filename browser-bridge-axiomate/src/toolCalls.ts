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

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentBrowser } from "./agentBrowserClient.js";
import {
  clearSessionState,
  probeCdpEndpoint,
  tryLaunchIsolated,
} from "./launcher.js";
import type { BridgeState, BrowserKind } from "./types.js";

interface BridgeSession {
  state: BridgeState;
  kind?: BrowserKind;
  port?: number;
  pid?: number;
  /** Profile dir the launcher used — needed to clear session state on cleanup. */
  userDataDir?: string;
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

/** Reset session to detached, clearing the launched-browser handles. */
function markDetached(): void {
  session.kind = undefined;
  session.port = undefined;
  session.pid = undefined;
  session.userDataDir = undefined;
  session.state = "detached";
}

/**
 * Is the launched browser still really there? agent-browser is a stateless
 * one-shot CLI — unlike hermes's persistent websocket supervisor, we have no
 * live connection whose death signals a closed browser. So we actively probe,
 * and check BOTH conditions because either alone can lie:
 *   - process alive (process.kill(pid,0) — safe cross-platform liveness in
 *     Node, NOT the Windows os.kill(pid,0) footgun Python has): catches the
 *     browser being closed/crashed even if some other process now holds the
 *     port.
 *   - CDP port reachable: catches the process lingering (zombie/shutdown) with
 *     its debug socket already gone.
 * Both must hold for the session to count as attached.
 */
async function isSessionAlive(): Promise<boolean> {
  if (session.pid === undefined || session.port === undefined) return false;
  let processAlive: boolean;
  try {
    process.kill(session.pid, 0);
    processAlive = true;
  } catch (e) {
    // ESRCH = gone; EPERM = exists but not ours to signal (still alive).
    processAlive = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!processAlive) return false;
  return probeCdpEndpoint("127.0.0.1", session.port, 1000);
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
    // Launch succeeded but agent-browser couldn't attach. Tear down ONLY a
    // browser we freshly spawned — never one we reused, since that's a
    // survivor with the user's tabs/session we must not kill on a transient
    // connect hiccup.
    if (launch.pid && !launch.reused) {
      try {
        process.kill(launch.pid);
      } catch {
        // already gone
      }
      clearSessionState(launch.userDataDir);
    }
    session.state = "detached";
    return fail("attach failed (agent-browser connect)", connect.error);
  }
  session.kind = launch.kind;
  session.port = launch.port;
  session.pid = launch.pid;
  session.userDataDir = launch.userDataDir;
  session.state = "attached";
  const label = launch.reused ? "reattached (reused running browser)" : "attached";
  return ok(`${label}: ${JSON.stringify(statusObject(), null, 2)}`);
}

async function handleStatus(): Promise<CallToolResult> {
  // If we think we're attached, verify the browser is actually still alive —
  // the user may have closed it, in which case our in-memory state is stale.
  // This is the fix for "status reports attached after the browser is gone":
  // with a one-shot CLI there's no disconnect event, so status must probe.
  if (session.state === "attached" && !(await isSessionAlive())) {
    markDetached();
    return ok(
      JSON.stringify(
        { ...statusObject(), note: "browser exited; detached" },
        null,
        2,
      ),
    );
  }
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

/**
 * Tear down the current session's browser + agent-browser daemon. Shared by
 * browser_detach and the process-exit cleanup. Closes ONLY our own daemon
 * (runAgentBrowser pins --session axiomate-bridge-<pid>, never `close --all`)
 * and kills ONLY the Chrome pid WE recorded — never another axiomate's.
 */
async function teardownSession(): Promise<void> {
  const port = session.port;
  if (port !== undefined) {
    // `close` on a --cdp-attached daemon disconnects + exits THE DAEMON, but
    // does NOT shut our Chrome (agent-browser treats an external/--cdp browser
    // as not-its-own — verified in browser.rs close()). So we kill Chrome
    // ourselves below.
    await runAgentBrowser(["close"], { cdpPort: port, timeoutMs: 10_000 });
  }
  if (session.pid) {
    try {
      process.kill(session.pid);
    } catch {
      // Process may have exited or be unkillable — caller can clean up.
    }
  }
  // Forget the launcher's recorded session so the next attach doesn't try to
  // kill a pid the OS may have recycled. Scope to the profile we actually used.
  clearSessionState(session.userDataDir);
}

/**
 * Process-exit cleanup: take our browser + daemon down so neither lingers as an
 * orphan after axiomate exits (both are deliberately detached, so the OS won't
 * reap them for us, and agent-browser's idle-timeout is off by default → the
 * daemon would otherwise run forever). Safe under concurrent axiomate
 * instances: only touches OUR per-pid daemon and the Chrome pid we recorded.
 * No-op (and never throws) when we never attached.
 */
export async function shutdownBridge(): Promise<void> {
  if (session.state === "detached") return;
  try {
    await teardownSession();
  } catch {
    // Best-effort on the exit path — never block or throw during shutdown.
  }
  markDetached();
}

async function handleDetach(): Promise<CallToolResult> {
  if (session.state === "detached") {
    return ok("already detached");
  }
  await teardownSession();
  markDetached();
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
  double?: boolean;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  // agent-browser's `click` accepts only <selector> [--new-tab] — no
  // --button, so right/middle-click is unsupported (a dropped --button would
  // silently execute a LEFT click and falsely report success). double=true
  // maps to the dedicated `dblclick` verb.
  const cmd = args.double ? ["dblclick", args.ref] : ["click", args.ref];
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 30_000 });
  return r.ok
    ? ok(`${args.double ? "double-clicked" : "clicked"} ${args.ref}`)
    : fail("click failed", r.error);
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
  selector?: string;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const dir = args.direction ?? "down";
  const cmd = ["scroll", dir];
  if (typeof args.amount === "number") cmd.push(String(args.amount));
  if (args.selector) cmd.push("--selector", args.selector);
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

async function handleVision(args: {
  format?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  // agent-browser's `screenshot` writes a file (no base64-to-stdout option),
  // so capture to a temp path, read it back, and return inline base64.
  const fmt = args?.format === "jpeg" ? "jpeg" : "png";
  const outPath = join(
    tmpdir(),
    `axiomate-bridge-shot-${Date.now()}.${fmt === "jpeg" ? "jpg" : "png"}`,
  );
  const cmd = ["screenshot", outPath, "--screenshot-format", fmt];
  if (args?.fullPage) cmd.push("--full");
  if (fmt === "jpeg" && typeof args?.quality === "number") {
    cmd.push("--screenshot-quality", String(args.quality));
  }
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 30_000 });
  if (!r.ok) return fail("vision failed", r.error);
  try {
    const data = readFileSync(outPath).toString("base64");
    return {
      content: [
        {
          type: "image",
          data,
          mimeType: fmt === "jpeg" ? "image/jpeg" : "image/png",
        },
      ],
    } as CallToolResult;
  } catch (e) {
    return fail("vision failed (reading screenshot)", (e as Error).message);
  } finally {
    try {
      rmSync(outPath, { force: true });
    } catch {
      // temp cleanup best-effort
    }
  }
}

async function handleFind(args: {
  locator: string;
  value: string;
  action?: string;
  text?: string;
  name?: string;
  exact?: boolean;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  // agent-browser: find <locator> <value> [action] [text] [--name] [--exact].
  // The action slot is POSITIONAL, so we must ALWAYS emit it explicitly —
  // otherwise a following --name/--exact flag gets parsed as the action
  // ("Unknown subaction: --name", confirmed by real smoke). Default to click.
  const action = args.action ?? "click";
  const cmd = ["find", args.locator, args.value, action];
  if ((action === "fill" || action === "type") && args.text !== undefined) {
    cmd.push(args.text);
  }
  if (args.name) cmd.push("--name", args.name);
  if (args.exact) cmd.push("--exact");
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 30_000 });
  return r.ok
    ? ok(r.stdout || `find ${args.locator}=${args.value}`)
    : fail("find failed", r.error);
}

async function handleUpload(args: {
  selector: string;
  files: string[];
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["upload", args.selector, ...args.files], {
    cdpPort: port,
    timeoutMs: 30_000,
  });
  return r.ok ? ok(`uploaded ${args.files.length} file(s)`) : fail("upload failed", r.error);
}

async function handleSelect(args: {
  selector: string;
  values: string[];
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["select", args.selector, ...args.values], {
    cdpPort: port,
    timeoutMs: 15_000,
  });
  return r.ok ? ok(`selected ${args.values.join(", ")}`) : fail("select failed", r.error);
}

async function handleHover(args: { selector: string }): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  const r = await runAgentBrowser(["hover", args.selector], {
    cdpPort: port,
    timeoutMs: 15_000,
  });
  return r.ok ? ok(`hovered ${args.selector}`) : fail("hover failed", r.error);
}

async function handleWait(args: {
  selector?: string;
  ms?: number;
  url?: string;
  loadState?: string;
  text?: string;
  fn?: string;
}): Promise<CallToolResult> {
  const port = requirePort();
  if (typeof port !== "number") return port;
  // agent-browser: wait <selector|ms|option>. Exactly one mode; flag forms for
  // the named conditions, positional for selector/ms.
  let cmd: string[];
  if (args.url !== undefined) cmd = ["wait", "--url", args.url];
  else if (args.loadState !== undefined) cmd = ["wait", "--load", args.loadState];
  else if (args.text !== undefined) cmd = ["wait", "--text", args.text];
  else if (args.fn !== undefined) cmd = ["wait", "--fn", args.fn];
  else if (args.ms !== undefined) cmd = ["wait", String(args.ms)];
  else if (args.selector !== undefined) cmd = ["wait", args.selector];
  else return err("wait requires one of: selector, ms, url, loadState, text, fn");
  const r = await runAgentBrowser(cmd, { cdpPort: port, timeoutMs: 60_000 });
  return r.ok ? ok(r.stdout || "wait complete") : fail("wait failed", r.error);
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
        return await handleVision(args ?? {});
      case "browser_find":
        return await handleFind(args);
      case "browser_upload":
        return await handleUpload(args);
      case "browser_select":
        return await handleSelect(args);
      case "browser_hover":
        return await handleHover(args);
      case "browser_wait":
        return await handleWait(args ?? {});
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

