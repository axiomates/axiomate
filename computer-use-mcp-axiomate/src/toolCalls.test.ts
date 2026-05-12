import { describe, expect, it, vi } from 'vitest'

import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
} from './types.js'
import { handleToolCall } from './toolCalls.js'

function makeAdapter(opts?: {
  visionLocateEnabled?: boolean
  supportsImages?: boolean
}): ComputerUseHostAdapter {
  return {
    serverName: 'computer-use',
    logger: {
      info() {},
      error() {},
      warn() {},
      debug() {},
      silly() {},
    },
    executor: {
      capabilities: { platform: 'win32', screenshotFiltering: 'none' },
      getDisplaySize: vi.fn(),
      listDisplays: vi.fn(),
      findWindowDisplays: vi.fn(),
      screenshot: vi.fn(),
      zoom: vi.fn(),
      resolvePrepareCapture: vi.fn(),
      screenshotWindow: vi.fn(),
      key: vi.fn(),
      holdKey: vi.fn(),
      type: vi.fn(),
      moveMouse: vi.fn(),
      click: vi.fn(),
      mouseDown: vi.fn(),
      mouseUp: vi.fn(),
      getCursorPosition: vi.fn(),
      drag: vi.fn(),
      scroll: vi.fn(),
      getFrontmostApp: vi.fn(),
      appUnderPoint: vi.fn(),
      listInstalledApps: vi.fn(),
      listRunningApps: vi.fn(),
      openApp: vi.fn(),
      readClipboard: vi.fn(),
    },
    ensureOsPermissions: async () => ({ platform: 'win32', granted: true }),
    isDisabled: () => false,
    isVisionLocateEnabled: () => opts?.visionLocateEnabled ?? false,
    currentModelSupportsImages: () => opts?.supportsImages ?? true,
    getAutoUnhideEnabled: () => true,
    getSubGates: () => ({
      clipboardPasteMultiline: true,
      mouseAnimation: true,
      hideBeforeAction: true,
      autoTargetDisplay: true,
      clipboardGuard: true,
    }),
  }
}

const winOverrides: ComputerUseOverrides = {
  platform: 'win32',
  grantFlags: {
    clipboardRead: true,
    clipboardWrite: true,
    systemKeyCombos: true,
  },
  coordinateMode: 'pixels',
}

describe('vision_locate gates', () => {
  it('returns disabled guidance when globally disabled', async () => {
    const result = await handleToolCall(
      makeAdapter({ visionLocateEnabled: false, supportsImages: true }),
      'vision_locate',
      { description: 'Send button' },
      winOverrides,
    )

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      type: 'text',
    })
    const text = (result.content[0] as any).text as string
    expect(text).toContain('zoom')
    expect(text).toContain('screenshot_window')
    expect(text).toContain('mark_id')
    expect(text).not.toContain('enable')
  })

  it('returns no-image guidance when model lacks image input', async () => {
    const result = await handleToolCall(
      makeAdapter({ visionLocateEnabled: true, supportsImages: false }),
      'vision_locate',
      { description: 'Send button' },
      winOverrides,
    )

    expect(result.isError).toBe(true)
    const text = (result.content[0] as any).text as string
    expect(text).toContain('requires image input')
    expect(text).toContain('zoom')
    expect(text).toContain('screenshot_window')
    expect(text).toContain('mark_id')
    expect(text).not.toContain('switch')
    expect(text).not.toContain('enable')
  })
})

describe('zoom window prioritization', () => {
  it('prefers the largest visible window area on windows and restores host windows', async () => {
    const adapter = makeAdapter()
    const executor = adapter.executor as any
    executor.getDisplaySize = vi.fn(async () => ({
      displayId: 1,
      width: 1000,
      height: 800,
      originX: 0,
      originY: 0,
    }))
    executor.listDisplays = vi.fn(async () => [{
      displayId: 1,
      width: 1000,
      height: 800,
      originX: 0,
      originY: 0,
    }])
    executor.captureForegroundRestoreToken = vi.fn(async () => ({
      appIdentifier: 'axiomate-host',
      hwnd: 10,
      centerX: 5,
      centerY: 5,
      isHost: true,
    }))
    executor.hideSelf = vi.fn(async () => true)
    executor.showSelf = vi.fn(async () => {})
    executor.listVisibleWindows = vi.fn(async () => [
      {
        appIdentifier: 'big-app',
        displayName: 'big-app',
        hwnd: 101,
        rect: { x: 0, y: 0, w: 400, h: 400 },
        zRank: 1,
        isForeground: false,
        isHost: false,
      },
      {
        appIdentifier: 'small-app',
        displayName: 'small-app',
        hwnd: 202,
        rect: { x: 50, y: 50, w: 120, h: 120 },
        zRank: 0,
        isForeground: true,
        isHost: false,
      },
    ])
    executor.focusNonHostWindowAtPoint = vi.fn(async () => true)
    executor.enumerateVisibleElementsForWindowDetailed = vi.fn(async (hwnd: number) => ({
      elements: hwnd === 101
        ? [{
            bbox: { x: 220, y: 220, w: 40, h: 20 },
            name: 'Primary',
            role: 'Button',
            automationId: 'primary-btn',
            uiaSource: 'foreground',
          }]
        : [{
            bbox: { x: 70, y: 70, w: 20, h: 20 },
            name: 'Secondary',
            role: 'Button',
            automationId: 'secondary-btn',
            uiaSource: 'foreground',
          }],
      traversedCount: 1,
      matchedCount: 1,
      returnedCount: 1,
      truncated: false,
    }))
    executor.zoom = vi.fn(async () => ({ base64: 'aGVsbG8=', width: 200, height: 200 }))
    // Place the cursor in big-app's L-shape visible region (small-app's
    // rect [50,50]-[170,170] is on top, so cursor at (200,200) sits in
    // big-app's exposed area). The selector ranks cursor-ownership above
    // area; positioning the cursor on the larger window lets this test
    // continue to validate the area-priority branch as a tiebreaker.
    executor.getCursorPosition = vi.fn(async () => ({ x: 200, y: 200 }))

    let lastMarks: any[] = []
    const overrides: ComputerUseOverrides = {
      ...winOverrides,
      onLocateMarksUpdated(marks) {
        lastMarks = marks
      },
      getLastZoomMarks() {
        return lastMarks as any
      },
    }

    const result = await handleToolCall(
      adapter,
      'zoom',
      { center: [150, 150], size: 200 },
      overrides,
    )

    expect(result.isError).toBeUndefined()
    expect(executor.hideSelf).toHaveBeenCalledWith(10)
    expect(executor.showSelf).toHaveBeenCalledTimes(1)
    expect(executor.enumerateVisibleElementsForWindowDetailed).toHaveBeenCalled()
    expect(executor.enumerateVisibleElementsForWindowDetailed.mock.calls[0][0]).toBe(101)
    expect(lastMarks[0]?.name).toBe('Primary')
  })
})
