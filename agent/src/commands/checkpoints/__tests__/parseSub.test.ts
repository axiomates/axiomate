/**
 * Slash-command parsers for `/checkpoints` — surface-only unit tests.
 *
 * `parseSub` and `parseRowsToken` are exposed via `_internal` so they can
 * be exercised without spinning up the React side of `call()`. The two
 * parsers together define the dispatch contract for every `/checkpoints
 * ...` invocation, so coverage here is the cheap front-line guard
 * against regressions in the slash CLI.
 */

import { describe, expect, test } from 'vitest'
import { _internal } from '../checkpoints.js'

const { parseSub, parseRowsToken } = _internal

describe('parseSub', () => {
  test('empty arg → status with empty rest', () => {
    expect(parseSub('')).toEqual({ sub: 'status', rest: '' })
  })

  test('whitespace-only arg → status', () => {
    expect(parseSub('   ')).toEqual({ sub: 'status', rest: '' })
  })

  test('list, prune, clear are recognized', () => {
    expect(parseSub('list')).toMatchObject({ sub: 'list' })
    expect(parseSub('prune --force')).toMatchObject({
      sub: 'prune',
      rest: '--force',
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

describe('parseRowsToken', () => {
  test('absent → empty result', () => {
    expect(parseRowsToken([])).toEqual({})
    expect(parseRowsToken(['--force'])).toEqual({})
  })

  test('--rows N (split form) → rows', () => {
    expect(parseRowsToken(['--rows', '50'])).toEqual({ rows: 50 })
  })

  test('--rows=N (joined form) → rows', () => {
    expect(parseRowsToken(['--rows=42'])).toEqual({ rows: 42 })
  })

  test('--rows without value → error', () => {
    const r = parseRowsToken(['--rows'])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/--rows requires/)
  })

  test('--rows= empty string → error', () => {
    const r = parseRowsToken(['--rows='])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/--rows requires/)
  })

  test('non-numeric value → error', () => {
    const r = parseRowsToken(['--rows', 'abc'])
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/Invalid --rows abc/)
  })

  test('non-integer value → error', () => {
    const r = parseRowsToken(['--rows', '20.5'])
    expect('error' in r).toBe(true)
  })

  test('out-of-range low → error', () => {
    expect('error' in parseRowsToken(['--rows', '0'])).toBe(true)
  })

  test('out-of-range high → error', () => {
    expect('error' in parseRowsToken(['--rows', '99999'])).toBe(true)
  })

  test('exact bounds accepted (1, 500)', () => {
    expect(parseRowsToken(['--rows', '1'])).toEqual({ rows: 1 })
    expect(parseRowsToken(['--rows', '500'])).toEqual({ rows: 500 })
  })

  test('extra flags do not interfere', () => {
    expect(parseRowsToken(['--rows', '50', '--force'])).toEqual({ rows: 50 })
    expect(parseRowsToken(['--force', '--rows', '50'])).toEqual({ rows: 50 })
  })
})
