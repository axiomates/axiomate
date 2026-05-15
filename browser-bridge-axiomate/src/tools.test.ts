import { describe, expect, it } from "vitest";
import { buildBrowserBridgeTools } from "./tools.js";

describe("buildBrowserBridgeTools", () => {
  const tools = buildBrowserBridgeTools();
  const names = tools.map((t) => t.name);

  it("includes the lifecycle trio", () => {
    expect(names).toContain("browser_takeover");
    expect(names).toContain("browser_takeover_status");
    expect(names).toContain("browser_release");
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

  it("includes the CDP escape hatch", () => {
    expect(names).toContain("browser_cdp");
    const cdp = tools.find((t) => t.name === "browser_cdp");
    const schema: any = cdp!.inputSchema;
    expect(schema.required).toContain("method");
  });

  it("every tool has a description and inputSchema", () => {
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema, t.name).toBeDefined();
    }
  });
});
