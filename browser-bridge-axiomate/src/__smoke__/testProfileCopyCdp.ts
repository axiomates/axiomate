/**
 * Experiment: does --user-data-dir pointing at a COPY of the user's
 * default Chrome profile produce a CDP-enabled instance with the
 * user's cookies/extensions intact?
 *
 * Cold-start default profile experiment proved Chrome blocks
 * --remote-debugging-port for the real default user-data-dir. The
 * known escape hatch is "use a copy at a non-default path". This
 * script measures whether that hatch actually works on Chrome 148.
 *
 * Steps:
 *   1. Pre-flight: zero chrome.exe processes.
 *   2. Copy %LOCALAPPDATA%\Google\Chrome\User Data → ~/.axiomate/browser-bridge/profile-copy
 *      (xcopy /E /I /H /Y — preserves hidden + recursive)
 *   3. Spawn chrome.exe --user-data-dir=<copy> --remote-debugging-port=<random>
 *   4. Poll CDP port. If listening:
 *      - GET /json/version
 *      - Open Storage.getCookies for default partition, count cookies (no values)
 *      - List tab count
 *   5. Kill spawned Chrome. Delete the copy.
 *
 * Privacy guard: NEVER print cookie values, login data values, or
 * anything that could leak the user's session. We only count things.
 */

import { execa } from "execa";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REAL_PROFILE = "C:\\Users\\kiro\\AppData\\Local\\Google\\Chrome\\User Data";
const COPY_DIR = join(homedir(), ".axiomate", "browser-bridge", "profile-copy");

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then(({ createServer }) => {
      const s = createServer();
      s.unref();
      s.listen(0, () => {
        const addr = s.address();
        if (typeof addr === "object" && addr) {
          const port = addr.port;
          s.close(() => resolve(port));
        } else {
          reject(new Error("no port"));
        }
      });
    });
  });
}

