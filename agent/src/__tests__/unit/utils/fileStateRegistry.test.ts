import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { asAgentId } from '../../../types/ids.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { FileHarnessError } from '../../../utils/fileHarnessFailures.js'
import {
  clearFileStateRegistryForTests,
  getFileStateRegistryPathKeyForTests,
  getFileStateRegistrySequence,
  getFileStatePathLockDepthForTests,
  getKnownReadFilePaths,
  getPathsWrittenByOtherContextsSince,
  canonicalizeTextForReadState,
  recordObservedTextReadState,
  setObservedFileState,
  setObservedFileStateIfNewer,
  noteFileWrite,
  recordFileRead,
  wasFileModifiedAfterReadByAnotherContext,
  withFileStatePathLock,
} from '../../../utils/fileStateRegistry.js'

function makeContext(agentId?: ReturnType<typeof asAgentId>) {
  return {
    agentId,
    readFileState: createFileStateCacheWithSizeLimit(10),
  }
}

function seedRead(context: ReturnType<typeof makeContext>, path: string): void {
  setObservedFileState(context, path, {
    content: 'content',
    timestamp: 1,
    offset: 1,
    limit: undefined,
  })
}

async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'axiomate-registry-'))
  try {
    return await callback(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function createDirectoryAlias(
  realDir: string,
  linkDir: string,
): Promise<boolean> {
  try {
    await symlink(
      realDir,
      linkDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    return true
  } catch {
    return false
  }
}

describe('fileStateRegistry path keys', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
  })

  test('uses the same key for an existing file reached through a symlinked parent', async () => {
    await withTempDir(async tempDir => {
      const realDir = join(tempDir, 'real')
      const linkDir = join(tempDir, 'link')
      await mkdir(realDir)
      await writeFile(join(realDir, 'same.txt'), 'content', 'utf8')
      if (!(await createDirectoryAlias(realDir, linkDir))) return

      expect(
        getFileStateRegistryPathKeyForTests(join(linkDir, 'same.txt')),
      ).toBe(getFileStateRegistryPathKeyForTests(join(realDir, 'same.txt')))
    })
  })

  test('uses the same key for a new file under a symlinked parent', async () => {
    await withTempDir(async tempDir => {
      const realDir = join(tempDir, 'real')
      const linkDir = join(tempDir, 'link')
      await mkdir(realDir)
      if (!(await createDirectoryAlias(realDir, linkDir))) return

      expect(
        getFileStateRegistryPathKeyForTests(join(linkDir, 'new.txt')),
      ).toBe(getFileStateRegistryPathKeyForTests(join(realDir, 'new.txt')))
    })
  })

  test('applies separate Windows, macOS, and Linux case rules', async () => {
    await withTempDir(async tempDir => {
      const mixedCase = join(tempDir, 'CaseProbe', 'File.TXT')
      const lowerCase = join(tempDir, 'caseprobe', 'file.txt')

      expect(
        getFileStateRegistryPathKeyForTests(mixedCase, {
          platform: 'win32',
        }),
      ).toBe(
        getFileStateRegistryPathKeyForTests(lowerCase, { platform: 'win32' }),
      )
      expect(
        getFileStateRegistryPathKeyForTests(mixedCase, {
          platform: 'linux',
        }),
      ).not.toBe(
        getFileStateRegistryPathKeyForTests(lowerCase, { platform: 'linux' }),
      )
      expect(
        getFileStateRegistryPathKeyForTests(mixedCase, {
          platform: 'darwin',
          macCaseInsensitive: true,
        }),
      ).toBe(
        getFileStateRegistryPathKeyForTests(lowerCase, {
          platform: 'darwin',
          macCaseInsensitive: true,
        }),
      )
      expect(
        getFileStateRegistryPathKeyForTests(mixedCase, {
          platform: 'darwin',
          macCaseInsensitive: false,
        }),
      ).not.toBe(
        getFileStateRegistryPathKeyForTests(lowerCase, {
          platform: 'darwin',
          macCaseInsensitive: false,
        }),
      )
    })
  })

  test('detects the current macOS volume case rule without using Windows logic', async () => {
    await withTempDir(async tempDir => {
      const probePath = join(tempDir, 'CaseProbe')
      const lowerProbePath = join(tempDir, 'caseprobe')
      await writeFile(probePath, 'content', 'utf8')
      const volumeIsCaseInsensitive = existsSync(lowerProbePath)

      expect(
        getFileStateRegistryPathKeyForTests(probePath, {
          platform: 'darwin',
        }) ===
          getFileStateRegistryPathKeyForTests(lowerProbePath, {
            platform: 'darwin',
          }),
      ).toBe(volumeIsCaseInsensitive)
    })
  })

  test('detects sibling writes through symlink aliases', async () => {
    await withTempDir(async tempDir => {
      const realDir = join(tempDir, 'real')
      const linkDir = join(tempDir, 'link')
      await mkdir(realDir)
      await writeFile(join(realDir, 'same.txt'), 'content', 'utf8')
      if (!(await createDirectoryAlias(realDir, linkDir))) return

      const parent = makeContext()
      const child = makeContext(asAgentId('achild000000000304'))
      const realPath = join(realDir, 'same.txt')
      const linkPath = join(linkDir, 'same.txt')

      seedRead(parent, realPath)
      const sinceSequence = getFileStateRegistrySequence()
      noteFileWrite(child, linkPath)

      expect(wasFileModifiedAfterReadByAnotherContext(parent, realPath)).toBe(
        true,
      )
      expect(
        getPathsWrittenByOtherContextsSince(
          parent,
          sinceSequence,
          getKnownReadFilePaths(parent),
        ),
      ).toEqual([normalize(realPath)])
    })
  })

  test('treats an alias read as current when it happened after a sibling write', async () => {
    await withTempDir(async tempDir => {
      const realDir = join(tempDir, 'real')
      const linkDir = join(tempDir, 'link')
      await mkdir(realDir)
      await writeFile(join(realDir, 'same.txt'), 'content', 'utf8')
      if (!(await createDirectoryAlias(realDir, linkDir))) return

      const parent = makeContext()
      const child = makeContext(asAgentId('achild000000000305'))
      const realPath = join(realDir, 'same.txt')
      const linkPath = join(linkDir, 'same.txt')

      noteFileWrite(child, realPath)
      seedRead(parent, linkPath)

      expect(wasFileModifiedAfterReadByAnotherContext(parent, realPath)).toBe(
        false,
      )
    })
  })
})

