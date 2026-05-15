/**
 * Capture state of the running browser before takeover.
 *
 * v1 captures the minimum needed to identify the process and decide which
 * binary to relaunch: PID, browser kind, and the binary path. Window
 * geometry restore is deliberately deferred — Chrome's
 * `--restore-last-session` flag restores tabs and rough position adequately
 * for most users, and grabbing precise geometry would couple this package
 * to `computer-use-{mac,win}-napi-axiomate` (which we don't want — the
 * bridge is meant to be standalone).
 *
 * `tasklist /v /fo csv` (Win) and `ps -ax -o pid,comm` (Mac) are stable
 * across versions back to the OSes we support. They surface the running
 * Chromium-family processes; we match against known executable names.
 */

import { execa } from "execa";
import type { BrowserKind } from "../types.js";

export interface BrowserProcessInfo {
  pid: number;
  kind: BrowserKind;
  /** Absolute path to the executable, or undefined if not knowable cheaply. */
  binary?: string;
}

/**
 * Map of (lowercased process basename) → BrowserKind. Win uses "chrome.exe"
 * etc.; Mac uses "Google Chrome" etc. Both keys folded to lowercase at
 * lookup time.
 */
const PROCESS_NAME_TO_KIND: Record<string, BrowserKind> = {
  // Windows
  "chrome.exe": "chrome",
  "msedge.exe": "edge",
  "brave.exe": "brave",
  "vivaldi.exe": "vivaldi",
  "opera.exe": "opera",
  "thorium.exe": "thorium",
  "chromium.exe": "chromium",
  // macOS
  "google chrome": "chrome",
  "microsoft edge": "edge",
  "brave browser": "brave",
  vivaldi: "vivaldi",
  opera: "opera",
  thorium: "thorium",
  chromium: "chromium",
  arc: "arc",
};

function classify(processName: string): BrowserKind | null {
  return PROCESS_NAME_TO_KIND[processName.toLowerCase()] ?? null;
}

/**
 * Detect the most likely running Chromium-family browser. "Most likely" =
 * first match in PROCESS_NAME_TO_KIND that has a running process. Returns
 * null if nothing matches.
 *
 * Phase 2b v1 doesn't try to disambiguate when multiple browsers are
 * running. The caller's MCP tool spec lets the user specify which one to
 * take over; defaulting to "first detected" is fine for the common case.
 */
export async function detectRunningBrowser(
  platform: NodeJS.Platform = process.platform,
  preferred?: BrowserKind,
): Promise<BrowserProcessInfo | null> {
  const procs = await listChromiumProcesses(platform);
  if (preferred) {
    const hit = procs.find((p) => p.kind === preferred);
    if (hit) return hit;
  }
  return procs[0] ?? null;
}

interface RawProc {
  pid: number;
  name: string;
}

async function listChromiumProcesses(
  platform: NodeJS.Platform,
): Promise<BrowserProcessInfo[]> {
  let raw: RawProc[] = [];
  if (platform === "win32") {
    raw = await listWinProcesses();
  } else if (platform === "darwin") {
    raw = await listMacProcesses();
  } else {
    return [];
  }
  const seen = new Set<BrowserKind>();
  const out: BrowserProcessInfo[] = [];
  for (const { pid, name } of raw) {
    const kind = classify(name);
    if (!kind) continue;
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push({ pid, kind });
  }
  return out;
}

async function listWinProcesses(): Promise<RawProc[]> {
  try {
    const { stdout } = await execa(
      "tasklist",
      ["/fo", "csv", "/nh"],
      { reject: false },
    );
    const out: RawProc[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (!m) continue;
      const name = m[1];
      const pid = parseInt(m[2], 10);
      if (!Number.isFinite(pid)) continue;
      out.push({ pid, name });
    }
    return out;
  } catch {
    return [];
  }
}

async function listMacProcesses(): Promise<RawProc[]> {
  try {
    const { stdout } = await execa(
      "ps",
      ["-ax", "-o", "pid=,comm="],
      { reject: false },
    );
    const out: RawProc[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const full = m[2].trim();
      // `comm` on mac is the full path to the executable; the leaf name
      // (e.g. "Google Chrome") is what we match against.
      const leaf = full.split("/").pop() ?? full;
      out.push({ pid, name: leaf });
    }
    return out;
  } catch {
    return [];
  }
}
