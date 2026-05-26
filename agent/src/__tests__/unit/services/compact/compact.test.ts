import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'

import type { Message, UserMessage } from '../../../../types/message.js'
import {
  extractPreviousCompactSummary,
  extractSummaryContentFromUserMessage,
  filterPreviousSummaryForIterativeCompact,
} from '../../../../services/compact/iterativeCompact.js'
import {
  COMPACT_SUMMARY_PREAMBLE,
  COMPACT_SUMMARY_RECENT_TRAILER,
  COMPACT_SUMMARY_SUPPRESS_TRAILER,
  COMPACT_SUMMARY_TRANSCRIPT_TRAILER_PREFIX,
  getCompactPrompt,
  getCompactUserSummaryMessage,
  ITERATIVE_COMPACT_PREVIOUS_SUMMARY_PLACEHOLDER,
} from '../../../../services/compact/prompt.js'

// ---------------------------------------------------------------------------
// Fixture helpers — build Messages directly to avoid importing messages.ts /
// createUserMessage (which pulls in the tool-registry transitive chain with a
// CommonJS require that vitest can't resolve).
// ---------------------------------------------------------------------------

function makeBoundary(): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger: 'manual',
      preTokens: 50_000,
    },
  } as unknown as Message
}

function makeUserMessage(content: string, flags: Partial<UserMessage> = {}): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
    ...flags,
  } as unknown as UserMessage
}

function makeCompactSummary(
  summaryBody: string,
  opts: {
    suppressFollowUpQuestions?: boolean
    transcriptPath?: string
    recentMessagesPreserved?: boolean
  } = {},
): UserMessage {
  // getCompactUserSummaryMessage runs its argument through formatCompactSummary,
  // which looks for <summary>...</summary> tags and rewrites them to
  // "Summary:\n..." prefix. Pass a wrapped body so the output matches what
  // production actually stores.
  const wrapped = `<summary>${summaryBody}</summary>`
  const content = getCompactUserSummaryMessage(
    wrapped,
    opts.suppressFollowUpQuestions,
    opts.transcriptPath,
    opts.recentMessagesPreserved,
  )
  return makeUserMessage(content, {
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  })
}

function makeRegularUser(content: string): UserMessage {
  return makeUserMessage(content)
}

// ---------------------------------------------------------------------------
// extractSummaryContentFromUserMessage
// ---------------------------------------------------------------------------

describe('extractSummaryContentFromUserMessage', () => {
  it('strips the preamble and transcript trailer, returning the Summary body', () => {
    const msg = makeCompactSummary('1. Primary Request:\n   Fix the bug', {
      transcriptPath: '/tmp/abc.jsonl',
    })
    const body = extractSummaryContentFromUserMessage(msg)
    expect(body).not.toBeNull()
    expect(body).not.toContain(COMPACT_SUMMARY_PREAMBLE)
    expect(body).not.toContain(
      COMPACT_SUMMARY_TRANSCRIPT_TRAILER_PREFIX,
    )
    expect(body).toContain('1. Primary Request')
    expect(body).toContain('Fix the bug')
  })

  it('strips the "Recent messages preserved" trailer', () => {
    const msg = makeCompactSummary('body', { recentMessagesPreserved: true })
    const body = extractSummaryContentFromUserMessage(msg)
    expect(body).not.toBeNull()
    expect(body).not.toContain(COMPACT_SUMMARY_RECENT_TRAILER)
    expect(body).toContain('body')
  })

  it('strips the suppressFollowUpQuestions trailer', () => {
    const msg = makeCompactSummary('body', { suppressFollowUpQuestions: true })
    const body = extractSummaryContentFromUserMessage(msg)
    expect(body).not.toBeNull()
    expect(body).not.toContain(COMPACT_SUMMARY_SUPPRESS_TRAILER)
    expect(body).toContain('body')
  })

  it('returns null for empty content', () => {
    const msg = makeUserMessage('')
    expect(extractSummaryContentFromUserMessage(msg)).toBeNull()
  })

  it('falls back to whole-content strip when Summary: prefix is missing', () => {
    const msg = makeUserMessage(
      `${COMPACT_SUMMARY_PREAMBLE}\n\nno summary prefix here`,
    )
    const body = extractSummaryContentFromUserMessage(msg)
    expect(body).toBe('no summary prefix here')
  })
})

// ---------------------------------------------------------------------------
// extractPreviousCompactSummary
// ---------------------------------------------------------------------------

