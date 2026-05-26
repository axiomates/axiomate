/**
 * Behavior tests for `clearAll` — destructive helper that nukes
 * `~/.axiomate/checkpoints/`. Backs Phase 5's `/checkpoints clear`
 * and `axiomate checkpoints clear`.
 *
 * Coverage:
 *   - nonexistent base → no-op, `bytes_freed: 0`, `deleted: false`
 *   - populated store → size measured before delete, dir removed,
 *     `deleted: true`, no errors
 *   - rm failure → error captured, never thrown
 *   - subsequent ensureStore re-creates the store from scratch
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'

// Hoisted rm-mock holder. `vi.mock` factories run before module-level
// `import` execution, so we need this trick to swap the impl per test.
const rmMock = vi.hoisted(() => ({
  fn: undefined as undefined | ((...args: unknown[]) => Promise<void>),
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...actual,
    rm: (...args: unknown[]) =>
      rmMock.fn ? rmMock.fn(...args) : actual.rm(args[0] as string, args[1] as never),
  }
})

import { clearAll } from '../../../../utils/checkpoints/clearAll.js'
import { _resetGitAvailableCacheForTesting } from '../../../../utils/checkpoints/git.js'
import { getCheckpointBase, getStoreDir } from '../../../../utils/checkpoints/paths.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'

let tmpRoot: string
let baseEnvBefore: string | undefined

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-clearall-'))
  baseEnvBefore = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (baseEnvBefore === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = baseEnvBefore
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  const fresh = mkdtempSync(join(tmpRoot, 'base-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = fresh
  _resetGitAvailableCacheForTesting()
})

afterEach(() => {
  delete process.env.AXIOMATE_CHECKPOINT_BASE
  rmMock.fn = undefined
})

describe('clearAll — empty/missing base', () => {
  test('nonexistent base: no-op with bytes_freed=0, deleted=false, no errors', async () => {
    rmSync(process.env.AXIOMATE_CHECKPOINT_BASE!, {
      recursive: true,
      force: true,
    })
    const report = await clearAll()
    expect(report.bytes_freed).toBe(0)
    expect(report.deleted).toBe(false)
    expect(report.errors).toEqual([])
  })

  test('empty base directory: deletes it, bytes_freed=0', async () => {
    const report = await clearAll()
    expect(report.deleted).toBe(true)
    expect(report.bytes_freed).toBe(0)
    expect(report.errors).toEqual([])
    expect(existsSync(getCheckpointBase())).toBe(false)
  })
})

describe('clearAll — populated store', () => {
  test('populated store: bytes_freed > 0, deleted=true, dir gone', async () => {
    const init = await ensureStore()
    expect(init.ok).toBe(true)
    const base = getCheckpointBase()
    // Pad the base with a bit of extra data so size > 0 is unambiguous.
    writeFileSync(join(base, 'pad.txt'), 'x'.repeat(2048))

    const before = existsSync(base)
    expect(before).toBe(true)

    const report = await clearAll()
    expect(report.deleted).toBe(true)
    expect(report.bytes_freed).toBeGreaterThan(0)
    expect(report.errors).toEqual([])
    expect(existsSync(base)).toBe(false)
  })

  test('after clearAll, ensureStore rebuilds the store from scratch', async () => {
    const first = await ensureStore()
    expect(first.ok).toBe(true)
    const storePath = getStoreDir()
    expect(existsSync(storePath)).toBe(true)

    const cleared = await clearAll()
    expect(cleared.deleted).toBe(true)
    expect(existsSync(storePath)).toBe(false)

    const second = await ensureStore()
    expect(second.ok).toBe(true)
    expect(existsSync(storePath)).toBe(true)
    expect(existsSync(`${storePath}/HEAD`)).toBe(true)
  })
})

describe('clearAll — failure capture', () => {
  test('rm error is captured into errors[] and never thrown', async () => {
    const init = await ensureStore()
    expect(init.ok).toBe(true)

    let calls = 0
    rmMock.fn = async () => {
      calls++
      throw new Error('EBUSY: pretend AV lock')
    }

    const report = await clearAll()
    expect(report.deleted).toBe(false)
    expect(report.errors.length).toBe(1)
    expect(report.errors[0]).toContain('EBUSY')
    // bytes_freed reflects pre-delete measurement even when delete fails.
    expect(report.bytes_freed).toBeGreaterThan(0)
    expect(calls).toBe(1)
  })

  test('non-Error thrown value is stringified into errors[]', async () => {
    mkdirSync(getStoreDir(), { recursive: true })
    rmMock.fn = async () => {
      throw 'weird-string-failure'
    }

    const report = await clearAll()
    expect(report.deleted).toBe(false)
    expect(report.errors).toEqual(['weird-string-failure'])
  })
})
