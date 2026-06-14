import { beforeEach, describe, expect, it, vi } from 'vitest'

import { execa } from 'execa'
import {
  getImageFromClipboard,
  getImagePathsFromClipboard,
  hasImageInClipboard,
} from '../../../utils/imagePaste.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../../utils/imageResizer.js'
import {
  hasClipboardImageAsync,
  readClipboardFilePaths,
  readClipboardImageAsync,
} from 'image-processor-axiomate'
import { getFsImplementation } from '../../../utils/fsOperations.js'

vi.mock('image-processor-axiomate', () => ({
  hasClipboardImageAsync: vi.fn(async () => true),
  readClipboardFilePaths: vi.fn(async () => [
    'C:\\Users\\kiro\\Desktop\\QQ20260614-033959.png',
  ]),
  readClipboardImageAsync: vi.fn(async () => ({
    png: Buffer.from('raw-clipboard-png'),
    originalWidth: 4000,
    originalHeight: 3000,
    width: 4000,
    height: 3000,
  })),
}))

vi.mock('execa', () => ({
  execa: vi.fn(async (command: string) => {
    if (String(command).includes('Get-Clipboard -Format Image')) {
      return { exitCode: 0, stdout: 'True', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }),
}))

vi.mock('../../../utils/fsOperations.js', () => ({
  getFsImplementation: vi.fn(() => ({
    readFileBytesSync: vi.fn(() => Buffer.from('shell-fallback-png')),
  })),
}))

vi.mock('../../../utils/imageResizer.js', () => ({
  detectImageFormatFromBase64: vi.fn(() => 'image/jpeg'),
  maybeResizeAndDownsampleImageBuffer: vi.fn(async () => ({
    buffer: Buffer.from('compressed-image'),
    mediaType: 'jpeg',
    dimensions: {
      originalWidth: 4000,
      originalHeight: 3000,
      displayWidth: 2000,
      displayHeight: 1500,
    },
  })),
}))

describe('imagePaste clipboard image handling', () => {
  beforeEach(() => {
    vi.mocked(hasClipboardImageAsync).mockClear()
    vi.mocked(readClipboardFilePaths).mockClear()
    vi.mocked(readClipboardImageAsync).mockClear()
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockClear()
    vi.mocked(execa).mockClear()
    vi.mocked(getFsImplementation).mockClear()
  })

  it('checks clipboard images through the cross-platform async reader', async () => {
    await expect(hasImageInClipboard()).resolves.toBe(true)
    expect(hasClipboardImageAsync).toHaveBeenCalled()
  })

  it('normalizes clipboard image bytes through the resize/compression path', async () => {
    const image = await getImageFromClipboard()

    expect(readClipboardImageAsync).toHaveBeenCalledWith(2000, 2000)
    expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledWith(
      Buffer.from('raw-clipboard-png'),
      Buffer.from('raw-clipboard-png').length,
      'png',
    )
    expect(image).toEqual({
      base64: Buffer.from('compressed-image').toString('base64'),
      mediaType: 'image/jpeg',
      dimensions: {
        originalWidth: 4000,
        originalHeight: 3000,
        displayWidth: 2000,
        displayHeight: 1500,
      },
    })
  })

  it('falls back to shell clipboard read when the async reader returns null', async () => {
    vi.mocked(readClipboardImageAsync).mockResolvedValueOnce(null)

    const image = await getImageFromClipboard()

    expect(execa).toHaveBeenCalled()
    expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledWith(
      Buffer.from('shell-fallback-png'),
      Buffer.from('shell-fallback-png').length,
      'png',
    )
    expect(image?.base64).toBe(Buffer.from('compressed-image').toString('base64'))
  })

  it('reads clipboard file paths through image-processor', async () => {
    await expect(getImagePathsFromClipboard()).resolves.toEqual([
      'C:\\Users\\kiro\\Desktop\\QQ20260614-033959.png',
    ])
    expect(readClipboardFilePaths).toHaveBeenCalled()
  })
})
