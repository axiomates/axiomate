/**
 * Tests for the rewind picker's view-layer filter chain.
 *
 * Pin two properties downstream code depends on:
 *   1. Filter passes through the SAME object references that exist
 *      in the input `messages` array (no cloning, no mapping).
 *   2. Filter preserves relative order.
 *
 * Plus the `getMessageText` helper.
 *
 * After Phase 1 (disk-as-source migration) the picker filter is
 *   visibleSelectable = allSelectable.filter(m => anchorByMsgId.has(m.uuid))
 * where `anchorByMsgId` is built from `listCodeAnchors`. The state-keyed
 * `fileHistoryHasExactSnapshot` predicate is gone — the equivalent test
 * is "does this UUID appear in the anchor map?". Tests below use a Set
 * to model that map locally.
 */
import { describe, expect, test } from 'vitest'
import {
  getMessageText,
  selectableUserMessagesFilter,
} from '../../../components/MessageSelector.js'
import { createUserMessage } from '../../../utils/messages.js'
import type { Message, UserMessage } from '../../../types/message.js'
import type { UUID } from 'crypto'

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
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: '' },
        },
      ],
    }) as UserMessage
    expect(getMessageText(m)).toBe('')
  })
})

describe('view-layer filter invariants', () => {
  // Reproduces the filter chain inside MessageSelector:
  //   1. messages.filter(selectableUserMessagesFilter)
  //   2. anchors-only:   result.filter(m => anchorByMsgId.has(m.uuid))
  //   3. all-turns (Tab): result (no further filter)

  test('filter chain preserves object identity end-to-end', () => {
    const a = userMsg('hello')
    const b = userMsg('readonly question')
    const c = userMsg('edit seed.txt to v2')
    const messages: Message[] = [a, b, c]
    const anchorIds = new Set<UUID>([c.uuid])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m => anchorIds.has(m.uuid))

    // Each survivor is the SAME OBJECT as the source — guards
    // rewindConversationTo's `messages.lastIndexOf(message)` lookup.
    expect(allSelectable[0]).toBe(a)
    expect(allSelectable[1]).toBe(b)
    expect(allSelectable[2]).toBe(c)
    expect(anchorsOnly).toHaveLength(1)
    expect(anchorsOnly[0]).toBe(c)
  })

  test('default (anchors-only) excludes turns with no anchor', () => {
    const a = userMsg('first prompt')
    const b = userMsg('readonly chat')
    const c = userMsg('edit one')
    const d = userMsg('another readonly')
    const e = userMsg('edit two')
    const messages: Message[] = [a, b, c, d, e]
    const anchorIds = new Set<UUID>([c.uuid, e.uuid])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m => anchorIds.has(m.uuid))

    expect(anchorsOnly.map(m => m.uuid)).toEqual([c.uuid, e.uuid])
  })

  test('all-turns view restores hidden entries at original positions', () => {
    const a = userMsg('first')
    const b = userMsg('readonly')
    const c = userMsg('edit')
    const messages: Message[] = [a, b, c]
    const anchorIds = new Set<UUID>([c.uuid])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m => anchorIds.has(m.uuid))

    expect(allSelectable.map(m => m.uuid)).toEqual([a.uuid, b.uuid, c.uuid])
    expect(anchorsOnly.map(m => m.uuid)).toEqual([c.uuid])
  })

  test('hiddenCount math: allSelectable.length - anchorsOnly.length', () => {
    const a = userMsg('one')
    const b = userMsg('two readonly')
    const c = userMsg('three readonly')
    const d = userMsg('four edit')
    const messages: Message[] = [a, b, c, d]
    const anchorIds = new Set<UUID>([d.uuid])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m => anchorIds.has(m.uuid))
    const hiddenCount = allSelectable.length - anchorsOnly.length

    expect(hiddenCount).toBe(3)
  })

  test('degenerate: empty anchors leaves anchors-only view empty', () => {
    // Picker has a `!hasAnySnapshot` short-circuit: when this happens,
    // it falls back to the all-turns view so a fresh session with no
    // edits is still usable for conversation-only rewind.
    const a = userMsg('first')
    const b = userMsg('second')
    const messages: Message[] = [a, b]
    const anchorIds = new Set<UUID>()

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m => anchorIds.has(m.uuid))

    expect(allSelectable).toHaveLength(2)
    expect(anchorsOnly).toHaveLength(0)
  })
})
