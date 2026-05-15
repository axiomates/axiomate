/**
 * Phase 2a smoke test — exercises the bridge end-to-end without the MCP layer.
 *
 * Flow:
 *   1. tryLaunchIsolated()   — spawn Chrome with --user-data-dir=~/.axiomate/...
 *   2. CdpClient.connect()   — open WS to the freshly-spawned process.
 *   3. Page.navigate         — to a data: URL with a known button + injected
 *                              click counter on window.
 *   4. enumeratePageElements — pull the AX tree, assert a "Click me" button ref.
 *   5. refCenter + Input.dispatchMouseEvent — click via CDP coords, NOT OS.
 *   6. Runtime.evaluate window.__clicks — assert click landed.
 *   7. process.kill(pid)     — clean teardown.
 *
 * Run from the package dir:
 *   cd browser-bridge-axiomate && bun src/__smoke__/smokeBridge.ts
 *
 * Opens a real Chrome window briefly. Exit code 0 = pass, non-zero = fail.
 */

import { CdpClient } from "../cdpClient.js";
import { enumeratePageElements, refCenter } from "../enumerate.js";
import { tryLaunchIsolated } from "../launcher.js";

const HTML = `
<html>
<body style="font-family: sans-serif; padding: 40px;">
  <h1>Bridge Smoke Test</h1>
  <button id="b1" onclick="window.__clicks = (window.__clicks||0)+1; document.getElementById('s').textContent = window.__clicks;">Click me</button>
  <p>Clicks: <span id="s">0</span></p>
</body>
</html>
`;
const NAV_URL = `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`;

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log("[1/7] launching isolated Chrome...");
  const launch = await tryLaunchIsolated();
  if (!launch.ok) fail(`launch failed: ${launch.reason}`);
  console.log(`      ok: pid=${launch.pid} kind=${launch.kind} port=${launch.port}`);

  let client: CdpClient | undefined;
  let exitCode = 0;
  try {
    console.log("[2/7] connecting CDP client...");
    client = await CdpClient.connect({ port: launch.port! });
    console.log("      ok: connected");

    console.log("[3/7] navigating to data: URL...");
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: NAV_URL });
    // Page.navigate resolves on commit. The DOM doesn't have to exist yet.
    // Poll until document.readyState === 'complete' (max 5s).
    for (let i = 0; i < 50; i++) {
      const r = await client.send<{ result: { value?: string } }>(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
      );
      if (r.result?.value === "complete") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log("      ok: page loaded");

    console.log("[4/7] enumerating AX tree...");
    const snap = await enumeratePageElements(client);
    const refCount = Object.keys(snap.refs).length;
    console.log(`      ok: ${refCount} refs, title="${snap.title}"`);
    if (refCount === 0) fail("no refs found");

    const buttonEntry = Object.values(snap.refs).find(
      (r) => r.role === "button" && r.name.includes("Click me"),
    );
    if (!buttonEntry) {
      console.log("--- ariaText ---");
      console.log(snap.ariaText);
      console.log("--- refs ---");
      console.log(JSON.stringify(snap.refs, null, 2));
      fail("button 'Click me' not found in snapshot");
    }
    console.log(
      `      ok: found button ref=${buttonEntry.ref} role=${buttonEntry.role} name="${buttonEntry.name}" backendNodeId=${buttonEntry.backendNodeId}`,
    );

    console.log("[5/7] resolving ref → viewport coords...");
    const center = await refCenter(client, buttonEntry);
    console.log(`      ok: center=(${center.x.toFixed(1)}, ${center.y.toFixed(1)})`);

    console.log("[6/7] dispatching CDP click...");
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: center.x,
      y: center.y,
      button: "left",
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: center.x,
      y: center.y,
      button: "left",
      clickCount: 1,
    });
    // Give the onclick handler a tick.
    await new Promise((r) => setTimeout(r, 100));
    const clicksRes = await client.send<{ result: { value?: number } }>(
      "Runtime.evaluate",
      { expression: "window.__clicks", returnByValue: true },
    );
    const clicks = clicksRes.result?.value ?? 0;
    if (clicks !== 1) {
      fail(`expected window.__clicks === 1, got ${clicks}`);
    }
    console.log(`      ok: window.__clicks=${clicks}`);

    console.log("[7/7] PASS — all assertions held");
  } catch (e) {
    console.error(`runtime error: ${(e as Error).stack ?? e}`);
    exitCode = 1;
  } finally {
    try {
      await client?.close();
    } catch {
      // Already gone — ignore.
    }
    if (launch.pid) {
      try {
        process.kill(launch.pid);
        console.log(`      killed Chrome pid=${launch.pid}`);
      } catch (e) {
        console.warn(`      kill failed: ${(e as Error).message}`);
      }
    }
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(`uncaught: ${(e as Error).stack ?? e}`);
  process.exit(2);
});
