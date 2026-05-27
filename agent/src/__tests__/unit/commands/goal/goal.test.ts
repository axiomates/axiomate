import { describe, expect, it } from 'vitest'

import { _internal } from '../../../../commands/goal/goal.js'

const { parseSub } = _internal

describe('parseSub', () => {
  it('empty arg → status', () => {
    expect(parseSub('')).toBe('status')
  })

  it('status / STATUS / mixed case', () => {
    expect(parseSub('status')).toBe('status')
    expect(parseSub('STATUS')).toBe('status')
    expect(parseSub('Status')).toBe('status')
    expect(parseSub('list')).toBe('status')
    expect(parseSub('ls')).toBe('status')
  })

  it('pause / resume', () => {
    expect(parseSub('pause')).toBe('pause')
    expect(parseSub('resume')).toBe('resume')
  })

  it('clear / stop / done all alias to clear', () => {
    expect(parseSub('clear')).toBe('clear')
    expect(parseSub('stop')).toBe('clear')
    expect(parseSub('done')).toBe('clear')
  })

  it('anything else → null (caller treats as goal text)', () => {
    expect(parseSub('do the thing')).toBeNull()
    expect(parseSub('clearly not')).toBeNull()
    expect(parseSub('pausetastic')).toBeNull()
  })
})
