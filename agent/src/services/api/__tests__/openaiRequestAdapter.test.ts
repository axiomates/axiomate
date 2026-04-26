import { describe, it, expect } from 'vitest'
import { messagesToOpenAI } from '../adapters/openaiRequestAdapter.js'
import type { MessageParam } from '../streamTypes.js'

// ---------------------------------------------------------------------------
// Image plumbing in messagesToOpenAI — protects two important invariants:
//
// 1. User-pasted images (top-level `image` block in a user message) flow
//    straight through into a single user message with `image_url` content.
//    This is the "复制图片到聊天框" path — must not regress.
// 2. Tool-returned images are NOT inlined into the role:'tool' message
//    (OpenAI forbids that). They get split: text/placeholder in the tool
//    message, image_url in a follow-up role:'user' message.
// ---------------------------------------------------------------------------

const TINY_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('messagesToOpenAI — user-pasted image (regression)', () => {
  it('emits user message with image_url for top-level image block', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: TINY_BASE64 },
          },
        ],
      },
    ]
    const out = messagesToOpenAI(messages)
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
    expect(Array.isArray(out[0]!.content)).toBe(true)
    const parts = out[0]!.content as Array<{ type: string; image_url?: { url: string } }>
    expect(parts).toHaveLength(2)
    expect(parts[0]!.type).toBe('text')
    expect(parts[1]!.type).toBe('image_url')
    expect(parts[1]!.image_url!.url).toBe(`data:image/png;base64,${TINY_BASE64}`)
  })
})

describe('messagesToOpenAI — text-only tool_result (regression)', () => {
  it('emits assistant(tool_calls) + tool(string content)', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: 'file1.txt' }],
          },
        ],
      },
    ]
    const out = messagesToOpenAI(messages)
    expect(out).toHaveLength(2)
    expect(out[0]!.role).toBe('assistant')
    expect(out[0]!.tool_calls).toHaveLength(1)
    expect(out[1]!.role).toBe('tool')
    expect(out[1]!.content).toBe('file1.txt')
    expect(out[1]!.tool_call_id).toBe('call_1')
  })

  it('passes through string content tool_result unchanged', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_x', content: 'plain text' },
        ],
      },
    ]
    const out = messagesToOpenAI(messages)
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('tool')
    expect(out[0]!.content).toBe('plain text')
  })
})

describe('messagesToOpenAI — tool_result with image (the fix)', () => {
  it('image-only: tool message gets placeholder + follow-up user message has image_url', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_2', name: 'screenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_2',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: TINY_BASE64 },
              },
            ],
          },
        ],
      },
    ]
    const out = messagesToOpenAI(messages)
    expect(out).toHaveLength(3)
    expect(out[0]!.role).toBe('assistant')
    expect(out[1]!.role).toBe('tool')
    expect(out[1]!.content).toBe('[Image returned in following message]')
    expect(out[1]!.tool_call_id).toBe('call_2')
    expect(out[2]!.role).toBe('user')
    const parts = out[2]!.content as Array<{ type: string; image_url?: { url: string } }>
    expect(parts).toHaveLength(1)
    expect(parts[0]!.type).toBe('image_url')
    expect(parts[0]!.image_url!.url).toBe(`data:image/jpeg;base64,${TINY_BASE64}`)
  })

  it('text+image: tool message keeps text, follow-up user message has image_url', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_3', name: 'screenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_3',
            content: [
              { type: 'text', text: 'screenshot dimensions: 1920x1080' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: TINY_BASE64 },
              },
            ],
          },
        ],
      },
    ]
    const out = messagesToOpenAI(messages)
    expect(out).toHaveLength(3)
    expect(out[1]!.role).toBe('tool')
    expect(out[1]!.content).toBe('screenshot dimensions: 1920x1080')
    expect(out[2]!.role).toBe('user')
    const parts = out[2]!.content as Array<{ type: string }>
    expect(parts[0]!.type).toBe('image_url')
  })

  it('supportsImages=false: image dropped, tool message gets informative text, no follow-up user msg', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_4', name: 'screenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_4',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: TINY_BASE64 },
              },
            ],
          },
        ],
      },
    ]
    const out = messagesToOpenAI(messages, undefined, { supportsImages: false })
    expect(out).toHaveLength(2)
    expect(out[1]!.role).toBe('tool')
    expect(out[1]!.content).toBe(
      '[Tool returned an image; this model does not support image input]',
    )
  })

  it('error tool_result with image: prefixes Error: + still emits image follow-up', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_5',
            is_error: true,
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: TINY_BASE64 },
              },
            ],
          },
        ],
      },
    ]
    const out = messagesToOpenAI(messages)
    expect(out).toHaveLength(2)
    expect(out[0]!.role).toBe('tool')
    expect(out[0]!.content).toBe('Error: [Image returned in following message]')
    expect(out[1]!.role).toBe('user')
  })
})
