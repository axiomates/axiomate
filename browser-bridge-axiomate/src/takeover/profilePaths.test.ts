import { describe, expect, it } from "vitest";
import { defaultProfilePath } from "./profilePaths.js";

describe("defaultProfilePath", () => {
  it("returns null on linux", () => {
    expect(defaultProfilePath("chrome", "linux", {})).toBeNull();
  });

  it("resolves Chrome on darwin", () => {
    const r = defaultProfilePath("chrome", "darwin");
    expect(r?.userDataDir).toMatch(/[\\/]Library[\\/]Application Support[\\/]Google[\\/]Chrome$/);
  });

  it("resolves Edge on darwin", () => {
    const r = defaultProfilePath("edge", "darwin");
    expect(r?.userDataDir).toMatch(/Microsoft Edge$/);
  });

  it("returns null on win32 without LOCALAPPDATA", () => {
    expect(defaultProfilePath("chrome", "win32", {})).toBeNull();
  });

  it("resolves Chrome on win32 with LOCALAPPDATA", () => {
    const r = defaultProfilePath("chrome", "win32", {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    });
    expect(r?.userDataDir).toMatch(/Google[\\/]Chrome[\\/]User Data$/);
  });

  it("resolves Edge on win32 with LOCALAPPDATA", () => {
    const r = defaultProfilePath("edge", "win32", {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    });
    expect(r?.userDataDir).toMatch(/Microsoft[\\/]Edge[\\/]User Data$/);
  });

  it("returns null for unknown kind", () => {
    expect(defaultProfilePath("unknown", "darwin")).toBeNull();
    expect(
      defaultProfilePath("unknown", "win32", {
        LOCALAPPDATA: "C:\\x",
      }),
    ).toBeNull();
  });
});
