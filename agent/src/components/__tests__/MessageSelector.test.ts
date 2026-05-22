/**
 * Tests for the rewind picker's view-layer filter chain.
 *
 * The filter is purely cosmetic — rewind handlers downstream
 * (REPL.rewindConversationTo, fileHistoryRewind) resolve targets
 * against the FULL `messages` array, by object identity (`lastIndexOf`)
 * and by UUID. So these tests pin the two properties downstream code
 * depends on:
 *
 *   1. Filter passes through the SAME object references that exist
 *      in the input `messages` array (no cloning, no mapping).
 *   2. Filter preserves relative order.
 *
 * Plus the `getMessageText` helper.
 *
 * The picker has two views:
 *   - default: only turns where the AI ran an Edit/Write/NotebookEdit
 *     (a snapshot exists keyed to that UUID).
 *   - all-turns (Tab): every selectable user turn, for conversation-
 *     only rewind to a non-edit anchor.
 */
import { describe, expect, test } from 'vitest'
import {
  getMessageText,
  selectableUserMessagesFilter,
} from '../MessageSelector.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  fileHistoryHasExactSnapshot,
  type FileHistoryState,
  type FileHistorySnapshot,
} from '../../utils/fileHistory.js'
import type { Message, UserMessage } from '../../types/message.js'
import type { UUID } from 'crypto'

function userMsg(content: string): UserMessage {
  return createUserMessage({ content }) as UserMessage
}

function fakeSnapshot(messageId: UUID): FileHistorySnapshot {
  return {
    messageId,
    gitHash: 'deadbeef',
    addedTrackedFiles: [],
    timestamp: new Date(0),
  }
}

function fakeState(messageIds: UUID[]): FileHistoryState {
  return {
    snapshots: messageIds.map(fakeSnapshot),
    trackedFiles: new Set(),
    snapshotSequence: messageIds.length,
  }
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

describe('fileHistoryHasExactSnapshot', () => {
  test('true only on exact UUID match — no ancestor walk', () => {
    const a = userMsg('a')
    const b = userMsg('b')
    const c = userMsg('c')
    // Snapshot exists for a and c only; b is a readonly turn between them.
    const state = fakeState([a.uuid, c.uuid])

    expect(fileHistoryHasExactSnapshot(state, a.uuid)).toBe(true)
    expect(fileHistoryHasExactSnapshot(state, c.uuid)).toBe(true)
    // b has an ancestor snapshot at a — but the strict predicate must NOT
    // claim b is itself a code-restore anchor. (Guards against
    // `fileHistoryCanRestore` semantics leaking in.)
    expect(fileHistoryHasExactSnapshot(state, b.uuid)).toBe(false)
  })

  test('false for unknown UUID', () => {
    const a = userMsg('a')
    const state = fakeState([a.uuid])
    const ghost = userMsg('ghost')
    expect(fileHistoryHasExactSnapshot(state, ghost.uuid)).toBe(false)
  })

  test('false when snapshots is empty', () => {
    const a = userMsg('a')
    const state = fakeState([])
    expect(fileHistoryHasExactSnapshot(state, a.uuid)).toBe(false)
  })
})

describe('view-layer filter invariants', () => {
  // Reproduce the filter chain inside MessageSelector:
  //   1. messages.filter(selectableUserMessagesFilter)
  //   2. anchors-only:    result.filter(m => fileHistoryHasExactSnapshot(state, m.uuid))
  //   3. all-turns (Tab): result (no further filter)

  test('filter chain preserves object identity end-to-end', () => {
    const a = userMsg('hello')
    const b = userMsg('readonly question')
    const c = userMsg('edit seed.txt to v2')
    const messages: Message[] = [a, b, c]
    // Only c is an edit anchor.
    const state = fakeState([c.uuid])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m =>
      fileHistoryHasExactSnapshot(state, m.uuid),
    )

    // Each survivor is the SAME OBJECT as the source — guards
    // rewindConversationTo's `messages.lastIndexOf(message)` lookup.
    expect(allSelectable[0]).toBe(a)
    expect(allSelectable[1]).toBe(b)
    expect(allSelectable[2]).toBe(c)
    expect(anchorsOnly).toHaveLength(1)
    expect(anchorsOnly[0]).toBe(c)
  })

  test('default (anchors-only) excludes turns with no exact snapshot', () => {
    const a = userMsg('first prompt')
    const b = userMsg('readonly chat')
    const c = userMsg('edit one')
    const d = userMsg('another readonly')
    const e = userMsg('edit two')
    const messages: Message[] = [a, b, c, d, e]
    const state = fakeState([c.uuid, e.uuid])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m =>
      fileHistoryHasExactSnapshot(state, m.uuid),
    )

    expect(anchorsOnly.map(m => m.uuid)).toEqual([c.uuid, e.uuid])
  })

  test('all-turns view restores hidden entries at original positions', () => {
    const a = userMsg('first')
    const b = userMsg('readonly')
    const c = userMsg('edit')
    const messages: Message[] = [a, b, c]
    const state = fakeState([c.uuid])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m =>
      fileHistoryHasExactSnapshot(state, m.uuid),
    )

    expect(allSelectable.map(m => m.uuid)).toEqual([a.uuid, b.uuid, c.uuid])
    expect(anchorsOnly.map(m => m.uuid)).toEqual([c.uuid])
  })

  test('hiddenCount math: allSelectable.length - anchorsOnly.length', () => {
    const a = userMsg('one')
    const b = userMsg('two readonly')
    const c = userMsg('three readonly')
    const d = userMsg('four edit')
    const messages: Message[] = [a, b, c, d]
    const state = fakeState([d.uuid])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m =>
      fileHistoryHasExactSnapshot(state, m.uuid),
    )
    const hiddenCount = allSelectable.length - anchorsOnly.length

    expect(hiddenCount).toBe(3)
  })

  test('degenerate: empty snapshots leaves anchors-only view empty', () => {
    // Documents the picker's `!hasAnySnapshot` short-circuit:
    // when this happens, the picker falls back to the all-turns view
    // so a fresh session with no edits is still usable for
    // conversation-only rewind.
    const a = userMsg('first')
    const b = userMsg('second')
    const messages: Message[] = [a, b]
    const state = fakeState([])

    const allSelectable = messages.filter(selectableUserMessagesFilter)
    const anchorsOnly = allSelectable.filter(m =>
      fileHistoryHasExactSnapshot(state, m.uuid),
    )

    expect(allSelectable).toHaveLength(2)
    expect(anchorsOnly).toHaveLength(0)
  })
})
