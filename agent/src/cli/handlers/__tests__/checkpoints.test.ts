/**
 * Behavior tests for `axiomate checkpoints` CLI handlers.
 *
 * Covers the CLI-only branches (everything else is shared with the
 * slash command and already tested via `views.test.ts`):
 *   - `clear` without `--force` exits 1, never touches the store
 *   - `clear --force` on an empty store prints "nothing to clear",
 *     does not exit
 *   - `clear --force` on a populated store deletes it, prints bytes
 *   - `prune` with non-numeric option exits 1
 *
 * `process.exit` is intercepted via a custom Error so the handler stops
 * cleanly mid-flight without killing the test runner. Stdout/stderr are
 * captured via spy.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
import {
  checkpointsClearHandler,
  checkpointsListHandler,
  checkpointsPruneHandler,
  checkpointsStatusHandler,
} from '../checkpoints.js'
import { _resetGitAvailableCacheForTesting } from '../../../utils/checkpoints/git.js'
import { ensureStore } from '../../../utils/checkpoints/store.js'
import { getCheckpointBase } from '../../../utils/checkpoints/paths.js'

class ExitInvoked extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

let tmpRoot: string
let baseEnvBefore: string | undefined
let exitSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-cli-cp-'))
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
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      throw new ExitInvoked(code ?? 0)
    }) as never)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  delete process.env.AXIOMATE_CHECKPOINT_BASE
  exitSpy.mockRestore()
  logSpy.mockRestore()
  errSpy.mockRestore()
})

describe('checkpointsClearHandler', () => {
  test('without --force: exits 1, store untouched', async () => {
    const init = await ensureStore()
    expect(init.ok).toBe(true)
    const base = getCheckpointBase()

    await expect(checkpointsClearHandler({})).rejects.toBeInstanceOf(ExitInvoked)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
    const errMsg = (errSpy.mock.calls[0]?.[0] ?? '') as string
    expect(errMsg).toMatch(/--force/)
    expect(existsSync(base)).toBe(true)
  })

  test('--force on empty base: prints "nothing to clear", returns 0', async () => {
    // Explicitly DON'T ensureStore — base is an empty mkdtemp dir.
    await checkpointsClearHandler({ force: true })
    const stdout = (logSpy.mock.calls.map(c => c[0] ?? '').join('\n')) as string
    expect(stdout).toMatch(/Nothing to clear/)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test('--force on populated store: deletes, prints bytes, no exit', async () => {
    const init = await ensureStore()
    expect(init.ok).toBe(true)
    const base = getCheckpointBase()
    writeFileSync(join(base, 'pad.bin'), 'x'.repeat(4096))
    expect(existsSync(base)).toBe(true)

    await checkpointsClearHandler({ force: true })
    const stdout = (logSpy.mock.calls.map(c => c[0] ?? '').join('\n')) as string
    expect(stdout).toMatch(/Cleared/)
    expect(stdout).toContain(base)
    expect(existsSync(base)).toBe(false)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

describe('checkpointsPruneHandler', () => {
  test('non-numeric --retention-days exits 1', async () => {
    await expect(
      checkpointsPruneHandler({ retentionDays: 'abc' }),
    ).rejects.toBeInstanceOf(ExitInvoked)
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errMsg = (errSpy.mock.calls[0]?.[0] ?? '') as string
    expect(errMsg).toMatch(/Invalid numeric option/)
  })

  test('non-numeric --max-size-mb exits 1', async () => {
    await expect(
      checkpointsPruneHandler({ maxSizeMb: 'big' }),
    ).rejects.toBeInstanceOf(ExitInvoked)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  test('--keep-orphans is plumbed through; handler exits cleanly on empty store', async () => {
    // Empty base (no ensureStore). The flag must be accepted by the
    // handler, plumbed through to pruneCheckpoints, and the run must
    // complete without invoking process.exit.
    await checkpointsPruneHandler({ keepOrphans: true, force: true })
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

describe('--rows flag', () => {
  test('checkpointsStatusHandler: non-numeric --rows exits 1', async () => {
    await expect(
      checkpointsStatusHandler({ rows: 'abc' }),
    ).rejects.toBeInstanceOf(ExitInvoked)
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errMsg = (errSpy.mock.calls[0]?.[0] ?? '') as string
    expect(errMsg).toMatch(/Invalid --rows/)
  })

  test('checkpointsStatusHandler: out-of-range --rows exits 1', async () => {
    await expect(
      checkpointsStatusHandler({ rows: '99999' }),
    ).rejects.toBeInstanceOf(ExitInvoked)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  test('checkpointsStatusHandler: --rows 50 runs to completion on empty store', async () => {
    await checkpointsStatusHandler({ rows: '50' })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test('checkpointsListHandler: non-numeric --rows exits 1', async () => {
    await expect(
      checkpointsListHandler({ rows: 'big' }),
    ).rejects.toBeInstanceOf(ExitInvoked)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  test('checkpointsListHandler: --rows 5 runs to completion', async () => {
    await checkpointsListHandler({ rows: '5' })
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
