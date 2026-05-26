/**
 * Slash-command parsers for `/checkpoints` — surface-only unit tests.
 *
 * `parseSub` and `parsePositionalRows` are exposed via `_internal` so
 * they can be exercised without spinning up the React side of `call()`.
 * The two parsers together define the dispatch contract for every
 * `/checkpoints ...` invocation, so coverage here is the cheap
 * front-line guard against regressions in the slash CLI.
 */

import { describe, expect, test } from 'vitest'
import { _internal } from '../../../../commands/checkpoints/checkpoints.js'

const { parseSub, parsePositionalRows, parsePruneFlags } = _internal

describe('parseSub', () => {
  test('empty arg → status with empty rest', () => {
    expect(parseSub('')).toEqual({ sub: 'status', rest: '' })
  })

  test('whitespace-only arg → status', () => {
    expect(parseSub('   ')).toEqual({ sub: 'status', rest: '' })
  })

  test('list, prune, clear are recognized', () => {
    expect(parseSub('list')).toMatchObject({ sub: 'list' })
    expect(parseSub('prune force')).toMatchObject({
      sub: 'prune',
      rest: 'force',
    })
    expect(parseSub('clear')).toMatchObject({ sub: 'clear' })
  })

  test('unknown subcommand → error message', () => {
    const r = parseSub('frobnicate')
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toMatch(/Unknown subcommand/)
      expect(r.error).toMatch(/status, list, prune, clear/)
    }
  })
})

describe('parsePositionalRows', () => {
  test('absent → empty result', () => {
    expect(parsePositionalRows([])).toEqual({})
  })

  test('positional integer → rows', () => {
    expect(parsePositionalRows(['50'])).toEqual({ rows: 50 })
    expect(parsePositionalRows(['7'])).toEqual({ rows: 7 })
  })

  test('non-numeric value → error', () => {
    const r = parsePositionalRows(['abc'])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/Invalid row count/)
  })

  test('non-integer value → error', () => {
    const r = parsePositionalRows(['20.5'])
    expect('error' in r).toBe(true)
  })

  test('out-of-range low → error', () => {
    expect('error' in parsePositionalRows(['0'])).toBe(true)
  })

  test('out-of-range high → error', () => {
    expect('error' in parsePositionalRows(['99999'])).toBe(true)
  })

  test('exact bounds accepted (1, 500)', () => {
    expect(parsePositionalRows(['1'])).toEqual({ rows: 1 })
    expect(parsePositionalRows(['500'])).toEqual({ rows: 500 })
  })

  test('extra tokens → error', () => {
    const r = parsePositionalRows(['50', 'extra'])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/extra arguments/)
  })

  test('--rows flag is no longer recognized → error', () => {
    // Slash command is positional-only; --rows lives on the CLI side.
    const r = parsePositionalRows(['--rows', '50'])
    expect('error' in r).toBe(true)
  })
})

describe('parsePruneFlags', () => {
  test('empty tokens → both false', () => {
    expect(parsePruneFlags([])).toEqual({ force: false, keepOrphans: false })
  })

  test('force subword only', () => {
    expect(parsePruneFlags(['force'])).toEqual({
      force: true,
      keepOrphans: false,
    })
  })

  test('keep-orphans subword only', () => {
    expect(parsePruneFlags(['keep-orphans'])).toEqual({
      force: false,
      keepOrphans: true,
    })
  })

  test('both subwords together (any order)', () => {
    expect(parsePruneFlags(['force', 'keep-orphans'])).toEqual({
      force: true,
      keepOrphans: true,
    })
    expect(parsePruneFlags(['keep-orphans', 'force'])).toEqual({
      force: true,
      keepOrphans: true,
    })
  })

  test('typo subword → error', () => {
    const r = parsePruneFlags(['frce'])
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toMatch(/Unknown argument/)
      expect(r.error).toMatch(/frce/)
    }
  })

  test('--force POSIX-style flag is rejected (slash convention has no --)', () => {
    // CLI side keeps --force; slash side does not.
    const r = parsePruneFlags(['--force'])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/Unknown argument/)
  })

  test('--keep-orphans POSIX-style flag is rejected', () => {
    const r = parsePruneFlags(['--keep-orphans'])
    expect('error' in r).toBe(true)
  })

  test('-f short alias is no longer recognized', () => {
    const r = parsePruneFlags(['-f'])
    expect('error' in r).toBe(true)
  })

  test('unknown subword mixed with valid → error', () => {
    const r = parsePruneFlags(['force', 'bogus'])
    expect('error' in r).toBe(true)
  })

  test('empty-string tokens skipped (defensive against split artifacts)', () => {
    expect(parsePruneFlags(['', 'force', ''])).toEqual({
      force: true,
      keepOrphans: false,
    })
  })
})
