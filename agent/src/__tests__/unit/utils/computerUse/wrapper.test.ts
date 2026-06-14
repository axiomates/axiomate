import { describe, expect, it, vi } from 'vitest'

import type { ContentBlockParam } from '../../../../services/api/streamTypes.js'
import { sideQuery } from '../../../../services/api/capabilities/sideQuery.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../../../utils/imageResizer.js'
import { buildSessionContext } from '../../../../utils/computerUse/wrapper.js'

vi.mock('../../../../bootstrap/state.js', () => ({
  getSessionId: vi.fn(() => 'session-123'),
}))

vi.mock(
  '../../../../components/permissions/ComputerUseApproval/ComputerUseApproval.js',
  () => ({
    ComputerUseApproval: vi.fn(),
  }),
)

vi.mock('../../../../utils/computerUse/computerUseLock.js', () => ({
  checkComputerUseLock: vi.fn(() => ({ kind: 'free' })),
  tryAcquireComputerUseLock: vi.fn(async () => ({ kind: 'held_by_self', fresh: false })),
}))

vi.mock('../../../../utils/computerUse/escHotkey.js', () => ({
  registerEscHotkey: vi.fn(() => true),
}))

vi.mock('../../../../utils/imageResizer.js', () => ({
  maybeResizeAndDownsampleImageBuffer: vi.fn(async () => ({
    buffer: Buffer.from('resized-vision-image'),
    mediaType: 'jpeg',
  })),
}))

vi.mock('../../../../utils/model/model.js', () => ({
  getMainLoopModel: vi.fn(() => 'vision-model'),
}))

const providerMock = { name: 'openai-chat' }

vi.mock('../../../../services/api/providerRegistry.js', () => ({
  getProviderForModel: vi.fn(() => providerMock),
}))

vi.mock('../../../../services/api/capabilities/sideQuery.js', () => ({
  sideQuery: vi.fn(async () => ({
    id: 'side-query',
    content: [{ type: 'text', text: '{"ok":true}' }],
    model: 'vision-model',
    stopReason: 'end_turn',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  })),
}))

describe('computer-use vlQuery image handling', () => {
  it('resizes base64 images before sending the side query', async () => {
    const original = Buffer.from('raw-vision-image')
    const ctx = buildSessionContext()

    const result = await ctx.vlQuery?.({
      images: [original.toString('base64')],
      prompt: 'find the button',
      schema: { type: 'object' },
    })

    expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledWith(
      original,
      original.length,
      'jpeg',
      { forceJpeg: true },
    )
    expect(sideQuery).toHaveBeenCalledTimes(1)

    const [, options] = vi.mocked(sideQuery).mock.calls[0]! as unknown as [
      unknown,
      {
        messages: Array<{ content: string | ContentBlockParam[] }>
      },
    ]
    const content = options.messages[0]!.content as ContentBlockParam[]
    expect(content[0]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: Buffer.from('resized-vision-image').toString('base64'),
      },
    })
    expect(content[1]).toEqual({ type: 'text', text: 'find the button' })
    expect(result).toEqual({ text: '{"ok":true}', parsed: { ok: true } })
  })
})
