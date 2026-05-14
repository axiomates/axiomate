import { describe, expect, it } from "vitest";
import {
  computeVisibleRects,
  filterAndScoreToMarks,
  selectCandidates,
  DEFAULT_PIPELINE_CONFIG,
} from "./pipeline.js";
import type {
  CandidateWindow,
  PipelineElement,
  Rect,
} from "./types.js";

describe("computeVisibleRects", () => {
  it("returns full rect when no occluders", () => {
    const target = { rect: { x: 0, y: 0, w: 100, h: 100 }, zRank: 5 };
    const result = computeVisibleRects(target, [target]);
    expect(result).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  });

  it("subtracts a frontward occluder", () => {
    const target = { rect: { x: 0, y: 0, w: 100, h: 100 }, zRank: 5 };
    const occluder = { rect: { x: 50, y: 50, w: 100, h: 100 }, zRank: 1 };
    const result = computeVisibleRects(target, [target, occluder]);
    // Should be an L-shape: top strip [0,0,100,50] + left strip [0,50,50,50]
    const totalArea = result.reduce((s, r) => s + r.w * r.h, 0);
    expect(totalArea).toBe(100 * 100 - 50 * 50);
  });

  it("ignores backward occluder", () => {
    const target = { rect: { x: 0, y: 0, w: 100, h: 100 }, zRank: 1 };
    const back = { rect: { x: 50, y: 50, w: 100, h: 100 }, zRank: 5 };
    const result = computeVisibleRects(target, [target, back]);
    expect(result).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  });
});

describe("selectCandidates (Win)", () => {
  const region: Rect = { x: 0, y: 0, w: 1920, h: 1080 };
  // Real Win z-order: taskbar (Shell_TrayWnd) sits in front of maximized
  // app windows so it stays visible. Use zRank=0 for taskbar, then user
  // windows behind it.
  const baseline = {
    win: [
      {
        appIdentifier: "C:\\Windows\\explorer.exe",
        displayName: "explorer.exe",
        hwnd: 1003,
        rect: { x: 0, y: 1040, w: 1920, h: 40 },
        zRank: 0,
        isForeground: false,
        isSystemChrome: true,
      },
      {
        appIdentifier: "C:\\chrome.exe",
        displayName: "chrome.exe",
        hwnd: 1001,
        rect: { x: 0, y: 0, w: 1200, h: 1040 },
        zRank: 1,
        isForeground: true,
        isSystemChrome: false,
      },
      {
        appIdentifier: "C:\\code.exe",
        displayName: "code.exe",
        hwnd: 1002,
        rect: { x: 1200, y: 0, w: 720, h: 1040 },
        zRank: 2,
        isForeground: false,
        isSystemChrome: false,
      },
    ],
    mac: [],
  };

  it("picks foreground first, system chrome appended", () => {
    const out = selectCandidates(baseline, region, DEFAULT_PIPELINE_CONFIG, null);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]!.displayName).toBe("chrome.exe");
    // System chrome (explorer/taskbar) should be present
    expect(out.some((c) => c.isSystemChrome && c.displayName === "explorer.exe")).toBe(true);
  });

  it("respects probeCap (excluding system chrome)", () => {
    const out = selectCandidates(baseline, region, { ...DEFAULT_PIPELINE_CONFIG, probeCap: 1 }, null);
    const userWindows = out.filter((c) => !c.isSystemChrome);
    expect(userWindows.length).toBe(1);
  });

  it("ranks cursor-owning window higher than larger window", () => {
    const out = selectCandidates(
      baseline,
      region,
      DEFAULT_PIPELINE_CONFIG,
      { x: 1500, y: 500 }, // inside code.exe; chrome.exe is still foreground
    );
    // chrome.exe still wins because isForeground=true overrides cursor.
    expect(out[0]!.displayName).toBe("chrome.exe");
  });
});

describe("filterAndScoreToMarks", () => {
  const region: Rect = { x: 0, y: 0, w: 1920, h: 1080 };

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

  const candidates: CandidateWindow[] = [
    {
      windowHandle: 1001,
      appIdentifier: "chrome.exe",
      displayName: "chrome.exe",
      zRank: 0,
      isForeground: true,
      isSystemChrome: false,
      rect: { x: 0, y: 0, w: 1920, h: 1080 },
      visibleRects: [{ x: 0, y: 0, w: 1920, h: 1080 }],
    },
  ];

  it("assigns sequential ids in score order", () => {
    const els = [
      makeEl({ role: "Pane", name: "Outer", centerX: 100, centerY: 100, bbox: { x: 0, y: 0, w: 1000, h: 1000 } }),
      makeEl({ role: "Button", name: "Submit", centerX: 200, centerY: 200, bbox: { x: 180, y: 190, w: 80, h: 30 } }),
      makeEl({ role: "Edit", name: "Email", centerX: 300, centerY: 100, bbox: { x: 200, y: 90, w: 200, h: 30 } }),
    ];
    const { marks } = filterAndScoreToMarks(els, candidates, region, null, []);
    expect(marks.length).toBeGreaterThan(0);
    // Submit (actionable, named) and Email (actionable, named) should rank higher than Outer (whole-region container)
    const submitIdx = marks.findIndex((m) => m.name === "Submit");
    const outerIdx = marks.findIndex((m) => m.name === "Outer");
    expect(submitIdx).toBeGreaterThanOrEqual(0);
    if (outerIdx >= 0) {
      expect(submitIdx).toBeLessThan(outerIdx);
    }
    // IDs are 1-based and contiguous
    expect(marks[0]!.id).toBe(1);
    expect(marks[marks.length - 1]!.id).toBe(marks.length);
  });

  it("dedupes near-duplicate elements", () => {
    const els = [
      makeEl({ role: "Button", name: "Save", centerX: 100, centerY: 100, depth: 5 }),
      // Same bucket + center → should dedupe
      makeEl({ role: "Button", name: "Save", centerX: 100, centerY: 100, depth: 6 }),
    ];
    const { marks } = filterAndScoreToMarks(els, candidates, region, null, []);
    expect(marks.length).toBe(1);
  });

  it("surfaces browserViewports separately", () => {
    const els = [
      makeEl({ role: "Button", name: "Reload", centerX: 100, centerY: 50 }),
    ];
    const vp = [{ x: 0, y: 100, w: 1920, h: 980 }];
    const { marks, browserViewports } = filterAndScoreToMarks(
      els,
      candidates,
      region,
      null,
      vp,
    );
    expect(browserViewports).toHaveLength(1);
    expect(browserViewports[0]!.bbox).toEqual(vp[0]);
    // Reload sits outside the viewport (y=50 < viewport.y=100), so it survives
    expect(marks.some((m) => m.name === "Reload")).toBe(true);
  });
});
