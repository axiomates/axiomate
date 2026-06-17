import { normalize } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../../Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
} from '../../../utils/fileStateCache.js'
import { clearFileStateRegistryForTests } from '../../../utils/fileStateRegistry.js'
import type { MemoryFileInfo } from '../../../utils/axiomatemd.js'

// memoryFilesToAttachments fires InstructionsLoaded hooks for instruction-type
// memories; stub the registry check so the unit test stays hook-free.
vi.mock('../../../utils/hooks.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../utils/hooks.js')>()
  return {
    ...actual,
    hasInstructionsLoadedHook: () => false,
    executeInstructionsLoadedHooks: vi.fn(),
  }
})

import { memoryFilesToAttachments } from '../../../utils/attachments.js'

function makeContext(): { readFileState: FileStateCache; ctx: ToolUseContext } {
  const readFileState = createFileStateCacheWithSizeLimit(10)
  const ctx = {
    agentId: undefined,
    readFileState,
    loadedNestedMemoryPaths: new Set<string>(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
  return { readFileState, ctx }
}

describe('nested-memory injection read-state normalization (B5)', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
  })

  // B5: a CRLF AXIOMATE.md whose finalContent === rawContent (no frontmatter /
  // HTML comment / truncation) has contentDiffersFromDisk === false, so it is
  // stored as a FULL read. The stored content must be LF-normalized to match
  // the Write/Edit gate (normalizeContentToLf(disk)); otherwise the model is
  // falsely blocked from editing/overwriting its own memory file once the
  // file's mtime advances. This is the exact 2026-06-17 fix case.
  // See docs/file/read-state-write-consolidation-plan.md (blind spot B5).
  test('LF-normalizes a full-read (non-partial) CRLF memory file', () => {
    const path = normalize('/tmp/nested-AXIOMATE.md')
    const memoryFile: MemoryFileInfo = {
      path,
      type: 'Project',
      content: '# Project\r\n\r\nUse pnpm.\r\n',
      // contentDiffersFromDisk omitted => false => full read, isPartialView false
    }
    const { readFileState, ctx } = makeContext()

    memoryFilesToAttachments([memoryFile], ctx)

    const stored = readFileState.get(path)
    expect(stored).toBeDefined()
    expect(stored?.content).toBe('# Project\n\nUse pnpm.\n')
    expect(stored?.content).not.toContain('\r')
    expect(stored?.isPartialView).toBeFalsy()
  })

  test('partial-view (contentDiffersFromDisk) raw bytes are also LF-normalized', () => {
    const path = normalize('/tmp/nested-partial.md')
    const memoryFile: MemoryFileInfo = {
      path,
      type: 'Project',
      content: '# stripped\n',
      contentDiffersFromDisk: true,
      rawContent: '# stripped\r\n<!-- comment -->\r\n',
    }
    const { readFileState, ctx } = makeContext()

    memoryFilesToAttachments([memoryFile], ctx)

    const stored = readFileState.get(path)
    expect(stored?.content).not.toContain('\r')
    expect(stored?.isPartialView).toBe(true)
  })
})
