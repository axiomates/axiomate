import { describe, expect, it } from "vitest";
import { filterMeaningfulElements } from "./filter.js";
import type { PipelineElement, Rect } from "./types.js";

function makeEl(partial: Partial<PipelineElement>): PipelineElement {
  return {
    bbox: { x: 0, y: 0, w: 50, h: 30 },
    name: "",
    role: "Button",
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

const region: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
const visibleAll: Rect[] = [{ x: 0, y: 0, w: 1000, h: 1000 }];

describe("filterMeaningfulElements", () => {
  it("drops zero-size bbox", () => {
    const el = makeEl({ bbox: { x: 0, y: 0, w: 0, h: 30 } });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toEqual([]);
  });

  it("drops isOffscreen", () => {
    const el = makeEl({ role: "Button", name: "Hidden", isOffscreen: true });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toEqual([]);
  });

  it("drops hidden (mac)", () => {
    const el = makeEl({ role: "AXButton", name: "Hidden", hidden: true });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toEqual([]);
  });

  it("drops outside-region", () => {
    const el = makeEl({
      role: "Button",
      name: "OK",
      bbox: { x: 2000, y: 2000, w: 50, h: 30 },
      centerX: 2025,
      centerY: 2015,
    });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toEqual([]);
  });

  it("drops elements with center outside any visible rect", () => {
    const el = makeEl({
      role: "Button",
      name: "OK",
      bbox: { x: 100, y: 100, w: 50, h: 30 },
      centerX: 125,
      centerY: 115,
    });
    const visibleOnly = [{ x: 500, y: 500, w: 200, h: 200 }];
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleOnly,
      browserViewports: [],
    });
    expect(out).toEqual([]);
  });

  it("drops elements inside a browser viewport", () => {
    const el = makeEl({
      role: "Button",
      name: "Submit",
      bbox: { x: 100, y: 100, w: 50, h: 30 },
      centerX: 125,
      centerY: 115,
    });
    const viewport = { x: 50, y: 50, w: 500, h: 500 };
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [viewport],
    });
    expect(out).toEqual([]);
  });

  it("drops BrowserViewport sentinel itself from clickable list", () => {
    const el = makeEl({
      role: "BrowserViewport",
      name: "<browser web content>",
      bbox: { x: 100, y: 100, w: 800, h: 600 },
      centerX: 500,
      centerY: 400,
    });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toEqual([]);
  });

  it("keeps actionable Button regardless of name", () => {
    const el = makeEl({
      role: "Button",
      name: "",
      bbox: { x: 100, y: 100, w: 50, h: 30 },
      centerX: 125,
      centerY: 115,
    });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toHaveLength(1);
  });

  it("keeps named container", () => {
    const el = makeEl({
      role: "Group",
      name: "Search results",
      bbox: { x: 100, y: 100, w: 200, h: 200 },
      centerX: 200,
      centerY: 200,
    });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toHaveLength(1);
  });

  it("drops unnamed container", () => {
    const el = makeEl({
      role: "Group",
      name: "",
      bbox: { x: 100, y: 100, w: 200, h: 200 },
      centerX: 200,
      centerY: 200,
    });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toEqual([]);
  });

  it("drops role-echo unnamed Text", () => {
    const el = makeEl({
      role: "Text",
      name: "Image",
      bbox: { x: 100, y: 100, w: 50, h: 30 },
      centerX: 125,
      centerY: 115,
    });
    const out = filterMeaningfulElements([el], {
      region,
      visibleRects: visibleAll,
      browserViewports: [],
    });
    expect(out).toEqual([]);
  });
});