describe('fileStateRegistry reminder queries', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
  })

  test('reports sibling writes after a captured sequence for known parent reads', () => {
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000301'))
    const readPath = normalize('/tmp/parent-read.txt')
    const unreadPath = normalize('/tmp/parent-unread.txt')

    seedRead(parent, readPath)
    const sinceSequence = getFileStateRegistrySequence()

    noteFileWrite(child, readPath)
    noteFileWrite(child, unreadPath)

    expect(getKnownReadFilePaths(parent)).toEqual([readPath])
    expect(
      getPathsWrittenByOtherContextsSince(
        parent,
        sinceSequence,
        getKnownReadFilePaths(parent),
      ),
    ).toEqual([readPath])
  })

  test('excludes parent writes and writes before the captured sequence', () => {
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000302'))
    const oldPath = normalize('/tmp/old.txt')
    const ownPath = normalize('/tmp/own.txt')

    seedRead(parent, oldPath)
    seedRead(parent, ownPath)
    noteFileWrite(child, oldPath)
    const sinceSequence = getFileStateRegistrySequence()
    noteFileWrite(parent, ownPath)

    expect(
      getPathsWrittenByOtherContextsSince(
        parent,
        sinceSequence,
        getKnownReadFilePaths(parent),
      ),
    ).toEqual([])
  })

  test('does not remind after parent re-reads the sibling write', () => {
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000303'))
    const path = normalize('/tmp/reread.txt')

    seedRead(parent, path)
    const sinceSequence = getFileStateRegistrySequence()
    noteFileWrite(child, path)
    recordFileRead(parent, path)

    expect(
      getPathsWrittenByOtherContextsSince(
        parent,
        sinceSequence,
        getKnownReadFilePaths(parent),
      ),
    ).toEqual([])
  })

  test('keeps recently rewritten paths when the writer registry reaches its cap', () => {
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000306'))
    const refreshedPath = normalize('/tmp/refreshed.txt')
    const evictedPath = normalize('/tmp/evicted.txt')

    seedRead(parent, refreshedPath)
    seedRead(parent, evictedPath)
    const sinceSequence = getFileStateRegistrySequence()

    noteFileWrite(child, refreshedPath)
    noteFileWrite(child, evictedPath)
    for (let i = 0; i < 4094; i++) {
      noteFileWrite(child, normalize(`/tmp/fill-${i}.txt`))
    }
    noteFileWrite(child, refreshedPath)
    noteFileWrite(child, normalize('/tmp/overflow.txt'))

    expect(wasFileModifiedAfterReadByAnotherContext(parent, refreshedPath)).toBe(
      true,
    )
    expect(wasFileModifiedAfterReadByAnotherContext(parent, evictedPath)).toBe(
      false,
    )
    expect(
      getPathsWrittenByOtherContextsSince(
        parent,
        sinceSequence,
        getKnownReadFilePaths(parent),
      ),
    ).toEqual([refreshedPath])
  })

  test('stamps observed side-channel reads for sibling write checks', () => {
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000307'))
    const beforePath = normalize('/tmp/observed-before.txt')
    const afterPath = normalize('/tmp/observed-after.txt')

    noteFileWrite(child, beforePath)
    setObservedFileState(parent, beforePath, {
      content: 'before',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    setObservedFileState(parent, afterPath, {
      content: 'after',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    noteFileWrite(child, afterPath)

    expect(wasFileModifiedAfterReadByAnotherContext(parent, beforePath)).toBe(
      false,
    )
    expect(wasFileModifiedAfterReadByAnotherContext(parent, afterPath)).toBe(
      true,
    )
  })

  test('stamps SDK read-state seeds merged after sibling writes', () => {
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000308'))
    const path = normalize('/tmp/sdk-seeded-read.txt')

    noteFileWrite(child, path)
    const applied = setObservedFileStateIfNewer(parent, path, {
      content: 'content from sdk seed',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })

    expect(applied).toBe(true)
    expect(parent.readFileState.get(path)?.registrySequence).toBeDefined()
    expect(wasFileModifiedAfterReadByAnotherContext(parent, path)).toBe(false)

    noteFileWrite(child, path)
    expect(wasFileModifiedAfterReadByAnotherContext(parent, path)).toBe(true)
  })
})

describe('fileStateRegistry reconstructed read abstention', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
  })

  test('abstains when a reconstructed read has no registry sequence', () => {
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000401'))
    const path = normalize('/tmp/reconstructed-no-stamp.txt')

    // Simulate a transcript-reconstructed / --print seed read: content is in
    // the cache but the read was never stamped through recordFileRead.
    parent.readFileState.set(path, {
      content: 'reconstructed',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    expect(parent.readFileState.get(path)?.registrySequence).toBeUndefined()

    // A sibling write exists, but an unstamped read cannot be ordered against
    // it. The registry must abstain (false) and defer to mtime/content checks,
    // not falsely claim a sibling write that would wrongly reject the write.
    noteFileWrite(child, path)
    expect(wasFileModifiedAfterReadByAnotherContext(parent, path)).toBe(false)
  })

  test('still reports a sibling write once the read is stamped live', () => {
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000402'))
    const path = normalize('/tmp/reconstructed-then-stamped.txt')

    parent.readFileState.set(path, {
      content: 'reconstructed',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    // A real live read stamps the entry...
    recordFileRead(parent, path)
    // ...and a later sibling write must still be detected.
    noteFileWrite(child, path)
    expect(wasFileModifiedAfterReadByAnotherContext(parent, path)).toBe(true)
  })
})

describe('fileStateRegistry path locks', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
  })

  test('serializes callbacks for the same normalized path', async () => {
    const path = normalize('/tmp/lock.txt')
    const events: string[] = []
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve
    })

    const first = withFileStatePathLock(path, async () => {
      events.push('first:start')
      await firstMayFinish
      events.push('first:end')
    })
    const second = withFileStatePathLock(path, async () => {
      events.push('second:start')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    expect(getFileStatePathLockDepthForTests(path)).toBe(2)

    releaseFirst()
    await Promise.all([first, second])

    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
    expect(getFileStatePathLockDepthForTests(path)).toBe(0)
  })

  test('allows callbacks for different paths to overlap', async () => {
    const firstPath = normalize('/tmp/lock-a.txt')
    const secondPath = normalize('/tmp/lock-b.txt')
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const events: string[] = []

    const first = withFileStatePathLock(firstPath, async () => {
      events.push('first:start')
      await firstMayFinish
      events.push('first:end')
    })

    await Promise.resolve()
    await withFileStatePathLock(secondPath, async () => {
      events.push('second:start')
    })

    expect(events).toEqual(['first:start', 'second:start'])
    releaseFirst()
    await first
    expect(events).toEqual(['first:start', 'second:start', 'first:end'])
  })

  test('releases the same-path queue after a rejected callback', async () => {
    const path = normalize('/tmp/reject-lock.txt')
    const error = new Error('boom')
    const events: string[] = []

    await expect(
      withFileStatePathLock(path, async () => {
        events.push('first:start')
        throw error
      }),
    ).rejects.toBe(error)

    await withFileStatePathLock(path, async () => {
      events.push('second:start')
    })

    expect(events).toEqual(['first:start', 'second:start'])
    expect(getFileStatePathLockDepthForTests(path)).toBe(0)
  })

  test('rejects same-path reentry instead of deadlocking', async () => {
    const path = normalize('/tmp/reentrant-lock.txt')
    const events: string[] = []
    let thrown: unknown

    try {
      await withFileStatePathLock(path, async () => {
        events.push('outer:start')
        await withFileStatePathLock(path, async () => {
          events.push('inner:start')
        })
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(FileHarnessError)
    expect((thrown as FileHarnessError).fileHarnessFailure).toMatchObject({
      reason: 'path_lock_reentry',
      phase: 'execution',
      path,
    })
    expect((thrown as Error).message).toContain(
      'File state path lock is not reentrant',
    )

    await expect(
      withFileStatePathLock(path, async () => {
        events.push('after:start')
      }),
    ).resolves.toBeUndefined()

    expect(events).toEqual(['outer:start', 'after:start'])
    expect(getFileStatePathLockDepthForTests(path)).toBe(0)
  })

  test('serializes callbacks for symlink aliases of the same file', async () => {
    await withTempDir(async tempDir => {
      const realDir = join(tempDir, 'real')
      const linkDir = join(tempDir, 'link')
      await mkdir(realDir)
      await writeFile(join(realDir, 'same.txt'), 'content', 'utf8')
      if (!(await createDirectoryAlias(realDir, linkDir))) return

      const realPath = join(realDir, 'same.txt')
      const linkPath = join(linkDir, 'same.txt')
      const events: string[] = []
      let releaseFirst!: () => void
      const firstMayFinish = new Promise<void>(resolve => {
        releaseFirst = resolve
      })

      const first = withFileStatePathLock(linkPath, async () => {
        events.push('first:start')
        await firstMayFinish
        events.push('first:end')
      })
      const second = withFileStatePathLock(realPath, async () => {
        events.push('second:start')
      })

      await Promise.resolve()
      expect(events).toEqual(['first:start'])
      expect(getFileStatePathLockDepthForTests(realPath)).toBe(2)

      releaseFirst()
      await Promise.all([first, second])

      expect(events).toEqual(['first:start', 'first:end', 'second:start'])
      expect(getFileStatePathLockDepthForTests(linkPath)).toBe(0)
    })
  })
})

describe('recordObservedTextReadState (consolidation boundary)', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
  })

  test('canonicalizes content (BOM strip + CRLF→LF) on store', () => {
    expect(canonicalizeTextForReadState('﻿a\r\nb\r\n')).toBe('a\nb\n')

    const context = makeContext()
    const path = normalize('/tmp/canon.md')
    recordObservedTextReadState(context, path, {
      content: '﻿# H\r\n\r\nx\r\n',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    const stored = context.readFileState.get(path)
    expect(stored?.content).toBe('# H\n\nx\n')
    expect(stored?.content).not.toContain('\r')
  })

  test("stamp 'live' (default) assigns a registrySequence", () => {
    const context = makeContext()
    const path = normalize('/tmp/live.md')
    recordObservedTextReadState(context, path, {
      content: 'a\n',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    expect(context.readFileState.get(path)?.registrySequence).toBeDefined()
  })

  test("stamp 'reconstructed' leaves the read unstamped so the registry abstains", () => {
    const context = makeContext()
    const child = makeContext(asAgentId('achild000000000901'))
    const path = normalize('/tmp/reconstructed.md')

    // A sibling wrote the path; a reconstructed (unstamped) read must NOT claim
    // to be ordered after that write — the registry abstains and defers to the
    // content gate.
    noteFileWrite(child, path)
    recordObservedTextReadState(
      context,
      path,
      { content: 'a\n', timestamp: 1, offset: undefined, limit: undefined },
      { stamp: 'reconstructed' },
    )
    expect(context.readFileState.get(path)?.registrySequence).toBeUndefined()
    expect(wasFileModifiedAfterReadByAnotherContext(context, path)).toBe(false)
  })

  test('passes the VIEW axis (isPartialView/limit/totalLines) through untouched', () => {
    const context = makeContext()
    const path = normalize('/tmp/partial.md')
    recordObservedTextReadState(context, path, {
      content: 'a\r\nb\n',
      timestamp: 1,
      offset: 1,
      limit: 10,
      totalLines: 42,
      isPartialView: true,
    })
    const stored = context.readFileState.get(path)
    expect(stored?.content).toBe('a\nb\n')
    expect(stored?.limit).toBe(10)
    expect(stored?.totalLines).toBe(42)
    expect(stored?.isPartialView).toBe(true)
  })
})
