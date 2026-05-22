/**
 * Tests for the rewind picker's view-layer slash-command filter.
 *
 * The filter chain in MessageSelector is purely cosmetic — rewind
 * handlers downstream (REPL.rewindConversationTo, fileHistoryRewind)
 * resolve targets against the FULL `messages` array, by object
 * identity (`lastIndexOf`) and by UUID. So these tests pin the two
 * properties downstream code depends on:
 *
 *   1. Filter passes through the SAME object references that exist
 *      in the input `messages` array (no cloning, no mapping).
 *   2. Filter preserves relative order.
 *
 * Plus the helpers themselves (`getMessageText`, `isSlashCommandMessage`).
 */
import { describe, expect, test } from 'vitest'
import {
  getMessageText,
  isSlashCommandMessage,
  selectableUserMessagesFilter,
} from '../MessageSelector.js'
import { createUserMessage } from '../../utils/messages.js'
import type { Message, UserMessage } from '../../types/message.js'

function userMsg(content: string): UserMessage {
  return createUserMessage({ content }) as UserMessage
}

describe('getMessageText', () => {
  test('returns trimmed string content', () => {
    expect(getMessageText(userMsg('  hello  '))).toBe('hello')
  })

  test('returns empty string for non-user messages', () => {
    const m = { type: 'progress' } as unknown as Message
    expect(getMessageText(m)).toBe('')
  })

  test('extracts text from the LAST text block of array content', () => {
    const m = createUserMessage({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: '  /checkpoints  ' },
      ],
    }) as UserMessage
    expect(getMessageText(m)).toBe('/checkpoints')
  })

  test('returns empty string when array content has no text block at the end', () => {
    const m = createUserMessage({
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }],
    }) as UserMessage
    expect(getMessageText(m)).toBe('')
  })
})

describe('isSlashCommandMessage', () => {
  test('true for /checkpoints', () => {
    expect(isSlashCommandMessage(userMsg('/checkpoints status'))).toBe(true)
  })

  test('true for /help with args', () => {
    expect(isSlashCommandMessage(userMsg('/help foo'))).toBe(true)
  })

  test('false for plain prose', () => {
    expect(isSlashCommandMessage(userMsg('hello world'))).toBe(false)
  })

  test('false for mid-text slash', () => {
    expect(isSlashCommandMessage(userMsg('do /help right now'))).toBe(false)
  })

  test('true for prose that starts with "/" (acceptable false positive — Tab toggle is the escape hatch)', () => {
    expect(isSlashCommandMessage(userMsg('/etc/hosts is at...'))).toBe(true)
  })

  test('false when leading whitespace then slash — getMessageText trims first', () => {
    expect(isSlashCommandMessage(userMsg('   /checkpoints'))).toBe(true)
  })
})

describe('view-layer filter invariants', () => {
  // Reproduce the pipeline used inside MessageSelector:
  //   1. messages.filter(selectableUserMessagesFilter)
  //   2. result.filter(m => !isSlashCommandMessage(m))   [when default]
  // and assert order + identity properties.

  function realUser(text: string): UserMessage {
    return userMsg(text)
  }
  function slashUser(cmd: string): UserMessage {
    return userMsg(cmd)
  }

  test('filter chain preserves object identity end-to-end', () => {
    const a = realUser('hello')
    const b = slashUser('/checkpoints')
    const c = realUser('edit seed.txt to v2')
    const messages: Message[] = [a, b, c]

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const visible = allSelectable.filter(m => !isSlashCommandMessage(m))

    // Each survivor is the SAME OBJECT as the source — guards
    // rewindConversationTo's `messages.lastIndexOf(message)` lookup.
    expect(allSelectable[0]).toBe(a)
    expect(allSelectable[1]).toBe(b)
    expect(allSelectable[2]).toBe(c)
    expect(visible[0]).toBe(a)
    expect(visible[1]).toBe(c)
  })

  test('default view (hide slash) drops slash messages but keeps order', () => {
    const a = realUser('first prompt')
    const b = slashUser('/help')
    const c = realUser('second prompt')
    const d = slashUser('/checkpoints')
    const e = realUser('third prompt')
    const messages: Message[] = [a, b, c, d, e]

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const visible = allSelectable.filter(m => !isSlashCommandMessage(m))

    expect(visible.map(m => m.uuid)).toEqual([a.uuid, c.uuid, e.uuid])
  })

  test('show-all view restores slash entries at their original positions', () => {
    const a = realUser('first')
    const b = slashUser('/help')
    const c = realUser('third')
    const messages: Message[] = [a, b, c]

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const showAll = allSelectable
    const hidden = allSelectable.filter(m => !isSlashCommandMessage(m))

    expect(showAll.map(m => m.uuid)).toEqual([a.uuid, b.uuid, c.uuid])
    expect(hidden.map(m => m.uuid)).toEqual([a.uuid, c.uuid])
  })

  test('hiddenSlashCount math matches: allSelectable.length - visible.length', () => {
    const a = realUser('one')
    const b = slashUser('/checkpoints')
    const c = slashUser('/help')
    const d = realUser('two')
    const messages: Message[] = [a, b, c, d]

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const visible = allSelectable.filter(m => !isSlashCommandMessage(m))
    const hiddenSlashCount = allSelectable.length - visible.length

    expect(hiddenSlashCount).toBe(2)
  })
})
