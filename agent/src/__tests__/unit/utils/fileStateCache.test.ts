import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  cacheToObject,
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  fileStateHasFullContent,
} from '../../../utils/fileStateCache.js'

describe('FileStateCache', () => {
  test('clone preserves process-local registry sequence for subagent guards', () => {
    const cache = createFileStateCacheWithSizeLimit(10)
    cache.set('/tmp/example.txt', {
      content: 'alpha\n',
      timestamp: 123,
      offset: 1,
      limit: undefined,
      registrySequence: 42,
    })

    const cloned = cloneFileStateCache(cache)

    expect(cloned.get('/tmp/example.txt')?.registrySequence).toBe(42)
  })

  test('cacheToObject omits runtime-only metadata from persisted state', () => {
    const cache = createFileStateCacheWithSizeLimit(10)
    cache.set('/tmp/example.txt', {
      content: 'alpha\n',
      timestamp: 123,
      offset: 1,
      limit: undefined,
      totalLines: 2,
      registrySequence: 42,
      toolNormalization: {
        sourceTool: 'Write',
        normalizedLineEndings: true,
      },
    })

    const exported = cacheToObject(cache)
    const exportedState = Object.values(exported)[0]
    expect(Object.keys(exported)).toHaveLength(1)
    expect(exportedState).toEqual({
      content: 'alpha\n',
      timestamp: 123,
      offset: 1,
      limit: undefined,
      totalLines: 2,
    })
    expect(exportedState).not.toHaveProperty('registrySequence')
    expect(exportedState).not.toHaveProperty('toolNormalization')
  })

  test('preserves original path casing when cloning and enumerating', () => {
    const cache = createFileStateCacheWithSizeLimit(10)
    const path = String.raw`C:\Project\File.txt`
    cache.set(path, {
      content: 'alpha\n',
      timestamp: 123,
      offset: 1,
      limit: undefined,
    })

    const cloned = cloneFileStateCache(cache)

    expect(Array.from(cache.keys())).toEqual([path])
    expect(Array.from(cloned.keys())).toEqual([path])
  })

  test('uses file registry path keys for symlink aliases', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'axiomate-cache-'))
    try {
      const realDir = join(tempDir, 'real')
      const linkDir = join(tempDir, 'link')
      await mkdir(realDir)
      await writeFile(join(realDir, 'same.txt'), 'alpha\n', 'utf8')
      try {
        await symlink(
          realDir,
          linkDir,
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      } catch {
        return
      }

      const realPath = join(realDir, 'same.txt')
      const linkPath = join(linkDir, 'same.txt')
      const cache = createFileStateCacheWithSizeLimit(10)
      cache.set(linkPath, {
        content: 'alpha\n',
        timestamp: 123,
        offset: 1,
        limit: undefined,
      })

      expect(cache.get(realPath)?.content).toBe('alpha\n')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('treats a bounded range from line one as full when it covered all lines', () => {
    expect(
      fileStateHasFullContent({
        content: 'alpha\nbeta\n',
        timestamp: 123,
        offset: 1,
        limit: 3,
        totalLines: 3,
      }),
    ).toBe(true)
  })

  test('treats a bounded range from line one as partial when it did not cover all lines', () => {
    expect(
      fileStateHasFullContent({
        content: 'alpha\n',
        timestamp: 123,
        offset: 1,
        limit: 1,
        totalLines: 3,
      }),
    ).toBe(false)
  })
})
