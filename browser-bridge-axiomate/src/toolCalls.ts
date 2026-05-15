/**
 * Tool dispatch for the browser bridge MCP server.
 *
 * One BridgeSession per agent process. State lives in module-level closure
 * because the MCP server is in-process and there's exactly one agent. If we
 * ever need multi-tenant (e.g. SDK with concurrent sessions), this becomes
 * a Map keyed on session id and bound via a wrapper closure analogous to
 * `bindSessionContext` in computer-use-mcp.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { CdpClient } from "./cdpClient.js";
import { enumeratePageElements, refCenter } from "./enumerate.js";
import { tryLaunchIsolated } from "./launcher.js";
import type {
  BridgeProfile,
  BridgeState,
  BridgeStatus,
  BrowserKind,
  PageSnapshot,
} from "./types.js";

interface ConsoleEntry {
  type: "log" | "warn" | "error" | "info" | "debug" | "exception";
  /** Joined text representation. For exceptions, the error message/stack. */
  text: string;
  /** Wall-clock time when the event arrived. */
  timestamp: number;
  /** Source URL + line/col for exceptions; undefined for plain logs. */
  source?: string;
}

const CONSOLE_BUFFER_CAP = 500;

interface BridgeSession {
  state: BridgeState;
  client?: CdpClient;
  kind?: BrowserKind;
  port?: number;
  pid?: number;
  profile?: BridgeProfile;
  /** The most recent snapshot's refs map. Cleared on navigation. */
  lastSnapshot?: PageSnapshot;
  /** Ring buffer of console events. Drained / cleared by browser_console. */
  consoleBuffer: ConsoleEntry[];
}

const session: BridgeSession = { state: "detached", consoleBuffer: [] };

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function statusObject(): BridgeStatus {
  return {
    state: session.state,
    profile: session.state === "attached" ? session.profile : undefined,
    browserKind: session.kind,
    cdpPort: session.port,
  };
}

/** Require attached state; returns the client or an error result. */
function requireClient(): CdpClient | CallToolResult {
  if (session.state !== "attached" || !session.client) {
    return err(
      "browser bridge is not attached. Call browser_attach first.",
    );
  }
  return session.client;
}

function pushConsole(entry: ConsoleEntry): void {
  session.consoleBuffer.push(entry);
  if (session.consoleBuffer.length > CONSOLE_BUFFER_CAP) {
    // Drop oldest. Newest events are most relevant for debugging "what
    // just broke".
    session.consoleBuffer.splice(
      0,
      session.consoleBuffer.length - CONSOLE_BUFFER_CAP,
    );
  }
}

/**
 * Attach to a freshly-spawned isolated-profile Chromium. The user-profile
 * takeover path was attempted (Phase 2b) but removed: Chrome 136+ silently
 * ignores `--remote-debugging-port` when paired with the default
 * user-data-dir as a cookie-theft mitigation (developer.chrome.com/blog/
 * remote-debugging-port, 2025-03-17). Isolated is the only shippable path.
 */
async function handleAttach(): Promise<CallToolResult> {
  if (session.state === "attached" && session.client) {
    return ok(
      `already attached: ${JSON.stringify(statusObject(), null, 2)}`,
    );
  }
  if (session.state === "attaching") {
    return err("attach already in progress");
  }
  session.state = "attaching";
  const launch = await tryLaunchIsolated();
  if (!launch.ok) {
    session.state = "detached";
    return err(`attach failed: ${launch.reason}`);
  }
  try {
    const client = await CdpClient.connect({
      host: "127.0.0.1",
      port: launch.port!,
    });
    session.client = client;
    session.kind = launch.kind;
    session.port = launch.port;
    session.pid = launch.pid;
    session.profile = "isolated";
    session.state = "attached";
    session.consoleBuffer = [];

    // Wire CDP events: snapshot invalidation + console buffer.
    client.on("Page.frameNavigated", () => {
      session.lastSnapshot = undefined;
    });

    // Enable Runtime so consoleAPICalled and exceptionThrown fire.
    await client.send("Runtime.enable").catch(() => {
      // Already enabled or transient race — non-fatal.
    });

    client.on("Runtime.consoleAPICalled", (params: any) => {
      // params.type ∈ "log","debug","info","error","warning",...
      // params.args is an array of RemoteObject; we serialize each.
      const text = (params.args ?? [])
        .map((a: any) => {
          if (a == null) return String(a);
          if ("value" in a && a.value !== undefined) return String(a.value);
          if (a.description) return a.description;
          if (a.unserializableValue) return a.unserializableValue;
          return JSON.stringify(a);
        })
        .join(" ");
      const t = params.type as string;
      // Normalize: "warning" → "warn"; everything else lowercased.
      const type: ConsoleEntry["type"] =
        t === "warning" ? "warn" : (t as ConsoleEntry["type"]);
      pushConsole({
        type,
        text,
        timestamp: Date.now(),
      });
    });

    client.on("Runtime.exceptionThrown", (params: any) => {
      const d = params.exceptionDetails ?? {};
      const msg = d.text ?? "uncaught exception";
      const exc = d.exception?.description ?? d.exception?.value ?? "";
      const source = [d.url, d.lineNumber, d.columnNumber]
        .filter((v) => v !== undefined)
        .join(":");
      pushConsole({
        type: "exception",
        text: exc ? `${msg}: ${exc}` : msg,
        timestamp: Date.now(),
        source: source || undefined,
      });
    });

    return ok(`attached: ${JSON.stringify(statusObject(), null, 2)}`);
  } catch (e) {
    session.state = "detached";
    return err(`CDP connect failed: ${(e as Error).message}`);
  }
}

