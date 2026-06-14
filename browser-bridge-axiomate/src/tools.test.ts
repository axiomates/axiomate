import { describe, expect, it } from "vitest";
import { buildBrowserBridgeTools } from "./tools.js";

describe("buildBrowserBridgeTools", () => {
  const tools = buildBrowserBridgeTools();
  const names = tools.map((t) => t.name);

  it("includes the lifecycle trio", () => {
    expect(names).toContain("browser_attach");
    expect(names).toContain("browser_status");
    expect(names).toContain("browser_detach");
  });

  it("includes navigation primitives", () => {
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_back");
    expect(names).toContain("browser_forward");
    expect(names).toContain("browser_reload");
  });

  it("includes the snapshot/click pair", () => {
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_click");
    const click = tools.find((t) => t.name === "browser_click");
    expect(click?.inputSchema).toBeDefined();
    const schema: any = click!.inputSchema;
    expect(schema.required).toContain("ref");
  });

  it("includes the tab quartet", () => {
    expect(names).toContain("browser_tab_new");
    expect(names).toContain("browser_tab_close");
    expect(names).toContain("browser_tab_switch");
    expect(names).toContain("browser_tab_list");
  });

  it("includes hermes-parity tools (console, get_images, vision)", () => {
    expect(names).toContain("browser_console");
    expect(names).toContain("browser_get_images");
    expect(names).toContain("browser_vision");
  });

  it("does NOT expose the old takeover-shaped names", () => {
    expect(names).not.toContain("browser_takeover");
    expect(names).not.toContain("browser_takeover_status");
    expect(names).not.toContain("browser_release");
  });

  it("does NOT expose browser_cdp (agent-browser has no arbitrary-CDP passthrough)", () => {
    expect(names).not.toContain("browser_cdp");
  });

  it("every tool has a description and inputSchema", () => {
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema, t.name).toBeDefined();
    }
  });

  it("does not expose schema fields that the bridge cannot pass through", () => {
    const reload = tools.find((t) => t.name === "browser_reload");
    expect((reload?.inputSchema as any).properties).not.toHaveProperty("ignoreCache");
  });

  it("exposes implemented optional snapshot controls", () => {
    const snapshot = tools.find((t) => t.name === "browser_snapshot");
    const props = (snapshot?.inputSchema as any).properties;
    expect(props).toHaveProperty("interactive");
    expect(props).toHaveProperty("urls");
    expect(props).toHaveProperty("depth");
    expect(props).toHaveProperty("selector");
  });
});
