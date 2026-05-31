import { normalize } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { asAgentId } from '../../../types/ids.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import {
  clearFileStateRegistryForTests,
  getFileStateRegistrySequence,
  getFileStatePathLockDepthForTests,
  getKnownReadFilePaths,
  getPathsWrittenByOtherContextsSince,
  noteFileWrite,
  recordFileRead,
  withFileStatePathLock,
} from '../../../utils/fileStateRegistry.js'

function makeContext(agentId?: ReturnType<typeof asAgentId>) {
  return {
    agentId,
    readFileState: createFileStateCacheWithSizeLimit(10),
  }
}

function seedRead(context: ReturnType<typeof makeContext>, path: string): void {
  context.readFileState.set(path, {
    content: 'content',
    timestamp: 1,
    offset: 1,
    limit: undefined,
  })
  recordFileRead(context, path)
}

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
})