async function handleDetach(): Promise<CallToolResult> {
  if (session.state === "detached") {
    return ok("already detached");
  }
  try {
    await session.client?.close();
  } catch {
    // Already closed — ignore.
  }
  if (session.pid) {
    try {
      process.kill(session.pid);
    } catch {
      // Process may have exited or be unkillable from this user — caller
      // can clean up manually if needed.
    }
  }
  session.client = undefined;
  session.kind = undefined;
  session.port = undefined;
  session.pid = undefined;
  session.profile = undefined;
  session.lastSnapshot = undefined;
  session.consoleBuffer = [];
  session.state = "released";
  return ok("detached");
}

async function handleNavigate(args: {
  url: string;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  await c.send("Page.navigate", { url: args.url });
  // Best-effort wait for load — Page.navigate resolves on commit, not load.
  await new Promise((r) => setTimeout(r, 500));
  session.lastSnapshot = undefined;
  return ok(`navigated to ${args.url}`);
}

async function handleSnapshot(): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  const snap = await enumeratePageElements(c);
  session.lastSnapshot = snap;
  const refCount = Object.keys(snap.refs).length;
  return ok(
    `# ${snap.title || "(untitled)"}\nurl: ${snap.url}\nrefs: ${refCount}\n\n${snap.ariaText}`,
  );
}

async function handleClick(args: {
  ref: string;
  button?: "left" | "middle" | "right";
  clickCount?: number;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  const ref = session.lastSnapshot?.refs?.[args.ref];
  if (!ref) {
    return err(
      `unknown ref ${args.ref}. Call browser_snapshot first or after navigation.`,
    );
  }
  const { x, y } = await refCenter(c, ref);
  const button = args.button ?? "left";
  const clickCount = args.clickCount ?? 1;
  await c.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    clickCount,
  });
  await c.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    clickCount,
  });
  return ok(`clicked ${args.ref} at (${x.toFixed(1)}, ${y.toFixed(1)})`);
}

async function handleType(args: {
  ref: string;
  text: string;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  const ref = session.lastSnapshot?.refs?.[args.ref];
  if (!ref) {
    return err(`unknown ref ${args.ref}.`);
  }
  // Focus first via DOM.focus by backendNodeId — DOM domain must be enabled
  // implicitly since we used getBoxModel earlier; safe to call directly.
  await c.send("DOM.enable");
  await c.send("DOM.focus", { backendNodeId: ref.backendNodeId });
  await c.send("Input.insertText", { text: args.text });
  return ok(`typed ${args.text.length} chars into ${args.ref}`);
}

async function handlePress(args: { key: string }): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: args.key });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: args.key });
  return ok(`pressed ${args.key}`);
}

async function handleScroll(args: {
  deltaX?: number;
  deltaY?: number;
  ref?: string;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  let x = 400;
  let y = 300;
  if (args.ref) {
    const ref = session.lastSnapshot?.refs?.[args.ref];
    if (!ref) return err(`unknown ref ${args.ref}.`);
    const center = await refCenter(c, ref);
    x = center.x;
    y = center.y;
  }
  await c.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: args.deltaX ?? 0,
    deltaY: args.deltaY ?? 200,
  });
  return ok(`scrolled (${args.deltaX ?? 0}, ${args.deltaY ?? 200}) at (${x}, ${y})`);
}

async function handleHistory(
  method: "Page.goBack" | "Page.goForward" | "Page.reload",
  params: any = {},
): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  await c.send(method, params);
  session.lastSnapshot = undefined;
  return ok(method);
}

async function handleTabList(): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  const r = await c.send<{ targetInfos: any[] }>("Target.getTargets");
  const tabs = r.targetInfos
    .filter((t) => t.type === "page")
    .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title }));
  return ok(JSON.stringify(tabs, null, 2));
}

