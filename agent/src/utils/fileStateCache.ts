import { LRUCache } from 'lru-cache'
import { normalize } from 'path'
import { getFileStateRegistryPathKey } from './fileStateRegistry.js'

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  totalLines?: number
  // Records format-only changes applied by a structured tool while preserving
  // the known semantic text state. This is informational; full-content checks
  // should not treat it as a partial read.
  toolNormalization?: {
    sourceTool: 'Write'
    removedLeadingBom?: boolean
    normalizedLineEndings?: boolean
  }
  // True when this entry was populated by auto-injection (e.g. AXIOMATE.md) and
  // the injected content did not match disk (stripped HTML comments, stripped
  // frontmatter, truncated MEMORY.md). The model has only seen a partial view;
  // Write treats this as insufficient for overwriting an existing file. `content`
  // here holds the RAW disk bytes (for getChangedFiles diffing), not what the
  // model saw.
  isPartialView?: boolean
  // Internal process-local ordering stamp used by fileStateRegistry. This is
  // intentionally carried by cloneFileStateCache so subagents inherit the
  // parent's known-read ordering for stale sibling-write checks.
  registrySequence?: number
}

export function fileStateHasFullContent(fileState: FileState): boolean {
  if (fileState.isPartialView) return false
  if (fileState.limit === undefined) {
    return fileState.offset === undefined || fileState.offset === 1
  }
  if (fileState.offset !== undefined && fileState.offset !== 1) return false
  if (fileState.totalLines === undefined) return false
  return fileState.limit >= fileState.totalLines
}

// Default max entries for read file state caches
export const READ_FILE_STATE_CACHE_SIZE = 100

// Default size limit for file state caches (25MB)
// This prevents unbounded memory growth from large file contents
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

/**
 * A file state cache that normalizes all path keys before access.
 * This ensures consistent cache hits regardless of whether callers pass
 * relative vs absolute paths with redundant segments (e.g. /foo/../bar)
 * or mixed path separators on Windows (/ vs \).
 */
export class FileStateCache {
  private cache: LRUCache<string, FileState>
  private originalKeysByLookupKey = new Map<string, string>()

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Math.max(1, Buffer.byteLength(value.content)),
      dispose: (_value, key) => {
        this.originalKeysByLookupKey.delete(key)
      },
    })
  }

  get(key: string): FileState | undefined {
    return this.cache.get(getFileStateRegistryPathKey(key))
  }

  set(key: string, value: FileState): this {
    const normalizedKey = normalize(key)
    const lookupKey = getFileStateRegistryPathKey(normalizedKey)
    this.cache.set(lookupKey, value)
    this.originalKeysByLookupKey.set(lookupKey, normalizedKey)
    return this
  }

  has(key: string): boolean {
    return this.cache.has(getFileStateRegistryPathKey(key))
  }

  delete(key: string): boolean {
    const lookupKey = getFileStateRegistryPathKey(key)
    this.originalKeysByLookupKey.delete(lookupKey)
    return this.cache.delete(lookupKey)
  }

  clear(): void {
    this.cache.clear()
    this.originalKeysByLookupKey.clear()
  }

  get size(): number {
    return this.cache.size
  }

  get max(): number {
    return this.cache.max
  }

  get maxSize(): number {
    return this.cache.maxSize
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize
  }

  *keys(): Generator<string> {
    for (const key of this.cache.keys()) {
      yield this.originalKeysByLookupKey.get(key) ?? key
    }
  }

  *entries(): Generator<[string, FileState]> {
    for (const [key, value] of this.cache.entries()) {
      yield [this.originalKeysByLookupKey.get(key) ?? key, value]
    }
  }

  dump(): ReturnType<LRUCache<string, FileState>['dump']> {
    return this.cache.dump()
  }

  load(entries: ReturnType<LRUCache<string, FileState>['dump']>): void {
    this.cache.load(entries)
    this.originalKeysByLookupKey.clear()
    for (const key of this.cache.keys()) {
      this.originalKeysByLookupKey.set(key, key)
    }
  }
}

/**
 * Factory function to create a size-limited FileStateCache.
 * Uses LRUCache's built-in size-based eviction to prevent memory bloat.
 * Note: Images are not cached (see FileReadTool) so size limit is mainly
 * for large text files, notebooks, and other editable content.
 */
export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

// Helper function to convert cache to object (used by compact.ts)
export function cacheToObject(
  cache: FileStateCache,
): Record<string, FileState> {
  return Object.fromEntries(
    Array.from(cache.entries(), ([filePath, fileState]) => {
      const {
        registrySequence: _registrySequence,
        toolNormalization: _toolNormalization,
        ...persistableState
      } = fileState
      return [filePath, persistableState]
    }),
  )
}

// Helper function to get all keys from cache (used by several components)
export function cacheKeys(cache: FileStateCache): string[] {
  return Array.from(cache.keys())
}

// Helper function to clone a FileStateCache
// Preserves size limit configuration from the source cache
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const cloned = createFileStateCacheWithSizeLimit(cache.max, cache.maxSize)
  for (const [filePath, fileState] of cache.entries()) {
    cloned.set(filePath, {
      ...fileState,
      ...(fileState.toolNormalization
        ? { toolNormalization: { ...fileState.toolNormalization } }
        : {}),
    })
  }
  return cloned
}

// Merge two file state caches using only timestamps. This does not record
// process-local observed-read registry stamps; do not use it to restore
// content that the current model now observes.
export function mergeFileStateCachesByTimestampOnly(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath)
    // Only override if the new entry is more recent
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState)
    }
  }
  return merged
}
