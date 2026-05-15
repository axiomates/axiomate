import { describe, expect, it, beforeEach } from "vitest";
import {
  getSessionConsent,
  setSessionConsent,
  clearSessionConsent,
} from "./consent.js";

describe("consent map", () => {
  beforeEach(() => clearSessionConsent());

  it("starts empty", () => {
    expect(getSessionConsent("chrome")).toBeUndefined();
  });

  it("persists approve_session", () => {
    setSessionConsent("chrome", "approve_session");
    expect(getSessionConsent("chrome")).toBe("approve_session");
  });

  it("persists deny", () => {
    setSessionConsent("edge", "deny");
    expect(getSessionConsent("edge")).toBe("deny");
  });

  it("does NOT persist approve_once", () => {
    setSessionConsent("chrome", "approve_once");
    expect(getSessionConsent("chrome")).toBeUndefined();
  });

  it("clear wipes everything", () => {
    setSessionConsent("chrome", "approve_session");
    setSessionConsent("edge", "deny");
    clearSessionConsent();
    expect(getSessionConsent("chrome")).toBeUndefined();
    expect(getSessionConsent("edge")).toBeUndefined();
  });
});
