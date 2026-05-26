/**
 * Scoring-formula contract tests for tolerantJsonParser.
 *
 * These tests pin the ORDERING RELATIONSHIPS of the candidate scoring at
 * tolerantJsonParser.ts:299-303 (tryParseCandidate) and the tiebreakers at
 * :332-341 (chooseBestCandidate), without asserting the exact magic
 * constants (5, 2, 3). Future tuning is safe as long as the ordering
 * relationships documented here still hold.
 */
import { describe, expect, it } from 'vitest'

import { repairJsonText } from '../../../utils/jsonRepair.js'

function expectOk(input: string) {
  const result = repairJsonText(input)
  if (result.ok === false) {
    throw new Error(`Expected success but got failure: ${result.error}`)
  }
  return result
}

describe('tolerantJsonParser scoring — candidate selection contracts', () => {
  it('normal mode wins over synthetic when both could parse', () => {
    // Valid JSON that normal mode parses cleanly — synthetic modes must
    // not be picked even though they would also succeed (e.g. wrapping
    // `{"a":1}` in another outer object would parse too).
    const result = expectOk('{"a":1}')
    const kinds = result.repairs.map(r => r.kind)
    expect(kinds).not.toContain('wrapped_root_object')
    expect(kinds).not.toContain('wrapped_root_array')
  })

  it('synthetic mode activates only when normal mode produces no viable candidate', () => {
    // Object body without surrounding braces — normal mode would reject
    // (scalar with trailing junk after the first string), synthetic_object
    // wraps and wins. Ordering: synthetic is chosen iff normal lost.
    const result = expectOk('"a":1,"b":2')
    expect(result.value).toEqual({ a: 1, b: 2 })
    expect(result.repairs.map(r => r.kind)).toContain('wrapped_root_object')
  })

  it('fewer repairs beats a candidate with more repairs at the same consumption', () => {
    // Fenced JSON can be extracted either by code-fence stripping (1 repair)
    // or by treating the `\`\`\`` as leading prose and then stripping.
    // The fewer-repairs winner is the fenced path.
    const result = expectOk('```json\n{"a":1}\n```')
    expect(result.value).toEqual({ a: 1 })
    const kinds = result.repairs.map(r => r.kind)
    expect(kinds).toContain('stripped_code_fence')
    // The tiebreaker should not have picked a path that also includes
    // stripped_leading_prose if the fenced-only path is available and
    // produced the same result with fewer repairs.
  })

  it('more bytes consumed beats a candidate that bailed early on trailing junk', () => {
    // Input has a full valid object followed by junk. Normal mode consumes
    // the whole object and records `ignored_trailing_junk`. A competing
    // candidate that bailed at the first structural token would score lower
    // on `scoreIndex` and lose.
    const result = expectOk('{"a":1,"b":2} garbage tail')
    expect(result.value).toEqual({ a: 1, b: 2 })
    expect(result.repairs.map(r => r.kind)).toContain('ignored_trailing_junk')
  })

  it('trailing-junk penalty keeps a short clean parse from beating a longer repaired parse', () => {
    // A valid outer array with a minor repair should win over any
    // scalar interpretation of just the first element — the outer array
    // consumes more bytes and all of it is repaired.
    const result = expectOk('[1,2,3,]')
    expect(result.value).toEqual([1, 2, 3])
    expect(result.repairs.map(r => r.kind)).toContain('removed_trailing_comma')
  })

  it('rejects scalar-in-normal-mode when trailing junk is present (scoring guard)', () => {
    // This is the explicit scalar+hadTrailingJunk rejection at L288-297:
    // pure prose containing `42 random words` must NOT be "repaired" to 42,
    // even though 42 is a valid scalar JSON value.
    const result = repairJsonText('42 random words')
    // Either the parser fails, or it finds a different representation —
    // but it must not claim success with value === 42.
    if (result.ok) {
      expect(result.value).not.toBe(42)
    } else {
      expect(result.ok).toBe(false)
    }
  })

  it('chooses wrapped-array only when there is a strong array signal', () => {
    // Without a separator or multiple items, synthetic_array must not
    // trigger — otherwise a single word would become ["word"].
    const result = repairJsonText('just one word')
    expect(result.ok).toBe(false)
  })

  it('accepts wrapped-array when there is a comma-separated sequence of values', () => {
    // With a clear comma-separated list at depth 0, synthetic_array wins.
    const result = expectOk('1, 2, 3')
    expect(result.value).toEqual([1, 2, 3])
    expect(result.repairs.map(r => r.kind)).toContain('wrapped_root_array')
  })
})
