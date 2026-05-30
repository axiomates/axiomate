import React from 'react'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '../../../ink.js'
import useInput from '../../../ink/hooks/use-input.js'
import { usePasteHandler } from '../../../hooks/usePasteHandler.js'

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
}: {
  onSubmit: (value: string) => void
}): React.ReactNode {
  const valueRef = React.useRef('')
  const { wrappedOnInput, isPasting } = usePasteHandler({
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

async function renderProbe(onSubmit: (value: string) => void) {
  const stdin = new TestInput()
  const stdout = new TestOutput()
  const stderr = new TestOutput()
  const instance = await render(<PasteProbe onSubmit={onSubmit} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  await new Promise(resolve => setImmediate(resolve))
  return { stdin, instance }
}

describe('usePasteHandler', () => {
  afterEach(() => {
    vi.useRealTimers()
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
})
