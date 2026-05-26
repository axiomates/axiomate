import { describe, expect, test } from 'vitest'
import { prettifyJsonError } from '../../../utils/promptEditor.js'

/**
 * Verify the friendly JSON error message produced for the most common
 * JS-vs-JSON confusions a user makes when editing templates / model
 * configs in $EDITOR.
 *
 * Each test triggers a real JSON.parse failure on a small synthetic
 * input, captures the V8 message, and asserts prettifyJsonError surfaces
 * a hint about the actual cause + a line/col pointer.
 */
describe('prettifyJsonError', () => {
  function parse(input: string): { message: string; content: string } {
    try {
      JSON.parse(input)
      throw new Error(`expected JSON.parse to throw on: ${input}`)
    } catch (err) {
      return {
        message: err instanceof Error ? err.message : String(err),
        content: input,
      }
    }
  }

  test('detects // line comments', () => {
    const input = '{\n  // hi\n  "x": 1\n}'
    const { message, content } = parse(input)
    expect(prettifyJsonError(message, content)).toMatch(
      /JSON does not support comments/,
    )
    expect(prettifyJsonError(message, content)).toMatch(/line \d+, col \d+/)
  })

  test('detects /* block comments */', () => {
    const input = '{ /* hi */ "x": 1 }'
    const { message, content } = parse(input)
    expect(prettifyJsonError(message, content)).toMatch(
      /JSON does not support comments/,
    )
  })

  test('detects trailing comma before }', () => {
    const input = '{ "x": 1, }'
    const { message, content } = parse(input)
    expect(prettifyJsonError(message, content)).toMatch(/trailing commas/)
  })

  test('detects trailing comma before ]', () => {
    const input = '[1, 2, 3,]'
    const { message, content } = parse(input)
    expect(prettifyJsonError(message, content)).toMatch(/trailing commas/)
  })

  test('detects unquoted keys', () => {
    const input = '{ x: 1 }'
    const { message, content } = parse(input)
    expect(prettifyJsonError(message, content)).toMatch(
      /keys to be double-quoted strings/,
    )
  })

  test('detects single-quoted strings', () => {
    const input = `{ "x": 'hello' }`
    const { message, content } = parse(input)
    expect(prettifyJsonError(message, content)).toMatch(
      /requires double quotes/,
    )
  })

  test('detects Infinity / NaN / undefined', () => {
    for (const literal of ['Infinity', 'NaN', 'undefined']) {
      const input = `{ "x": ${literal} }`
      const { message, content } = parse(input)
      expect(prettifyJsonError(message, content)).toMatch(
        /Infinity, NaN, or undefined/,
      )
    }
  })

  test('falls back to V8 message when no pattern matches', () => {
    // Truly malformed but doesn't fit any of our hint patterns.
    // Newer Node may not include "at position N" in the message, so the
    // fallback either prepends line/col (older V8) or passes through (newer).
    const input = '{"x":'
    const { message, content } = parse(input)
    const result = prettifyJsonError(message, content)
    expect(result).toMatch(/Invalid JSON/)
  })

  test('falls back without position when message has no offset', () => {
    // Synthetic message that doesn't include "at position N".
    const result = prettifyJsonError('totally weird parser error', '{}')
    expect(result).toBe('Invalid JSON: totally weird parser error')
  })

  test('reports the right line for multi-line input', () => {
    // Comment is on line 4 of a 5-line input.
    const input = '{\n  "a": 1,\n  "b": 2,\n  // hi\n  "c": 3\n}'
    const { message, content } = parse(input)
    const result = prettifyJsonError(message, content)
    expect(result).toMatch(/line 4/)
  })
})