describe('extractPreviousCompactSummary', () => {
  it('returns null on empty history', () => {
    expect(extractPreviousCompactSummary([])).toBeNull()
  })

  it('returns null when no boundary marker present', () => {
    const messages: Message[] = [makeRegularUser('hi'), makeRegularUser('hello')]
    expect(extractPreviousCompactSummary(messages)).toBeNull()
  })

  it('returns null when boundary exists but no isCompactSummary follows', () => {
    const messages: Message[] = [
      makeRegularUser('old'),
      makeBoundary(),
      makeRegularUser('new — but no compact summary'),
    ]
    expect(extractPreviousCompactSummary(messages)).toBeNull()
  })

  it('extracts summary text from the standard boundary → summary layout', () => {
    const summary = makeCompactSummary('1. Primary Request:\n   test goal')
    const messages: Message[] = [
      makeRegularUser('first user turn'),
      makeBoundary(),
      summary,
      makeRegularUser('new turn after compact'),
    ]
    const result = extractPreviousCompactSummary(messages)
    expect(result).not.toBeNull()
    expect(result!.summaryText).toContain('1. Primary Request')
    expect(result!.summaryText).toContain('test goal')
    expect(result!.summaryMessageUuid).toBe(summary.uuid)
  })

  it('picks the summary after the most recent boundary (multi-compact session)', () => {
    const firstSummary = makeCompactSummary('first summary body')
    const secondSummary = makeCompactSummary('second summary body')
    const messages: Message[] = [
      makeBoundary(),
      firstSummary,
      makeRegularUser('turns between compacts'),
      makeBoundary(),
      secondSummary,
      makeRegularUser('newest turn'),
    ]
    const result = extractPreviousCompactSummary(messages)
    expect(result).not.toBeNull()
    expect(result!.summaryText).toContain('second summary body')
    expect(result!.summaryMessageUuid).toBe(secondSummary.uuid)
  })

  it('scans past non-summary messages between boundary and summary', () => {
    const summary = makeCompactSummary('body')
    // Simulate an edge case where an attachment / hook message got placed
    // between boundary and summary. The scan should still find the summary.
    const stray = makeRegularUser('stray attachment-ish user msg')
    const messages: Message[] = [makeBoundary(), stray, summary]
    const result = extractPreviousCompactSummary(messages)
    expect(result).not.toBeNull()
    expect(result!.summaryMessageUuid).toBe(summary.uuid)
  })
})

// ---------------------------------------------------------------------------
// filterPreviousSummaryForIterativeCompact
// ---------------------------------------------------------------------------

describe('filterPreviousSummaryForIterativeCompact', () => {
  it('removes only the message with the given uuid', () => {
    const keep1 = makeRegularUser('keep 1')
    const target = makeRegularUser('drop me')
    const keep2 = makeRegularUser('keep 2')
    const result = filterPreviousSummaryForIterativeCompact(
      [keep1, target, keep2],
      target.uuid,
    )
    expect(result).toHaveLength(2)
    expect(result.map(m => m.uuid)).toEqual([keep1.uuid, keep2.uuid])
  })

  it('is a no-op when uuid does not match anything', () => {
    const keep1 = makeRegularUser('a')
    const keep2 = makeRegularUser('b')
    const fakeUuid = '00000000-0000-0000-0000-000000000000' as const
    const result = filterPreviousSummaryForIterativeCompact(
      [keep1, keep2],
      fakeUuid as never,
    )
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// getCompactPrompt — iterative branch
// ---------------------------------------------------------------------------

describe('getCompactPrompt', () => {
  it('with no previousSummary: uses the base prompt (no "UPDATE an existing")', () => {
    const prompt = getCompactPrompt()
    expect(prompt).toContain('create a detailed summary of the conversation')
    expect(prompt).not.toContain('UPDATE an existing context compaction summary')
    expect(prompt).not.toContain('PREVIOUS SUMMARY:')
  })

  it('with previousSummary: switches to iterative variant and injects the text', () => {
    const prev = 'the prior summary body with 9 sections'
    const prompt = getCompactPrompt(undefined, prev)
    expect(prompt).toContain('UPDATE an existing context compaction summary')
    expect(prompt).toContain('PREVIOUS SUMMARY:')
    expect(prompt).toContain(prev)
    expect(prompt).not.toContain(
      ITERATIVE_COMPACT_PREVIOUS_SUMMARY_PLACEHOLDER,
    )
    // Base prompt should not appear
    expect(prompt).not.toContain('create a detailed summary of the conversation')
  })

  it('iterative prompt contains all 9 field-migration rules', () => {
    const prompt = getCompactPrompt(undefined, 'any')
    // Spot-check the most distinctive per-field phrases
    expect(prompt).toContain('Primary Request and Intent — PRESERVE')
    expect(prompt).toContain('Key Technical Concepts — APPEND')
    expect(prompt).toContain('Files and Code Sections — APPEND')
    expect(prompt).toContain('Errors and fixes — APPEND')
    expect(prompt).toContain('Problem Solving — APPEND')
    expect(prompt).toContain('All user messages — APPEND')
    expect(prompt).toContain('Pending Tasks')
    expect(prompt).toContain('Completed This Session')
    expect(prompt).toContain('Current Work — REPLACE')
    expect(prompt).toContain('Optional Next Step — REPLACE')
  })

  it('iterative prompt contains the CRITICAL marker for load-bearing fields', () => {
    const prompt = getCompactPrompt(undefined, 'x')
    expect(prompt).toContain('CRITICAL')
    expect(prompt).toContain('Pending Tasks')
    expect(prompt).toContain('Current Work')
  })

  it('with previousSummary AND customInstructions: both appear', () => {
    const prompt = getCompactPrompt('focus on tests', 'prior body')
    expect(prompt).toContain('UPDATE an existing')
    expect(prompt).toContain('prior body')
    expect(prompt).toContain('Additional Instructions:')
    expect(prompt).toContain('focus on tests')
  })

  it('treats whitespace-only previousSummary as no previousSummary', () => {
    const prompt = getCompactPrompt(undefined, '   \n\t  ')
    expect(prompt).not.toContain('UPDATE an existing context compaction summary')
    expect(prompt).toContain('create a detailed summary of the conversation')
  })
})
