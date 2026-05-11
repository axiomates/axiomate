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
