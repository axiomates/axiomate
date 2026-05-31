import { describe, expect, test } from 'vitest'
import {
  cacheToObject,
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
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

  test('cacheToObject omits process-local registry sequence from persisted state', () => {
    const cache = createFileStateCacheWithSizeLimit(10)
    cache.set('/tmp/example.txt', {
      content: 'alpha\n',
      timestamp: 123,
      offset: 1,
      limit: undefined,
      registrySequence: 42,
    })

    const exported = cacheToObject(cache)
    const exportedState = Object.values(exported)[0]
    expect(Object.keys(exported)).toHaveLength(1)
    expect(exportedState).toEqual({
      content: 'alpha\n',
      timestamp: 123,
      offset: 1,
      limit: undefined,
    })
    expect(exportedState).not.toHaveProperty('registrySequence')
  })
})