async function probe(port: number, ms: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
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

async function chromeProcessCount(): Promise<number> {
  const r = await execa(
    "powershell",
    ["-Command", "(Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count"],
    { reject: false },
  );
  return parseInt(r.stdout.trim(), 10) || 0;
}

async function main() {
  console.log(`[0/6] Pre-flight: chrome.exe process count`);
  const pre = await chromeProcessCount();
  if (pre !== 0) {
    console.log(`      ✗ ${pre} chrome processes running — abort, clean up first`);
    process.exit(1);
  }
  console.log(`      ✓ 0 chrome processes`);

  // Clean any prior copy from a previous run.
  if (existsSync(COPY_DIR)) {
    console.log(`[clean] removing prior copy at ${COPY_DIR}`);
    rmSync(COPY_DIR, { recursive: true, force: true });
  }

  console.log(`[1/6] Copying ${REAL_PROFILE} → ${COPY_DIR}`);
  console.log(`      (~1GB, may take 30-60s)`);
  mkdirSync(COPY_DIR, { recursive: true });
  const t0 = Date.now();
  // xcopy /E (recursive incl empty) /I (assume dest is dir) /H (hidden) /Y (no prompt) /Q (quiet)
  const cp = await execa(
    "xcopy",
    [REAL_PROFILE, COPY_DIR, "/E", "/I", "/H", "/Y", "/Q"],
    { reject: false },
  );
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (cp.exitCode !== 0) {
    console.log(`      ⚠ xcopy exit=${cp.exitCode} (some files may have been locked)`);
    console.log(`      tail of stderr: ${(cp.stderr || "").split(/\r?\n/).slice(-3).join(" | ")}`);
  } else {
    console.log(`      ✓ copied in ${dt}s`);
  }

  const port = await pickFreePort();
  console.log(`[2/6] Spawning chrome with --user-data-dir=<copy> --remote-debugging-port=${port}`);
  const child = execa(
    CHROME,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${COPY_DIR}`],
    { detached: true, windowsHide: false, stdio: "ignore", cleanup: false },
  );
  child.unref?.();
  // Silence the "subprocess exited non-zero" rejection. Chrome will be
  // killed by us at the end, which makes the spawn promise reject —
  // we don't want that to wipe out our cleanup steps.
  (child as any).catch?.(() => {});
  const pid = child.pid!;
  console.log(`      spawned pid=${pid}`);

  console.log(`[3/6] Polling for CDP on port ${port}...`);
  let listening = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await probe(port, 500)) {
      listening = true;
      console.log(`      ✓ CDP listening after ${(i + 1) * 500}ms`);
      break;
    }
  }
  if (!listening) {
    console.log(`      ✗ port never opened within 10s`);
  }

  console.log(`[4/6] Checking DevToolsActivePort file in copy dir...`);
  const dta = join(COPY_DIR, "DevToolsActivePort");
  if (existsSync(dta)) {
    const c = readFileSync(dta, "utf8");
    console.log(`      ✓ exists, line 1: ${JSON.stringify(c.split("\n")[0])}`);
  } else {
    console.log(`      ✗ does not exist`);
  }

  if (listening) {
    console.log(`[5/6] CDP queries (no value leakage — counts and types only)`);
    try {
      const ver: any = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) =>
        r.json(),
      );
      console.log(`      browser: ${ver.Browser}`);
      console.log(`      user-agent ends with: ...${String(ver["User-Agent"]).slice(-30)}`);

      const tabs: any[] = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
      const pageTabs = tabs.filter((t) => t.type === "page");
      console.log(`      tab count (page targets): ${pageTabs.length}`);

      // Use the first page target for a CDP WebSocket query.
      if (pageTabs.length > 0) {
        const wsUrl = pageTabs[0].webSocketDebuggerUrl;
        const cri = (await import("chrome-remote-interface")).default;
        const client: any = await cri({ target: wsUrl });
        try {
          await client.send("Network.enable");

          // Try two APIs — they have different scope:
          //   - Storage.getCookies:       per-target storage
          //   - Network.getAllCookies:    every cookie known to the browser
          const storageR = await client.send("Storage.getCookies").catch((e: any) => ({
            error: e.message,
            cookies: [],
          }));
          const storageCount = (storageR.cookies || []).length;

          const allR = await client.send("Network.getAllCookies").catch((e: any) => ({
            error: e.message,
            cookies: [],
          }));
          const allCookies = allR.cookies || [];
          const domains = new Set<string>();
          for (const c of allCookies) domains.add(c.domain);

          console.log(`      Storage.getCookies count: ${storageCount}`);
          console.log(
            `      Network.getAllCookies count: ${allCookies.length}, distinct domains: ${domains.size}`,
          );
          const googleSid = allCookies.some(
            (c: any) => /\.google\.com$/.test(c.domain) && c.name === "SID",
          );
          console.log(`      google SID cookie present: ${googleSid}`);

          // Check file size on disk for sanity — if copy is intact, the
          // SQLite database itself has entries even if Chrome can't
          // decrypt the values.
          const cookiesPath = join(COPY_DIR, "Default", "Network", "Cookies");
          if (existsSync(cookiesPath)) {
            const sz = (await import("node:fs")).statSync(cookiesPath).size;
            console.log(`      on-disk Cookies file size: ${sz} bytes`);
          }
        } finally {
          await client.close();
        }
      }
    } catch (e) {
      console.log(`      CDP query failed: ${(e as Error).message}`);
    }
  } else {
    console.log(`[5/6] Skipped (CDP not listening)`);
  }

  console.log(`\n[6/6] Cleanup`);
  console.log(`      killing pid=${pid} (and child processes)`);
  const kill = await execa(
    "taskkill",
    ["/T", "/F", "/pid", String(pid)],
    { reject: false },
  );
  if (kill.exitCode !== 0) {
    console.log(`      taskkill exit=${kill.exitCode} (process likely already gone)`);
  }
  await sleep(1500);
  const post = await chromeProcessCount();
  console.log(`      chrome processes after kill: ${post}`);
  if (post === 0) {
    console.log(`      deleting copy at ${COPY_DIR}`);
    try {
      rmSync(COPY_DIR, { recursive: true, force: true });
      console.log(`      ✓ deleted`);
    } catch (e) {
      console.log(`      ⚠ could not delete: ${(e as Error).message}`);
    }
  } else {
    console.log(`      ⚠ leaving copy in place; ${post} chrome processes still running`);
  }

  console.log(`\nVERDICT: profile-COPY + CDP ${listening ? "WORKS" : "FAILS"}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`uncaught: ${(e as Error).stack ?? e}`);
  process.exit(2);
});
