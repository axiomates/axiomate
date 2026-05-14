import { describe, expect, it } from "vitest";
import { classifyRole, isNameUseful, scoreElement } from "./score.js";
import type { PipelineElement } from "./types.js";

function makeEl(partial: Partial<PipelineElement>): PipelineElement {
  return {
    bbox: { x: 0, y: 0, w: 50, h: 30 },
    name: "",
    role: "Unknown",
    controlTypeId: 0,
    className: "",
    automationId: undefined,
    frameworkId: "",
    localizedControlType: "",
    isOffscreen: false,
    nativeWindowHandle: 0,
    parentIndex: -1,
    depth: 0,
    windowIndex: 0,
    centerX: 25,
    centerY: 15,
    ...partial,
  };
}

describe("classifyRole", () => {
  it("classifies UIA roles directly", () => {
    expect(classifyRole("Button")).toMatchObject({ bucket: "Button", isActionable: true });
    expect(classifyRole("Edit")).toMatchObject({ bucket: "Edit", isActionable: true });
    expect(classifyRole("Pane")).toMatchObject({ bucket: "Pane", isContainer: true });
    expect(classifyRole("Document")).toMatchObject({ bucket: "Document", isContainer: true });
  });

  it("maps AX roles to UIA-style buckets", () => {
    expect(classifyRole("AXButton")).toMatchObject({ bucket: "Button", isActionable: true });
    expect(classifyRole("AXTextField")).toMatchObject({ bucket: "Edit", isActionable: true });
    expect(classifyRole("AXLink")).toMatchObject({ bucket: "Hyperlink", isActionable: true });
    expect(classifyRole("AXMenuItem")).toMatchObject({ bucket: "MenuItem", isActionable: true });
    expect(classifyRole("AXStaticText")).toMatchObject({ bucket: "Text" });
    expect(classifyRole("AXGroup")).toMatchObject({ bucket: "Group", isContainer: true });
  });

  it("disambiguates titlebar buttons by subrole", () => {
    expect(classifyRole("AXButton", "AXCloseButton")).toMatchObject({ bucket: "Button", isActionable: true });
    expect(classifyRole("AXButton", "AXMinimizeButton")).toMatchObject({ bucket: "Button" });
  });

  it("disambiguates AXSearchField as Edit", () => {
    expect(classifyRole("AXTextField", "AXSearchField")).toMatchObject({ bucket: "Edit" });
  });
});

describe("isNameUseful", () => {
  it("treats empty name as useful only for Edit", () => {
    expect(isNameUseful("", "Edit")).toBe(true);
    expect(isNameUseful("", "Button")).toBe(false);
  });

  it("rejects role-echo names", () => {
    expect(isNameUseful("Group", "Group")).toBe(false);
    expect(isNameUseful("group", "Group")).toBe(false);
    expect(isNameUseful("Window", "Window")).toBe(false);
    expect(isNameUseful("toolbar", "ToolBar")).toBe(false);
  });

  it("accepts semantic names", () => {
    expect(isNameUseful("Submit", "Button")).toBe(true);
    expect(isNameUseful("Username", "Edit")).toBe(true);
  });
});

describe("scoreElement", () => {
  const region = { x: 0, y: 0, w: 1000, h: 1000 };
  const ctx = { region, cursor: null, foregroundWindowIndex: -1 };

  it("ranks actionable above container", () => {
    const btn = makeEl({ role: "Button", name: "Click me", bbox: { x: 100, y: 100, w: 50, h: 30 }, centerX: 125, centerY: 115 });
    const pane = makeEl({ role: "Pane", name: "Container", bbox: { x: 100, y: 100, w: 50, h: 30 }, centerX: 125, centerY: 115 });
    expect(scoreElement(btn, ctx)).toBeGreaterThan(scoreElement(pane, ctx));
  });

  it("penalizes whole-region container", () => {
    const big = makeEl({
      role: "Pane",
      name: "Background",
      bbox: { x: 0, y: 0, w: 1000, h: 1000 },
      centerX: 500,
      centerY: 500,
    });
    const small = makeEl({
      role: "Pane",
      name: "Small",
      bbox: { x: 100, y: 100, w: 50, h: 30 },
      centerX: 125,
      centerY: 115,
    });
    expect(scoreElement(small, ctx)).toBeGreaterThan(scoreElement(big, ctx));
  });

  it("boosts foreground-app elements", () => {
    const fg = makeEl({
      role: "Button",
      name: "Save",
      windowIndex: 2,
      bbox: { x: 100, y: 100, w: 50, h: 30 },
      centerX: 125,
      centerY: 115,
    });
    const bg = makeEl({
      role: "Button",
      name: "Save",
      windowIndex: 5,
      bbox: { x: 100, y: 100, w: 50, h: 30 },
      centerX: 125,
      centerY: 115,
    });
    const fgCtx = { region, cursor: null, foregroundWindowIndex: 2 };
    expect(scoreElement(fg, fgCtx)).toBe(scoreElement(bg, fgCtx) + 50);
  });

  it("rewards cursor proximity with falloff", () => {
    const near = makeEl({
      role: "Button",
      name: "X",
      centerX: 110,
      centerY: 110,
      bbox: { x: 100, y: 100, w: 20, h: 20 },
    });
    const far = makeEl({
      role: "Button",
      name: "X",
      centerX: 500,
      centerY: 500,
      bbox: { x: 490, y: 490, w: 20, h: 20 },
    });
    const cursorCtx = { region, cursor: { x: 100, y: 100 }, foregroundWindowIndex: -1 };
    expect(scoreElement(near, cursorCtx)).toBeGreaterThan(scoreElement(far, cursorCtx));
  });

  it("penalizes deeper elements", () => {
    const shallow = makeEl({ role: "Button", name: "OK", depth: 0 });
    const deep = makeEl({ role: "Button", name: "OK", depth: 10 });
    expect(scoreElement(shallow, ctx)).toBeGreaterThan(scoreElement(deep, ctx));
  });
});
