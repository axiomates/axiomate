import { describe, expect, it, vi } from 'vitest'

import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
} from './types.js'
import { handleToolCall } from './toolCalls.js'

function makeAdapter(): ComputerUseHostAdapter {
  return {
    serverName: 'computer-use',
    logger: { info() {}, error() {}, warn() {}, debug() {}, silly() {} },
    executor: {
      capabilities: { platform: 'win32', screenshotFiltering: 'none' },
      getDisplaySize: vi.fn(async () => ({
        displayId: 1,
        width: 100,
        height: 100,
        originX: 0,
        originY: 0,
      })),
      listDisplays: vi.fn(),
      findWindowDisplays: vi.fn(),
      screenshot: vi.fn(async () => ({
        base64: 'aGVsbG8=',
        width: 100,
        height: 100,
        displayId: 1,
        displayWidth: 100,
        displayHeight: 100,
        originX: 0,
        originY: 0,
      })),
      zoom: vi.fn(async () => ({ base64: 'aGVsbG8=', width: 50, height: 50 })),
      resolvePrepareCapture: vi.fn(async () => ({
        displayId: 1,
        base64: 'aGVsbG8=',
        width: 100,
        height: 100,
        displayWidth: 100,
        displayHeight: 100,
        originX: 0,
        originY: 0,
      })),
      screenshotWindow: vi.fn(async () => ({
        base64: 'aGVsbG8=',
        width: 100,
        height: 100,
        displayId: 1,
        displayWidth: 100,
        displayHeight: 100,
        originX: 0,
        originY: 0,
      })),
      key: vi.fn(),
      holdKey: vi.fn(),
      type: vi.fn(),
      moveMouse: vi.fn(),
      click: vi.fn(),
      mouseDown: vi.fn(),
      mouseUp: vi.fn(),
      getCursorPosition: vi.fn(async () => ({ x: 10, y: 10 })),
      drag: vi.fn(),
      scroll: vi.fn(),
      getFrontmostApp: vi.fn(),
      appUnderPoint: vi.fn(),
      listInstalledApps: vi.fn(),
      listRunningApps: vi.fn(async () => []),
      openApp: vi.fn(),
      readClipboard: vi.fn(),
      enumerateVisibleElements: vi.fn(async () => [
        {
          bbox: { x: 10, y: 10, w: 20, h: 10 },
          name: 'Send',
          role: 'Button',
          automationId: 'send-btn',
          uiaSource: 'foreground',
        },
      ]),
    },
    ensureOsPermissions: async () => ({ platform: 'win32', granted: true }),
    isDisabled: () => false,
    isVisionLocateEnabled: () => true,
    currentModelSupportsImages: () => false,
    getAutoUnhideEnabled: () => true,
    getSubGates: () => ({
      clipboardPasteMultiline: true,
      mouseAnimation: true,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: true,
    }),
  }
}

const overrides: ComputerUseOverrides = {
  platform: 'win32',
  grantFlags: {
    clipboardRead: true,
    clipboardWrite: true,
    systemKeyCombos: true,
  },
  coordinateMode: 'pixels',
}

describe('non-VL feedback', () => {
  it('screenshot_window emphasizes text SoM and mark_id', async () => {
    const result = await handleToolCall(
      makeAdapter(),
      'screenshot_window',
      { app_identifier: 'fake-app' },
      overrides,
    )
    const text = result.content.find(c => c.type === 'text')
    expect(text && 'text' in text ? text.text : '').toContain('does not process image content')
    expect(text && 'text' in text ? text.text : '').toContain('mark_id')
  })
})
