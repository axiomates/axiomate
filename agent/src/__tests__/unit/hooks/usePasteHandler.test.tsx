import React from 'react'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '../../../ink.js'
import useInput from '../../../ink/hooks/use-input.js'
import { usePasteHandler } from '../../../hooks/usePasteHandler.js'
import {
  getImageFromClipboard,
  getImagePathsFromClipboard,
  tryReadImageFromPath,
} from '../../../utils/imagePaste.js'

vi.mock('../../../utils/imagePaste.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../utils/imagePaste.js')>()
  return {
    ...actual,
    getImageFromClipboard: vi.fn(),
    getImagePathsFromClipboard: vi.fn(),
    tryReadImageFromPath: vi.fn(),
  }
})

class TestInput extends PassThrough {
  isTTY = true
  isRaw = false

  ref(): this {
    return this
  }

  unref(): this {
    return this
  }

  setRawMode(raw: boolean): this {
    this.isRaw = raw
    return this
  }
}

class TestOutput extends PassThrough {
  isTTY = false
  columns = 80
  rows = 24
}

function PasteProbe({
  onSubmit,
  onPaste,
  onImagePaste,
}: {
  onSubmit: (value: string) => void
  onPaste?: (value: string) => void
  onImagePaste?: (base64: string, mediaType?: string) => void
}): React.ReactNode {
  const valueRef = React.useRef('')
  const { wrappedOnInput, isPasting } = usePasteHandler({
    onPaste,
    onImagePaste,
    onInput(input, key) {
      if (isPasting && key.return) return
      if (key.return) {
        onSubmit(valueRef.current)
        return
      }
      valueRef.current += input
    },
  })

  useInput(wrappedOnInput, { isActive: true })
  return null
}

async function renderProbe(
  onSubmit: (value: string) => void,
  options: {
    onPaste?: (value: string) => void
    onImagePaste?: (base64: string, mediaType?: string) => void
  } = {},
) {
  const stdin = new TestInput()
  const stdout = new TestOutput()
  const stderr = new TestOutput()
  const instance = await render(
    <PasteProbe onSubmit={onSubmit} {...options} />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
    },
  )
  await new Promise(resolve => setImmediate(resolve))
  return { stdin, instance }
}

describe('usePasteHandler', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(getImageFromClipboard).mockReset()
    vi.mocked(getImagePathsFromClipboard).mockReset()
    vi.mocked(tryReadImageFromPath).mockReset()
  })

  it('clears paste mode after short bracketed paste without an onPaste handler', async () => {
    const onSubmit = vi.fn()
    const { stdin, instance } = await renderProbe(onSubmit)

    stdin.write('\x1b[200~200000\x1b[201~')
    await new Promise(resolve => setImmediate(resolve))
    stdin.write('\r')
    await new Promise(resolve => setImmediate(resolve))

    expect(onSubmit).toHaveBeenCalledWith('200000')

    instance.unmount()
    instance.cleanup()
  })

  it('routes empty bracketed paste through clipboard image handling', async () => {
    vi.mocked(getImageFromClipboard).mockResolvedValue({
      base64: 'image-base64',
      mediaType: 'image/png',
      dimensions: {
        originalWidth: 4000,
        originalHeight: 3000,
        displayWidth: 2000,
        displayHeight: 1500,
      },
    })
    const onSubmit = vi.fn()
    const onPaste = vi.fn()
    const onImagePaste = vi.fn()
    const { stdin, instance } = await renderProbe(onSubmit, {
      onPaste,
      onImagePaste,
    })

    stdin.write('\x1b[200~\x1b[201~')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(getImageFromClipboard).toHaveBeenCalled()
    expect(onImagePaste).toHaveBeenCalledWith(
      'image-base64',
      'image/png',
      undefined,
      {
        originalWidth: 4000,
        originalHeight: 3000,
        displayWidth: 2000,
        displayHeight: 1500,
      },
    )
    expect(onPaste).not.toHaveBeenCalled()

    instance.unmount()
    instance.cleanup()
  })

  it('falls back from empty paste to clipboard file image paths', async () => {
    vi.mocked(getImageFromClipboard).mockResolvedValue(null)
    vi.mocked(getImagePathsFromClipboard).mockResolvedValue([
      'C:\\Users\\kiro\\Desktop\\QQ20260614-033959.png',
    ])
    vi.mocked(tryReadImageFromPath).mockResolvedValue({
      path: 'C:\\Users\\kiro\\Desktop\\QQ20260614-033959.png',
      base64: 'file-image-base64',
      mediaType: 'image/jpeg',
      dimensions: {
        originalWidth: 4096,
        originalHeight: 3072,
        displayWidth: 1600,
        displayHeight: 1200,
      },
    })
    const onSubmit = vi.fn()
    const onPaste = vi.fn()
    const onImagePaste = vi.fn()
    const { stdin, instance } = await renderProbe(onSubmit, {
      onPaste,
      onImagePaste,
    })

    stdin.write('\x1b[200~\x1b[201~')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(getImagePathsFromClipboard).toHaveBeenCalled()
    expect(tryReadImageFromPath).toHaveBeenCalledWith(
      'C:\\Users\\kiro\\Desktop\\QQ20260614-033959.png',
    )
    expect(onImagePaste).toHaveBeenCalledWith(
      'file-image-base64',
      'image/jpeg',
      'QQ20260614-033959.png',
      {
        originalWidth: 4096,
        originalHeight: 3072,
        displayWidth: 1600,
        displayHeight: 1200,
      },
      'C:\\Users\\kiro\\Desktop\\QQ20260614-033959.png',
    )
    expect(onPaste).not.toHaveBeenCalled()

    instance.unmount()
    instance.cleanup()
  })
})
