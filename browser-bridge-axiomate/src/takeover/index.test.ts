import { describe, expect, it } from "vitest";
import { isTakeoverEnabled } from "./index.js";

describe("isTakeoverEnabled", () => {
  it("returns false when env var unset", () => {
    expect(isTakeoverEnabled({})).toBe(false);
  });

  it("returns false when env var is anything but '1'", () => {
    expect(isTakeoverEnabled({ AXIOMATE_BROWSER_TAKEOVER: "" })).toBe(false);
    expect(isTakeoverEnabled({ AXIOMATE_BROWSER_TAKEOVER: "0" })).toBe(false);
    expect(isTakeoverEnabled({ AXIOMATE_BROWSER_TAKEOVER: "true" })).toBe(false);
  });

  it("returns true when env var equals '1'", () => {
    expect(isTakeoverEnabled({ AXIOMATE_BROWSER_TAKEOVER: "1" })).toBe(true);
  });
});