async function handleTabNew(args: {
  url?: string;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  const r = await c.send<{ targetId: string }>("Target.createTarget", {
    url: args.url ?? "about:blank",
  });
  return ok(`new tab ${r.targetId}`);
}

async function handleTabClose(args: {
  targetId?: string;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  let id = args.targetId;
  if (!id) {
    // Default to the active page target.
    const r = await c.send<{ targetInfos: any[] }>("Target.getTargets");
    const active = r.targetInfos.find(
      (t) => t.type === "page" && t.attached,
    );
    if (!active) return err("no active tab to close");
    id = active.targetId;
  }
  await c.send("Target.closeTarget", { targetId: id });
  return ok(`closed ${id}`);
}

async function handleTabSwitch(args: {
  targetId: string;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  await c.send("Target.activateTarget", { targetId: args.targetId });
  session.lastSnapshot = undefined;
  return ok(`switched to ${args.targetId}`);
}

async function handleZoom(args: {
  factor: number;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  await c.send("Emulation.setPageScaleFactor", {
    pageScaleFactor: args.factor,
  });
  return ok(`zoom ${args.factor}`);
}

async function handleDialog(args: {
  action: "accept" | "dismiss";
  promptText?: string;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  await c.send("Page.handleJavaScriptDialog", {
    accept: args.action === "accept",
    promptText: args.promptText,
  });
  return ok(`dialog ${args.action}`);
}

async function handleConsole(args: {
  expression?: string;
  clear?: boolean;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;

  let evalLine = "";
  if (args.expression) {
    try {
      const r = await c.send<any>("Runtime.evaluate", {
        expression: args.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        evalLine = `[evaluate] threw: ${d.text}${
          d.exception?.description ? ` — ${d.exception.description}` : ""
        }`;
      } else {
        const v = r.result?.value;
        const repr =
          v === undefined
            ? r.result?.description ?? "undefined"
            : typeof v === "string"
              ? v
              : JSON.stringify(v);
        evalLine = `[evaluate] ${repr}`;
      }
    } catch (e) {
      evalLine = `[evaluate failed] ${(e as Error).message}`;
    }
  }

  const buf = [...session.consoleBuffer];
  if (args.clear) session.consoleBuffer = [];

  const lines = buf.map((e) => {
    const src = e.source ? ` (${e.source})` : "";
    return `[${e.type}]${src} ${e.text}`;
  });

  if (evalLine) lines.push(evalLine);
  if (lines.length === 0) {
    return ok("(console buffer empty, no expression evaluated)");
  }
  return ok(lines.join("\n"));
}

async function handleGetImages(args: {
  limit?: number;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  const limit = Math.max(1, Math.min(args.limit ?? 50, 500));
  // Run in the page; collect img elements. currentSrc resolves srcset; alt
  // is the accessibility text; naturalWidth/Height are intrinsic px.
  const expr = `
    JSON.stringify(
      Array.from(document.images)
        .slice(0, ${limit})
        .map(img => ({
          src: img.currentSrc || img.src,
          alt: img.alt || null,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        }))
    )
  `;
  const r = await c.send<any>("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    return err(
      `evaluate failed: ${r.exceptionDetails.text}`,
    );
  }
  const json = r.result?.value ?? "[]";
  return ok(json);
}

async function handleVision(args: {
  format?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  const format = args.format ?? "png";
  const params: any = { format };
  if (format === "jpeg") {
    params.quality = args.quality ?? 80;
  }
  if (args.fullPage) {
    params.captureBeyondViewport = true;
  }
  const r = await c.send<{ data: string }>(
    "Page.captureScreenshot",
    params,
  );
  return {
    content: [
      {
        type: "image",
        data: r.data,
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      },
    ],
  };
}

async function handleCdp(args: {
  method: string;
  params?: any;
  sessionId?: string;
}): Promise<CallToolResult> {
  const c = requireClient();
  if (!(c instanceof CdpClient)) return c;
  const result = await c.send(args.method, args.params ?? {}, args.sessionId);
  return ok(JSON.stringify(result, null, 2));
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
        return ok(JSON.stringify(statusObject(), null, 2));
      case "browser_detach":
        return await handleDetach();
      case "browser_navigate":
        return await handleNavigate(args);
      case "browser_snapshot":
        return await handleSnapshot();
      case "browser_click":
        return await handleClick(args);
      case "browser_type":
        return await handleType(args);
      case "browser_press":
        return await handlePress(args);
      case "browser_scroll":
        return await handleScroll(args);
      case "browser_back":
        return await handleHistory("Page.goBack");
      case "browser_forward":
        return await handleHistory("Page.goForward");
      case "browser_reload":
        return await handleHistory("Page.reload", {
          ignoreCache: !!args?.ignoreCache,
        });
      case "browser_tab_new":
        return await handleTabNew(args);
      case "browser_tab_close":
        return await handleTabClose(args);
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
        return await handleGetImages(args ?? {});
      case "browser_vision":
        return await handleVision(args ?? {});
      case "browser_cdp":
        return await handleCdp(args);
      default:
        return err(`unknown tool ${name}`);
    }
  } catch (e) {
    return err(`${name} failed: ${(e as Error).message}`);
  }
}

/** Test-only: reset module state between vitest cases. */
export function __resetBridgeForTesting(): void {
  session.state = "detached";
  session.client = undefined;
  session.kind = undefined;
  session.port = undefined;
  session.pid = undefined;
  session.profile = undefined;
  session.lastSnapshot = undefined;
  session.consoleBuffer = [];
}
