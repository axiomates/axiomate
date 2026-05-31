import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { writeFileSyncAndFlush_DEPRECATED } from '../../../utils/file.js'
import { FileHarnessError } from '../../../utils/fileHarnessFailures.js'
import {
  NodeFsOperations,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../../utils/fsOperations.js'

describe('writeFileSyncAndFlush_DEPRECATED', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'axiomate-file-util-'))
  })

  afterEach(async () => {
    setOriginalFsImplementation()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
    tempDir = ''
  })

  test('leaves the original file intact and cleans temp when atomic rename fails', async () => {
    const path = join(tempDir, 'target.txt')
    await writeFile(path, 'original\n', 'utf8')
    const renameError = Object.assign(new Error('simulated rename failure'), {
      code: 'EIO',
    })

    setFsImplementation({
      ...NodeFsOperations,
      renameSync: () => {
        throw renameError
      },
    })

    let thrown: unknown
    try {
      writeFileSyncAndFlush_DEPRECATED(path, 'replacement\n', {
        encoding: 'utf8',
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(FileHarnessError)
    expect((thrown as Error).message).toBe(renameError.message)
    expect((thrown as { code?: string }).code).toBe('EIO')
    expect((thrown as { cause?: unknown }).cause).toBe(renameError)
    expect(
      (thrown as FileHarnessError).fileHarnessFailure,
    ).toMatchObject({
      reason: 'atomic_write_failed',
      phase: 'helper',
      path,
    })
    expect(await readFile(path, 'utf8')).toBe('original\n')

    const entries = await readdir(dirname(path))
    expect(
      entries.filter(name => name.startsWith(`${basename(path)}.tmp.`)),
    ).toEqual([])
  })

  test('does not create a new target when atomic rename fails', async () => {
    const path = join(tempDir, 'new-target.txt')
    const renameError = Object.assign(new Error('simulated rename failure'), {
      code: 'EIO',
    })

    setFsImplementation({
      ...NodeFsOperations,
      renameSync: () => {
        throw renameError
      },
    })

    let thrown: unknown
    try {
      writeFileSyncAndFlush_DEPRECATED(path, 'replacement\n', {
        encoding: 'utf8',
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(FileHarnessError)
    expect((thrown as Error).message).toBe(renameError.message)
    expect((thrown as { code?: string }).code).toBe('EIO')
    expect((thrown as { cause?: unknown }).cause).toBe(renameError)
    expect(
      (thrown as FileHarnessError).fileHarnessFailure,
    ).toMatchObject({
      reason: 'atomic_write_failed',
      phase: 'helper',
      path,
    })
    await expect(readFile(path, 'utf8')).rejects.toThrow()

    const entries = await readdir(dirname(path))
    expect(
      entries.filter(name => name.startsWith(`${basename(path)}.tmp.`)),
    ).toEqual([])
  })

  test('falls back to direct write for opt-in rename lock failures', async () => {
    const path = join(tempDir, 'settings.json')
    await writeFile(path, '{"old":true}\n', 'utf8')
    const renameError = Object.assign(new Error('simulated lock failure'), {
      code: 'EPERM',
    })

    setFsImplementation({
      ...NodeFsOperations,
      renameSync: () => {
        throw renameError
      },
    })

    writeFileSyncAndFlush_DEPRECATED(path, '{"new":true}\n', {
      encoding: 'utf8',
      allowDirectFallbackOnRenameError: true,
    })

    expect(await readFile(path, 'utf8')).toBe('{"new":true}\n')

    const entries = await readdir(dirname(path))
    expect(
      entries.filter(name => name.startsWith(`${basename(path)}.tmp.`)),
    ).toEqual([])
  })

  test('does not fall back for opt-in non-lock rename failures', async () => {
    const path = join(tempDir, 'settings.json')
    await writeFile(path, '{"old":true}\n', 'utf8')
    const renameError = Object.assign(new Error('simulated io failure'), {
      code: 'EIO',
    })

    setFsImplementation({
      ...NodeFsOperations,
      renameSync: () => {
        throw renameError
      },
    })

    let thrown: unknown
    try {
      writeFileSyncAndFlush_DEPRECATED(path, '{"new":true}\n', {
        encoding: 'utf8',
        allowDirectFallbackOnRenameError: true,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(FileHarnessError)
    expect((thrown as { code?: string }).code).toBe('EIO')
    expect(await readFile(path, 'utf8')).toBe('{"old":true}\n')

    const entries = await readdir(dirname(path))
    expect(
      entries.filter(name => name.startsWith(`${basename(path)}.tmp.`)),
    ).toEqual([])
  })

  test('reports both rename and direct-write errors when opt-in fallback fails', async () => {
    const path = join(tempDir, 'settings-dir')
    await mkdir(path)
    const renameError = Object.assign(new Error('simulated lock failure'), {
      code: 'EPERM',
    })

    setFsImplementation({
      ...NodeFsOperations,
      renameSync: () => {
        throw renameError
      },
    })

    let thrown: unknown
    try {
      writeFileSyncAndFlush_DEPRECATED(path, '{"new":true}\n', {
        encoding: 'utf8',
        allowDirectFallbackOnRenameError: true,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(FileHarnessError)
    expect((thrown as { code?: string }).code).toBeDefined()
    expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(
      AggregateError,
    )
    expect(
      ((thrown as { cause: AggregateError }).cause.errors as unknown[]).includes(
        renameError,
      ),
    ).toBe(true)
    expect(
      ((thrown as { cause: AggregateError }).cause.errors as unknown[])[1],
    ).toBeInstanceOf(Error)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })
})
