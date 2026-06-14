import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from '../../../utils/imageResizer.js'

const getImageProcessorMock = vi.hoisted(() => vi.fn())

vi.mock('../../../tools/FileReadTool/imageProcessor.js', () => ({
  getImageProcessor: getImageProcessorMock,
}))

vi.mock('../../../utils/log.js', () => ({
  logError: vi.fn(),
}))

type FakeMetadata = {
  width?: number
  height?: number
  format?: string
}

type Operation =
  | { kind: 'resize'; width: number; height: number }
  | { kind: 'jpeg'; quality?: number }
  | { kind: 'png' }
  | { kind: 'toBuffer'; length: number }

function installSharpMock(
  metadata: FakeMetadata,
  outputLengths: readonly number[],
): { operations: Operation[]; toBufferCalls: () => number } {
  const operations: Operation[] = []
  let toBufferCalls = 0

  const sharp = vi.fn(() => {
    const instance = {
      metadata: vi.fn(async () => metadata),
      resize: vi.fn((width: number, height: number) => {
        operations.push({ kind: 'resize', width, height })
        return instance
      }),
      jpeg: vi.fn((options?: { quality?: number }) => {
        operations.push({ kind: 'jpeg', quality: options?.quality })
        return instance
      }),
      png: vi.fn(() => {
        operations.push({ kind: 'png' })
        return instance
      }),
      webp: vi.fn(() => instance),
      toBuffer: vi.fn(async () => {
        const length =
          outputLengths[
            Math.min(toBufferCalls, Math.max(outputLengths.length - 1, 0))
          ] ?? 1
        toBufferCalls += 1
        operations.push({ kind: 'toBuffer', length })
        return Buffer.alloc(length)
      }),
    }
    return instance
  })

  getImageProcessorMock.mockResolvedValue(sharp)

  return {
    operations,
    toBufferCalls: () => toBufferCalls,
  }
}

describe('maybeResizeAndDownsampleImageBuffer', () => {
  beforeEach(() => {
    getImageProcessorMock.mockReset()
  })

  it('continues aggressive JPEG fallback until the base64 payload fits', async () => {
    const harness = installSharpMock(
      { width: 4000, height: 3000, format: 'png' },
      [76, 76, 76, 76, 76, 76, 76, 75],
    )

    const result = await maybeResizeAndDownsampleImageBuffer(
      Buffer.alloc(300),
      300,
      'png',
      { targetRawSize: 75, allowRawFallback: false },
    )

    expect(result.buffer).toHaveLength(75)
    expect(result.mediaType).toBe('jpeg')
    expect(result.dimensions?.displayWidth).toBe(750)
    expect(harness.toBufferCalls()).toBe(8)
  })

  it('has a fixed upper bound for aggressive JPEG fallback attempts', async () => {
    const harness = installSharpMock(
      { width: 4000, height: 3000, format: 'png' },
      Array.from({ length: 20 }, () => 76),
    )

    await expect(
      maybeResizeAndDownsampleImageBuffer(Buffer.alloc(300), 300, 'png', {
        targetRawSize: 75,
        allowRawFallback: false,
      }),
    ).rejects.toBeInstanceOf(ImageResizeError)

    // 1 normal resize + 1 PNG optimization + 4 JPEG quality steps
    // + 6 aggressive fallback profiles.
    expect(harness.toBufferCalls()).toBe(12)
  })
})
