/**
 * One-shot experiment: does pointing --user-data-dir at the user's default
 * Chrome profile + --remote-debugging-port produce a CDP-enabled instance
 * when there is NO existing Chrome process to fight with?
 *
 * Last test failed because gracefulQuit + immediate relaunch may have left
 * SingletonLock residue. This time the user manually killed all Chrome
 * processes first, so the test is "cold start, default profile, CDP".
 *
 * If CDP comes up: my "Chrome 136+ silently blocks" theory was wrong;
 * the failure was about lock interaction.
 * If CDP does NOT come up: it's a policy-layer block, regardless of timing.
 *
 * Either way, we kill the Chrome we spawned afterwards to leave the
 * user's environment clean.
 */

import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9876;
const USER_DATA = "C:\\Users\\kiro\\AppData\\Local\\Google\\Chrome\\User Data";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function probe(host: string, port: number, ms: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = createConnection({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, ms);
    s.once("connect", () => {
      clearTimeout(t);
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

async function main() {
  console.log(
    `[1/4] Spawning Chrome: --user-data-dir=<DEFAULT> --remote-debugging-port=${PORT}`,
  );
  console.log(`      (no --restore-last-session, no other flags)`);
  const child = execa(
    CHROME,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`],
    {
      detached: true,
      windowsHide: false,
      stdio: "ignore",
      cleanup: false,
    },
  );
  child.unref?.();
  const pid = child.pid!;
  console.log(`      spawned pid=${pid}`);

  console.log(`[2/4] Polling for CDP on port ${PORT}...`);
  let listening = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await probe("127.0.0.1", PORT, 500)) {
      listening = true;
      console.log(`      CDP listening after ${(i + 1) * 500}ms`);
      break;
    }
  }
  if (!listening) {
    console.log(`      ✗ port ${PORT} never opened within 10s`);
  }

  console.log(`[3/4] Checking DevToolsActivePort file in user-data-dir...`);
  const dtaPath = `${USER_DATA}\\DevToolsActivePort`;
  if (existsSync(dtaPath)) {
    console.log(`      ✓ exists, contents: ${JSON.stringify(readFileSync(dtaPath, "utf8"))}`);
  } else {
    console.log(`      ✗ does not exist`);
  }

  if (listening) {
    console.log(`[4/4] Connecting CDP, asking Browser.getVersion + Target.getTargets`);
    try {
      const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) =>
        r.json(),
      );
      console.log(`      version: ${JSON.stringify(ver, null, 2)}`);
      const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      // Strip URLs / titles to avoid leaking the user's browsing into the log.
      console.log(`      tab count: ${(tabs as any[]).length}`);
    } catch (e) {
      console.log(`      CDP query failed: ${(e as Error).message}`);
    }
  } else {
    console.log(`[4/4] Skipped (CDP not listening)`);
  }

  console.log(`\n[cleanup] killing spawned Chrome pid=${pid}`);
  try {
    // /T = also kill children, /F = force
    await execa("taskkill", ["/T", "/F", "/pid", String(pid)], { reject: false });
  } catch {
    // ignore
  }

  console.log(`\nVERDICT: CDP ${listening ? "DID" : "DID NOT"} come up on cold-start default-profile launch.`);
  if (listening) {
    console.log(`  → Phase 2b cancellation reason was LOCK residue, not policy.`);
    console.log(`  → Profile-takeover may be salvageable: clean SingletonLock + wait longer.`);
  } else {
    console.log(`  → It's a policy block. No timing workaround helps.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`uncaught: ${(e as Error).stack ?? e}`);
  process.exit(2);
});
