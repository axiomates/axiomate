import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  NodeFsOperations,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../../utils/fsOperations.js'
import {
  clearInternalWrites,
  consumeInternalWrite,
} from '../../../utils/settings/internalWrites.js'
import {
  getSettingsFilePathForSource,
  updateSettingsForSource,
} from '../../../utils/settings/settings.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'

describe('updateSettingsForSource write fallback', () => {
  let tempDir = ''
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'axiomate-settings-write-'))
    previousConfigDir = process.env.AXIOMATE_CONFIG_DIR
    process.env.AXIOMATE_CONFIG_DIR = join(tempDir, 'config')
    resetSettingsCache()
    clearInternalWrites()
  })

  afterEach(async () => {
    setOriginalFsImplementation()
    resetSettingsCache()
    clearInternalWrites()
    if (previousConfigDir === undefined) {
      delete process.env.AXIOMATE_CONFIG_DIR
    } else {
      process.env.AXIOMATE_CONFIG_DIR = previousConfigDir
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
    tempDir = ''
  })

  test('uses opt-in fallback for settings rename lock failures', async () => {
    const filePath = getSettingsFilePathForSource('userSettings')
    expect(filePath).toBeDefined()
    await mkdir(dirname(filePath!), { recursive: true })
    await writeFile(filePath!, '{"theme":"dark"}\n', 'utf8')

    setFsImplementation({
      ...NodeFsOperations,
      renameSync: () => {
        throw Object.assign(new Error('simulated settings lock'), {
          code: 'EPERM',
        })
      },
    })

    const result = updateSettingsForSource('userSettings', {
      theme: 'light',
    })

    expect(result.error).toBeNull()
    expect(await readFile(filePath!, 'utf8')).toBe('{\n  "theme": "light"\n}\n')
    expect(consumeInternalWrite(filePath!, 5_000)).toBe(true)
  })

  test('does not mark internal write when settings write fails', async () => {
    const filePath = getSettingsFilePathForSource('userSettings')
    expect(filePath).toBeDefined()
    await mkdir(dirname(filePath!), { recursive: true })
    await writeFile(filePath!, '{"theme":"dark"}\n', 'utf8')

    setFsImplementation({
      ...NodeFsOperations,
      renameSync: () => {
        throw Object.assign(new Error('simulated io failure'), { code: 'EIO' })
      },
    })

    const result = updateSettingsForSource('userSettings', {
      theme: 'light',
    })

    expect(result.error).toBeInstanceOf(Error)
    expect(await readFile(filePath!, 'utf8')).toBe('{"theme":"dark"}\n')
    expect(consumeInternalWrite(filePath!, 5_000)).toBe(false)
  })
})
