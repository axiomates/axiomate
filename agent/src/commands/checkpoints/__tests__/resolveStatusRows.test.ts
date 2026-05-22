/**
 * `resolveStatusRows` — three-tier precedence for the row count used by
 * `/checkpoints status` and `/checkpoints list`:
 *   override (CLI flag) > globalConfig > fallback (20)
 *
 * Hand-edited `~/.axiomate.json` can put garbage in the numeric slot, so
 * the resolver clamps invalid config values back to the fallback rather
 * than blowing up the renderer. ConfigTool already rejects out-of-range
 * writes, but defense-in-depth keeps surprise bug reports out of the TUI.
 *
 * The test mocks `getGlobalConfig` directly because `getGlobalConfigFile`
 * is memoized for the lifetime of the process — env-var redirect tricks
 * (used elsewhere for store-path isolation) don't reach this resolver
 * once any other test in the run has already touched config.
 */

import { describe, expect, test, vi } from 'vitest'

const mockGetGlobalConfig = vi.fn()

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: mockGetGlobalConfig,
}))

const {
  resolveStatusRows,
  ROWS_FALLBACK,
  ROWS_MAX,
  ROWS_MIN,
} = await import('../resolveStatusRows.js')

function setConfigRows(value: unknown): void {
  mockGetGlobalConfig.mockReturnValue({ checkpointsStatusRows: value })
}

describe('resolveStatusRows — precedence', () => {
  test('override beats config', () => {
    setConfigRows(50)
    expect(resolveStatusRows(7)).toBe(7)
  })

  test('config beats fallback when override absent', () => {
    setConfigRows(75)
    expect(resolveStatusRows()).toBe(75)
  })

  test('fallback applies when config field is undefined', () => {
    setConfigRows(undefined)
    expect(resolveStatusRows()).toBe(ROWS_FALLBACK)
  })
})

describe('resolveStatusRows — clamping invalid config', () => {
  test('non-number → fallback', () => {
    setConfigRows('not a number')
    expect(resolveStatusRows()).toBe(ROWS_FALLBACK)
  })

  test('non-integer → fallback', () => {
    setConfigRows(20.5)
    expect(resolveStatusRows()).toBe(ROWS_FALLBACK)
  })

  test('NaN → fallback', () => {
    setConfigRows(Number.NaN)
    expect(resolveStatusRows()).toBe(ROWS_FALLBACK)
  })

  test('below min → fallback', () => {
    setConfigRows(0)
    expect(resolveStatusRows()).toBe(ROWS_FALLBACK)
  })

  test('above max → fallback', () => {
    setConfigRows(99999)
    expect(resolveStatusRows()).toBe(ROWS_FALLBACK)
  })

  test('exact bounds are accepted', () => {
    setConfigRows(ROWS_MIN)
    expect(resolveStatusRows()).toBe(ROWS_MIN)
    setConfigRows(ROWS_MAX)
    expect(resolveStatusRows()).toBe(ROWS_MAX)
  })
})
