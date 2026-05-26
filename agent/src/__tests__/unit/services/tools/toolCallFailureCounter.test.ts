import { describe, expect, it } from 'vitest'

import type { Message } from '../../../../types/message.js'
import { countConsecutiveInputValidationFailures } from '../../../../services/tools/toolCallFailureCounter.js'

/**
 * Thin fixture helpers. We only feed the counter — the Message fields not
 * directly read (uuid, timestamp, etc.) are filled with dummy values via
 * a cast, which is fine for this unit test.
 */
function assistantWithToolUse(id: string, toolName: string): Message {
  return {
    type: 'assistant',
    message: {
      id: `msg_${id}`,
      role: 'assistant',
      model: 'claude-test',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'tool_use', id, name: toolName, input: {} }],
    },
  } as unknown as Message
}

function userToolResult(
  toolUseId: string,
  content: string,
  isError: boolean,
): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  } as unknown as Message
}

describe('countConsecutiveInputValidationFailures', () => {
  it('returns 0 for empty history', () => {
    expect(countConsecutiveInputValidationFailures([], 'Read')).toBe(0)
  })

  it('returns 0 when the tool has no prior calls', () => {
    const messages: Message[] = [
      assistantWithToolUse('u1', 'Bash'),
      userToolResult('u1', 'ok', false),
    ]
    expect(countConsecutiveInputValidationFailures(messages, 'Read')).toBe(0)
  })

  it('returns 1 after a single InputValidationError for the tool', () => {
    const messages: Message[] = [
      assistantWithToolUse('u1', 'Read'),
      userToolResult(
        'u1',
        '<tool_use_error>InputValidationError: ...</tool_use_error>',
        true,
      ),
    ]
    expect(countConsecutiveInputValidationFailures(messages, 'Read')).toBe(1)
  })

  it('counts multiple consecutive failures for the same tool', () => {
    const messages: Message[] = [
      assistantWithToolUse('u1', 'Read'),
      userToolResult(
        'u1',
        '<tool_use_error>InputValidationError: first</tool_use_error>',
        true,
      ),
      assistantWithToolUse('u2', 'Read'),
      userToolResult(
        'u2',
        '<tool_use_error>InputValidationError: second</tool_use_error>',
        true,
      ),
      assistantWithToolUse('u3', 'Read'),
      userToolResult(
        'u3',
        '<tool_use_error>InputValidationError: third</tool_use_error>',
        true,
      ),
    ]
    expect(countConsecutiveInputValidationFailures(messages, 'Read')).toBe(3)
  })

  it('resets on a successful call of the same tool', () => {
    const messages: Message[] = [
      assistantWithToolUse('u1', 'Read'),
      userToolResult(
        'u1',
        '<tool_use_error>InputValidationError: ...</tool_use_error>',
        true,
      ),
      assistantWithToolUse('u2', 'Read'),
      userToolResult('u2', 'file contents', false),
    ]
    expect(countConsecutiveInputValidationFailures(messages, 'Read')).toBe(0)
  })

  it('resets on a non-InputValidation error (e.g. runtime error)', () => {
    const messages: Message[] = [
      assistantWithToolUse('u1', 'Read'),
      userToolResult(
        'u1',
        '<tool_use_error>InputValidationError: ...</tool_use_error>',
        true,
      ),
      assistantWithToolUse('u2', 'Read'),
      userToolResult('u2', '<tool_use_error>File not found</tool_use_error>', true),
    ]
    expect(countConsecutiveInputValidationFailures(messages, 'Read')).toBe(0)
  })

  it('does not reset when a different tool has a result in between', () => {
    const messages: Message[] = [
      assistantWithToolUse('u1', 'Read'),
      userToolResult(
        'u1',
        '<tool_use_error>InputValidationError: ...</tool_use_error>',
        true,
      ),
      assistantWithToolUse('u2', 'Bash'),
      userToolResult('u2', 'ok', false),
      assistantWithToolUse('u3', 'Read'),
      userToolResult(
        'u3',
        '<tool_use_error>InputValidationError: ...</tool_use_error>',
        true,
      ),
    ]
    expect(countConsecutiveInputValidationFailures(messages, 'Read')).toBe(2)
  })

  it('tracks each tool independently', () => {
    const messages: Message[] = [
      assistantWithToolUse('a', 'Read'),
      userToolResult(
        'a',
        '<tool_use_error>InputValidationError: read fail</tool_use_error>',
        true,
      ),
      assistantWithToolUse('b', 'Bash'),
      userToolResult(
        'b',
        '<tool_use_error>InputValidationError: bash fail</tool_use_error>',
        true,
      ),
      assistantWithToolUse('c', 'Bash'),
      userToolResult(
        'c',
        '<tool_use_error>InputValidationError: bash fail 2</tool_use_error>',
        true,
      ),
    ]
    expect(countConsecutiveInputValidationFailures(messages, 'Read')).toBe(1)
    expect(countConsecutiveInputValidationFailures(messages, 'Bash')).toBe(2)
  })
})
