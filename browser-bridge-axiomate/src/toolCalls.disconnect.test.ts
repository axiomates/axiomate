import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake CdpClient defined inside vi.hoisted so it exists before the hoisted
// vi.mock factory below references it. It's a real EventEmitter (so the
// `.on('disconnect', fn)` wiring in handleAttach is exercised and tests can
// emit 'disconnect' to simulate the user quitting Chrome) and IS the mocked
// CdpClient class with a static connect, so `c instanceof CdpClient` holds.
const { FakeCdpClient, clients } = vi.hoisted(() => {
  // require inside hoisted: the top-level `import` is itself hoisted below this
  // block, so EventEmitter isn't bound yet when this factory runs.
  const { EventEmitter } = require("node:events");
  const instances: any[] = [];
  class FakeCdpClient extends EventEmitter {
    closed = false;
    sends: Array<{ method: string; params: any }> = [];
    static instances = instances;
    static connect = vi.fn(async () => {
      const c = new FakeCdpClient();
      instances.push(c);
      return c;
    });
    async send(method: string, params?: any): Promise<any> {
      this.sends.push({ method, params });
      return {};
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }
  return { FakeCdpClient, clients: instances };
});

vi.mock("./launcher.js", () => ({
  tryLaunchIsolated: vi.fn(async () => ({
    ok: true,
    kind: "chromium",
    port: 9222,
    pid: 4242,
  })),
}));

vi.mock("./cdpClient.js", () => ({ CdpClient: FakeCdpClient }));

import {
  __resetBridgeForTesting,
  dispatchBrowserBridgeTool,
} from "./toolCalls.js";

async function statusState(): Promise<string> {
  const r = await dispatchBrowserBridgeTool("browser_status", {});
  return JSON.parse((r.content[0] as any).text).state;
}

beforeEach(() => {
  clients.length = 0;
  FakeCdpClient.connect.mockClear();
});

afterEach(() => {
  __resetBridgeForTesting();
});

describe("browser-bridge disconnect detection", () => {
  it("reports detached after the CDP socket disconnects", async () => {
    const attach = await dispatchBrowserBridgeTool("browser_attach", {});
    expect(attach.isError).toBeFalsy();
    expect(await statusState()).toBe("attached");

    // User closes Chrome: chrome-remote-interface emits 'disconnect' on WS close.
    clients[0]!.emit("disconnect");

    expect(await statusState()).toBe("detached");
  });

  it("rejects tool calls needing a client after disconnect", async () => {
    await dispatchBrowserBridgeTool("browser_attach", {});
    clients[0]!.emit("disconnect");

    const snap = await dispatchBrowserBridgeTool("browser_snapshot", {});
    expect(snap.isError).toBe(true);
    expect((snap.content[0] as any).text).toMatch(/not attached/i);
  });

  it("allows re-attaching after a disconnect", async () => {
    await dispatchBrowserBridgeTool("browser_attach", {});
    clients[0]!.emit("disconnect");
    expect(await statusState()).toBe("detached");

    const reattach = await dispatchBrowserBridgeTool("browser_attach", {});
    expect(reattach.isError).toBeFalsy();
    expect(await statusState()).toBe("attached");
    expect(clients).toHaveLength(2); // a fresh client was created
  });

  it("ignores a stale client's late disconnect after reattach (guard)", async () => {
    await dispatchBrowserBridgeTool("browser_attach", {}); // clients[0]
    clients[0]!.emit("disconnect"); // detaches
    await dispatchBrowserBridgeTool("browser_attach", {}); // clients[1], live
    expect(await statusState()).toBe("attached");

    // The OLD client fires a late 'disconnect'. The session.client === client
    // guard must make this a no-op — the live session (clients[1]) survives.
    clients[0]!.emit("disconnect");
    expect(await statusState()).toBe("attached");

    // The LIVE client disconnecting still works.
    clients[1]!.emit("disconnect");
    expect(await statusState()).toBe("detached");
  });
});

describe("browser-bridge blocking-dialog handling", () => {
  async function statusFull(): Promise<any> {
    const r = await dispatchBrowserBridgeTool("browser_status", {});
    return JSON.parse((r.content[0] as any).text);
  }

  function openDialog(client: any, over: Record<string, unknown> = {}): void {
    client.emit("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Delete everything?",
      defaultPrompt: "",
      ...over,
    });
  }

  it("surfaces an opening dialog in browser_status", async () => {
    await dispatchBrowserBridgeTool("browser_attach", {});
    expect((await statusFull()).pendingDialog).toBeUndefined();

    openDialog(clients[0]!);

    const st = await statusFull();
    expect(st.pendingDialog).toMatchObject({
      type: "confirm",
      message: "Delete everything?",
    });
  });

  it("clears the pending dialog once browser_dialog responds", async () => {
    await dispatchBrowserBridgeTool("browser_attach", {});
    openDialog(clients[0]!);
    expect((await statusFull()).pendingDialog).toBeDefined();

    const res = await dispatchBrowserBridgeTool("browser_dialog", {
      action: "accept",
    });
    expect(res.isError).toBeFalsy();
    // handleJavaScriptDialog was actually sent...
    expect(
      clients[0]!.sends.some(
        (s: any) => s.method === "Page.handleJavaScriptDialog",
      ),
    ).toBe(true);
    // ...and our tracked state is cleared.
    expect((await statusFull()).pendingDialog).toBeUndefined();
  });

  it("clears the pending dialog on the Closed event", async () => {
    await dispatchBrowserBridgeTool("browser_attach", {});
    openDialog(clients[0]!);
    expect((await statusFull()).pendingDialog).toBeDefined();

    clients[0]!.emit("Page.javascriptDialogClosed", {});
    expect((await statusFull()).pendingDialog).toBeUndefined();
  });

  it("auto-dismisses an unanswered dialog after the watchdog timeout", async () => {
    vi.useFakeTimers();
    try {
      await dispatchBrowserBridgeTool("browser_attach", {});
      openDialog(clients[0]!);
      expect((await statusFull()).pendingDialog).toBeDefined();

      // Nobody answers; advance past the 300s backstop.
      await vi.advanceTimersByTimeAsync(300_000 + 100);

      // Watchdog sent accept:false and cleared our state.
      const dismiss = clients[0]!.sends.find(
        (s: any) => s.method === "Page.handleJavaScriptDialog",
      );
      expect(dismiss?.params?.accept).toBe(false);
      expect((await statusFull()).pendingDialog).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the dialog watchdog when the socket disconnects", async () => {
    vi.useFakeTimers();
    try {
      await dispatchBrowserBridgeTool("browser_attach", {});
      openDialog(clients[0]!);
      const sendsBefore = clients[0]!.sends.length;

      clients[0]!.emit("disconnect");
      // After disconnect the watchdog must be cancelled — advancing time must
      // NOT fire a handleJavaScriptDialog on the dead client.
      await vi.advanceTimersByTimeAsync(300_000 + 100);
      expect(clients[0]!.sends.length).toBe(sendsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
