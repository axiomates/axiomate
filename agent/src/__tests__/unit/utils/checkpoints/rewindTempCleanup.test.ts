import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  cleanupRewindTempDirs,
  REWIND_TEMP_OWNER_FILE,
  REWIND_TEMP_PREFIX,
} from '../../../../utils/checkpoints/rewindTempCleanup.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-rewind-temp-cleanup-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function makeDir(name: string, ageMs = 0): string {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'payload.nul'), 'payload')
  if (ageMs > 0) {
    const stale = new Date(Date.now() - ageMs)
    utimesSync(dir, stale, stale)
  }
  return dir
}

describe('cleanupRewindTempDirs', () => {
  test('removes only matching rewind temp directories', async () => {
    const rewind = makeDir(`${REWIND_TEMP_PREFIX}old`, 2_000)
    const other = makeDir('not-axiomate-rewind-old', 2_000)

    const report = await cleanupRewindTempDirs({
      olderThanMs: 1_000,
      tempRoot: tmpRoot,
    })

    expect(report.dirsRemoved).toBe(1)
    expect(existsSync(rewind)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  test('skips matching directories that are too young', async () => {
    const fresh = makeDir(`${REWIND_TEMP_PREFIX}fresh`)

    const report = await cleanupRewindTempDirs({
      olderThanMs: 60_000,
      tempRoot: tmpRoot,
    })

    expect(report.dirsRemoved).toBe(0)
    expect(report.skippedYoung).toBe(1)
    expect(existsSync(fresh)).toBe(true)
  })

  test('skips stale matching directories when owner pid is alive', async () => {
    const active = makeDir(`${REWIND_TEMP_PREFIX}active`)
    writeFileSync(
      join(active, REWIND_TEMP_OWNER_FILE),
      JSON.stringify({ pid: process.pid }),
    )
    const stale = new Date(Date.now() - 2_000)
    utimesSync(active, stale, stale)

    const report = await cleanupRewindTempDirs({
      olderThanMs: 1_000,
      tempRoot: tmpRoot,
    })

    expect(report.dirsRemoved).toBe(0)
    expect(report.skippedActive).toBe(1)
    expect(existsSync(active)).toBe(true)
  })

  test('includeActive removes matching directories regardless of owner pid', async () => {
    const active = makeDir(`${REWIND_TEMP_PREFIX}active`)
    writeFileSync(
      join(active, REWIND_TEMP_OWNER_FILE),
      JSON.stringify({ pid: process.pid }),
    )

    const report = await cleanupRewindTempDirs({
      includeActive: true,
      tempRoot: tmpRoot,
    })

    expect(report.dirsRemoved).toBe(1)
    expect(existsSync(active)).toBe(false)
  })
})
