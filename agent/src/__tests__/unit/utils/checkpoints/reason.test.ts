import { describe, expect, test } from 'vitest'
import {
  classifyAnchor,
  formatAnchorReason,
  formatCommitBody,
  formatCommitSubject,
  parseCommitBody,
  parseCommitSubject,
  type ParsedReason,
} from '../../../../utils/checkpoints/reason.js'

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

  test('foreign-store subject (e.g. Hermes default reason) → kind: raw', () => {
    // `auto` is Hermes' default reason. If a Hermes shadow store ever
    // gets imported, we must not parse those subjects as axiomate.
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

describe('formatCommitBody / parseCommitBody', () => {
  test('round-trips a prompt body', () => {
    const body = formatCommitBody({ kind: 'prompt', preview: '创建 test.txt' })
    expect(body).toBe('prompt: 创建 test.txt')
    const parsed = parseCommitBody(body)
    expect(parsed.kind).toBe('prompt')
    if (parsed.kind === 'prompt') expect(parsed.preview).toBe('创建 test.txt')
  })

  test('round-trips a target body', () => {
    const body = formatCommitBody({ kind: 'target', preview: 'undo this' })
    expect(body).toBe('target: undo this')
    const parsed = parseCommitBody(body)
    expect(parsed.kind).toBe('target')
    if (parsed.kind === 'target') expect(parsed.preview).toBe('undo this')
  })

  test('truncates preview to 80 chars', () => {
    const long = 'x'.repeat(120)
    const body = formatCommitBody({ kind: 'prompt', preview: long })
    expect(body.length).toBeLessThanOrEqual('prompt: '.length + 80)
  })

  test('strips newlines from preview', () => {
    const body = formatCommitBody({ kind: 'prompt', preview: 'a\nb\rc' })
    expect(body).toBe('prompt: a b c')
  })

  test('empty preview returns empty string', () => {
    expect(formatCommitBody({ kind: 'prompt', preview: '' })).toBe('')
    expect(formatCommitBody({ kind: 'prompt', preview: '   ' })).toBe('')
  })

  test('unknown kind returns empty string', () => {
    expect(formatCommitBody({ kind: 'unknown' })).toBe('')
  })

  test('parser falls back to unknown on legacy / no-prefix bodies', () => {
    const parsed = parseCommitBody('legacy free-form text')
    expect(parsed.kind).toBe('unknown')
    if (parsed.kind === 'unknown') expect(parsed.raw).toBe('legacy free-form text')
  })

  test('parser handles empty body', () => {
    const parsed = parseCommitBody('')
    expect(parsed.kind).toBe('unknown')
    if (parsed.kind === 'unknown') expect(parsed.raw).toBe('')
  })
})

describe('classifyAnchor', () => {
  test('detects pre-rewind label prefix', () => {
    const subject = formatCommitSubject({
      messageId: 'abcd',
      label: 'pre-rewind:01234567',
    })
    expect(classifyAnchor(subject)).toBe('pre-rewind')
  })

  test('plain turn anchors classify as turn', () => {
    const subject = formatCommitSubject({
      messageId: 'abcd',
      label: 'file-history',
    })
    expect(classifyAnchor(subject)).toBe('turn')
  })

  test('non-axiomate subjects classify as foreign', () => {
    expect(classifyAnchor('manual git commit message')).toBe('foreign')
    expect(classifyAnchor('')).toBe('foreign')
  })
})

describe('formatAnchorReason', () => {
  test('turn anchor with prompt body shows preview with Before prefix', () => {
    // Hermes-aligned: every anchor is a pre-tool snapshot, so the
    // formatted label declares its "before" semantics. Prompt preview
    // is the user-readable identifier — strip the internal label
    // ('file-history') and message UUID, both of which are
    // debug-grade noise.
    const subj = formatCommitSubject({ messageId: 'abc12345xyz', label: 'file-history' })
    const body = formatCommitBody({ kind: 'prompt', preview: '创建 test.txt' })
    expect(formatAnchorReason(subj, body)).toBe('Before "创建 test.txt"')
  })

  test('turn anchor without body falls back to Before <label> (msgid)', () => {
    const subj = formatCommitSubject({ messageId: 'abc12345xyz', label: 'file-history' })
    expect(formatAnchorReason(subj, '')).toBe('Before file-history (abc12345)')
  })

  test('pre-rewind with target body uses "Undo rewind to before"', () => {
    const subj = formatCommitSubject({ messageId: 'abc12345xyz', label: 'pre-rewind:01234567' })
    const body = formatCommitBody({ kind: 'target', preview: '创建 v1' })
    expect(formatAnchorReason(subj, body)).toBe('Undo rewind to before "创建 v1"')
  })

  test('pre-rewind without target body', () => {
    const subj = formatCommitSubject({ messageId: 'abc12345xyz', label: 'pre-rewind:01234567' })
    expect(formatAnchorReason(subj, '')).toBe('Undo last rewind')
  })

  test('foreign subject returns subject as-is', () => {
    expect(formatAnchorReason('manual commit', '')).toBe('manual commit')
    expect(formatAnchorReason('', '')).toBe('(no subject)')
  })
})
