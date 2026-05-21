import { describe, expect, test } from 'vitest'
import {
  formatCommitSubject,
  parseCommitSubject,
  type ParsedReason,
} from '../reason.js'

describe('formatCommitSubject', () => {
  test('produces canonical axiomate:<id>:<label> shape', () => {
    expect(formatCommitSubject({ messageId: 'abc123', label: 'edit foo' })).toBe(
      'axiomate:abc123:edit foo',
    )
  })

  test('strips CR/LF from label (commit subjects are single-line)', () => {
    expect(
      formatCommitSubject({ messageId: 'abc', label: 'line1\nline2\r\nline3' }),
    ).toBe('axiomate:abc:line1 line2 line3')
  })

  test('preserves intra-label colons (label is free text)', () => {
    expect(
      formatCommitSubject({ messageId: 'abc', label: 'fix: refactor' }),
    ).toBe('axiomate:abc:fix: refactor')
  })

  test('preserves leading/trailing whitespace in label', () => {
    expect(formatCommitSubject({ messageId: 'a', label: '  hi  ' })).toBe(
      'axiomate:a:  hi  ',
    )
  })

  test('accepts the reserved pre-rollback messageId verbatim', () => {
    expect(
      formatCommitSubject({
        messageId: 'pre-rollback',
        label: 'restoring to a1b2c3d4',
      }),
    ).toBe('axiomate:pre-rollback:restoring to a1b2c3d4')
  })

  test('throws on messageId containing a colon', () => {
    expect(() =>
      formatCommitSubject({ messageId: 'foo:bar', label: 'x' }),
    ).toThrow(/messageId must match/)
  })

  test('throws on messageId containing whitespace', () => {
    expect(() =>
      formatCommitSubject({ messageId: 'foo bar', label: 'x' }),
    ).toThrow(/messageId must match/)
  })

  test('throws on empty messageId', () => {
    expect(() =>
      formatCommitSubject({ messageId: '', label: 'x' }),
    ).toThrow(/messageId must match/)
  })

  test('accepts UUID-like ids (Anthropic message ids)', () => {
    const uuid = 'msg_01HZX9YQK8YVZF7N3M4P5R6S7T'
    expect(formatCommitSubject({ messageId: uuid, label: 'x' })).toBe(
      `axiomate:${uuid}:x`,
    )
  })
})

describe('parseCommitSubject', () => {
  test('parses canonical shape into structured fields', () => {
    expect(parseCommitSubject('axiomate:abc123:edit foo')).toEqual<ParsedReason>(
      { kind: 'axiomate', messageId: 'abc123', label: 'edit foo' },
    )
  })

  test('round-trips cleanly with formatCommitSubject', () => {
    const reason = { messageId: 'msg_42', label: 'tweak src/foo.ts' }
    const formatted = formatCommitSubject(reason)
    const parsed = parseCommitSubject(formatted)
    expect(parsed).toEqual<ParsedReason>({
      kind: 'axiomate',
      messageId: reason.messageId,
      label: reason.label,
    })
  })

  test('round-trips the pre-rollback messageId so consumers can match on it', () => {
    const formatted = formatCommitSubject({
      messageId: 'pre-rollback',
      label: 'restoring to a1b2c3d4',
    })
    const parsed = parseCommitSubject(formatted)
    expect(parsed).toEqual<ParsedReason>({
      kind: 'axiomate',
      messageId: 'pre-rollback',
      label: 'restoring to a1b2c3d4',
    })
  })

  test('label may contain colons after first split', () => {
    expect(parseCommitSubject('axiomate:m1:fix: refactor')).toEqual<ParsedReason>({
      kind: 'axiomate',
      messageId: 'm1',
      label: 'fix: refactor',
    })
  })

  test('empty label is preserved', () => {
    expect(parseCommitSubject('axiomate:m1:')).toEqual<ParsedReason>({
      kind: 'axiomate',
      messageId: 'm1',
      label: '',
    })
  })

  test('non-axiomate prefix → kind: raw', () => {
    expect(parseCommitSubject('initial commit')).toEqual<ParsedReason>({
      kind: 'raw',
      subject: 'initial commit',
    })
  })

  test('Hermes-style legacy subject → kind: raw', () => {
    // `auto` was Hermes' default reason. We must not parse it as axiomate.
    expect(parseCommitSubject('auto')).toEqual<ParsedReason>({
      kind: 'raw',
      subject: 'auto',
    })
  })

  test('subject with axiomate: but invalid messageId → kind: raw', () => {
    // Defense in depth: if some future writer slips a space into the id,
    // the parser should refuse rather than emit a non-roundtrip-able id.
    expect(parseCommitSubject('axiomate:foo bar:label')).toEqual<ParsedReason>({
      kind: 'raw',
      subject: 'axiomate:foo bar:label',
    })
  })

  test('subject missing trailing colon → kind: raw', () => {
    // We require BOTH separators — ambiguity-free parse.
    expect(parseCommitSubject('axiomate:abc')).toEqual<ParsedReason>({
      kind: 'raw',
      subject: 'axiomate:abc',
    })
  })

  test('subject with empty messageId → kind: raw', () => {
    expect(parseCommitSubject('axiomate::label')).toEqual<ParsedReason>({
      kind: 'raw',
      subject: 'axiomate::label',
    })
  })
})
