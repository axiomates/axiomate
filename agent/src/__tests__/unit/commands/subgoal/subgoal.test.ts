import { describe, expect, it } from 'vitest'

import { _internal } from '../../../../commands/subgoal/subgoal.js'

const { parseVerb } = _internal

describe('parseVerb', () => {
  it('empty arg → show', () => {
    expect(parseVerb('')).toEqual({ verb: 'show', rest: '' })
  })

  it('remove <n>', () => {
    expect(parseVerb('remove 3')).toEqual({ verb: 'remove', rest: '3' })
  })

  it('remove with no index — still recognised as remove (caller errors)', () => {
    expect(parseVerb('remove')).toEqual({ verb: 'remove', rest: '' })
  })

  it('clear', () => {
    expect(parseVerb('clear')).toEqual({ verb: 'clear', rest: '' })
  })

  it('anything else → add (rest = full arg)', () => {
    expect(parseVerb('add a test for edge cases')).toEqual({
      verb: 'add',
      rest: 'add a test for edge cases',
    })
    // No magic "add" keyword — the whole arg goes through verbatim.
    expect(parseVerb('cover the regression')).toEqual({
      verb: 'add',
      rest: 'cover the regression',
    })
  })

  it('case-insensitive on verb keywords', () => {
    expect(parseVerb('REMOVE 1')).toEqual({ verb: 'remove', rest: '1' })
    expect(parseVerb('Clear')).toEqual({ verb: 'clear', rest: '' })
  })

  it('list / ls alias the bare-no-args show', () => {
    expect(parseVerb('list')).toEqual({ verb: 'show', rest: '' })
    expect(parseVerb('ls')).toEqual({ verb: 'show', rest: '' })
    expect(parseVerb('LIST')).toEqual({ verb: 'show', rest: '' })
  })

  it('rm alias of remove', () => {
    expect(parseVerb('rm 2')).toEqual({ verb: 'remove', rest: '2' })
  })
})
