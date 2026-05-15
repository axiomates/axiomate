import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getBrowserCandidates,
  manualLaunchCommand,
  isolatedProfileDir,
} from "./launcher.js";

vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...real,
    existsSync: vi.fn(),
  };
});

import { existsSync } from "node:fs";

describe("getBrowserCandidates", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  it("returns no candidates on linux", () => {
    expect(getBrowserCandidates("linux", {})).toEqual([]);
  });

  it("filters darwin candidates by existsSync", () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      String(p).includes("Google Chrome.app"),
    );
    const out = getBrowserCandidates("darwin", {});
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("chrome");
  });

  it("orders darwin candidates: chrome before edge before brave", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const out = getBrowserCandidates("darwin", {});
    const kinds = out.map((c) => c.kind);
    expect(kinds.indexOf("chrome")).toBeLessThan(kinds.indexOf("edge"));
    expect(kinds.indexOf("edge")).toBeLessThan(kinds.indexOf("brave"));
  });

  it("requires env vars on win32", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(getBrowserCandidates("win32", {})).toEqual([]);
  });

  it("expands win32 env vars", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const out = getBrowserCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.path).toMatch(/Program Files.*chrome\.exe$/);
  });
});

describe("isolatedProfileDir", () => {
  it("lives under ~/.axiomate/browser-bridge", () => {
    expect(isolatedProfileDir()).toMatch(/[\\/]\.axiomate[\\/]browser-bridge[\\/]profile$/);
  });
});

describe("manualLaunchCommand", () => {
  it("returns null on linux", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(manualLaunchCommand(9222, "linux")).toBeNull();
  });

  it("returns null on darwin when no candidate exists", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(manualLaunchCommand(9222, "darwin")).toBeNull();
  });

  it("includes port and profile flags on darwin", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const cmd = manualLaunchCommand(9222, "darwin");
    expect(cmd).toContain("--remote-debugging-port=9222");
    expect(cmd).toContain("--user-data-dir=");
    expect(cmd).toContain("--no-first-run");
  });
});
