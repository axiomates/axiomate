import { describe, it, expect } from 'vitest'
import { messagesToOpenAI } from '../../../../services/api/adapters/openaiRequestAdapter.js'
import type { MessageParam } from '../../../../services/api/streamTypes.js'

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

  it('user msg with text AND tool_result: tool emitted BEFORE user text (regression)', () => {
    // Regression: when a user message has both text content and tool_result
    // blocks, tool messages must immediately follow the preceding assistant's
    // tool_calls. Emitting user text first would insert a `user` role between
    // `assistant(tool_calls)` and `tool`, which strict providers (DeepSeek V4
    // Pro) reject with HTTP 400.
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_t1', name: 'Bash', input: { cmd: 'ls' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Thanks, now run: make build' },
          {
            type: 'tool_result',
            tool_use_id: 'call_t1',
            content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
          },
        ],
      },
    ]
    const out = messagesToOpenAI(messages)
    expect(out).toHaveLength(3)
    expect(out[0]!.role).toBe('assistant')
    expect(out[0]!.tool_calls).toHaveLength(1)
    // tool MUST come before user text — OpenAI requires
    // assistant(tool_calls) -> tool, no other roles in between
    expect(out[1]!.role).toBe('tool')
    expect(out[1]!.content).toBe('file1.txt\nfile2.txt')
    expect(out[1]!.tool_call_id).toBe('call_t1')
    expect(out[2]!.role).toBe('user')
    expect(out[2]!.content).toBe('Thanks, now run: make build')
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

// ---------------------------------------------------------------------------
// reasoning_content round-trip (DeepSeek thinking mode)
//
// DeepSeek V4 Pro requires the assistant's chain-of-thought (delivered to us
// in streaming as `reasoning_content` and stored internally as `thinking`
// blocks) to be echoed back on subsequent turns when tool calls were involved
// — server returns 400 otherwise. Other providers either don't need it
// (OpenAI uses Responses API) or use a different mechanism (Qwen's
// `preserve_thinking` extra_body flag), so this is opt-in via the new
// `roundTripReasoningContent` config flag, threaded as an option to
// messagesToOpenAI alongside `supportsImages`.
//
// Default-off behavior must be preserved: thinking blocks are dropped (the
// pre-flag baseline) when the flag is absent or false.
// ---------------------------------------------------------------------------

describe('messagesToOpenAI — reasoning_content round-trip (opt-in)', () => {
  it('flag on + thinking + tool_use: emits reasoning_content alongside tool_calls', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me capture the screen.', roundTrip: { provider: 'none' } },
          { type: 'tool_use', id: 'call_r1', name: 'screenshot', input: {} },
        ],
      },
    ]
    const out = messagesToOpenAI(messages, undefined, {
      roundTripReasoningContent: true,
    })
    expect(out).toHaveLength(1)
    const m = out[0]! as { role: string; content: unknown; tool_calls?: unknown[]; reasoning_content?: string }
    expect(m.role).toBe('assistant')
    expect(m.content).toBeNull()
    expect(m.tool_calls).toHaveLength(1)
    expect(m.reasoning_content).toBe('Let me capture the screen.')
  })

  it('flag on + thinking + text: emits reasoning_content alongside content', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reasoning step', roundTrip: { provider: 'none' } },
          { type: 'text', text: 'Here is the answer' },
        ],
      },
    ]
    const out = messagesToOpenAI(messages, undefined, {
      roundTripReasoningContent: true,
    })
    expect(out).toHaveLength(1)
    const m = out[0]! as { role: string; content: unknown; reasoning_content?: string }
    expect(m.role).toBe('assistant')
    expect(m.content).toBe('Here is the answer')
    expect(m.reasoning_content).toBe('Reasoning step')
  })

  it('flag on + multiple thinking blocks: joined into single reasoning_content', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'First. ', roundTrip: { provider: 'none' } },
          { type: 'thinking', thinking: 'Second. ', roundTrip: { provider: 'none' } },
          { type: 'tool_use', id: 'call_r2', name: 'tool', input: {} },
        ],
      },
    ]
    const out = messagesToOpenAI(messages, undefined, {
      roundTripReasoningContent: true,
    })
    const m = out[0]! as { reasoning_content?: string }
    expect(m.reasoning_content).toBe('First. Second. ')
  })

  it('flag off (default): thinking dropped, no reasoning_content field — regression baseline', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Should be dropped', roundTrip: { provider: 'none' } },
          { type: 'tool_use', id: 'call_r3', name: 'screenshot', input: {} },
        ],
      },
    ]
    // Default — no options object (matches every existing call site that
    // doesn't opt in). Must NOT include reasoning_content.
    const out = messagesToOpenAI(messages)
    expect(out).toHaveLength(1)
    const m = out[0]! as { role: string; tool_calls?: unknown[]; reasoning_content?: string }
    expect(m.role).toBe('assistant')
    expect(m.tool_calls).toHaveLength(1)
    expect(m.reasoning_content).toBeUndefined()

    // Same when explicitly false.
    const outExplicit = messagesToOpenAI(messages, undefined, {
      roundTripReasoningContent: false,
    })
    const mExplicit = outExplicit[0]! as { reasoning_content?: string }
    expect(mExplicit.reasoning_content).toBeUndefined()
  })

  it('flag on + assistant without thinking blocks: no reasoning_content field', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_r4', name: 'screenshot', input: {} }],
      },
    ]
    const out = messagesToOpenAI(messages, undefined, {
      roundTripReasoningContent: true,
    })
    const m = out[0]! as { reasoning_content?: string }
    expect(m.reasoning_content).toBeUndefined()
  })
})
