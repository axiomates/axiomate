/**
 * Tests for the picker-open counter (Phase 6 background-prune gate).
 *
 * Counter is process-wide module-local state in bootstrap/state.ts;
 * background housekeeping reads it before the prune call. Pin the
 * lifecycle invariants so a future refactor of getPickerOpenCount /
 * MessageSelector mount can't silently break the gate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  decrementPickerOpenCount,
  getPickerOpenCount,
  incrementPickerOpenCount,
} from '../../../bootstrap/state.js'

beforeEach(() => {
  // Counter is module-local — drain it deterministically before each
  // test so cross-test ordering can't leak counts.
  while (getPickerOpenCount() > 0) decrementPickerOpenCount()
})

afterEach(() => {
  while (getPickerOpenCount() > 0) decrementPickerOpenCount()
})

describe('pickerOpenCount lifecycle', () => {
  test('starts at zero', () => {
    expect(getPickerOpenCount()).toBe(0)
  })

  test('increments and decrements track open pickers', () => {
    incrementPickerOpenCount()
    expect(getPickerOpenCount()).toBe(1)
    incrementPickerOpenCount()
    expect(getPickerOpenCount()).toBe(2)
    decrementPickerOpenCount()
    expect(getPickerOpenCount()).toBe(1)
    decrementPickerOpenCount()
    expect(getPickerOpenCount()).toBe(0)
  })

  test('decrement floors at zero — defensive against unbalanced unmounts', () => {
    // React StrictMode, error boundaries, or a future refactor can
    // end up calling decrement without a matching increment. The
    // counter must not go negative — that would let a phantom
    // "negative open picker" hide a real concurrent open from the
    // gate. Floor at zero so the invariant getPickerOpenCount() >= 0
    // never breaks.
    decrementPickerOpenCount()
    decrementPickerOpenCount()
    expect(getPickerOpenCount()).toBe(0)
    incrementPickerOpenCount()
    expect(getPickerOpenCount()).toBe(1)
  })
})
