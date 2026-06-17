import { normalize } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { asAgentId } from '../../../types/ids.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import { filterDuplicateMemoryAttachments } from '../../../utils/attachments.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import {
  clearFileStateRegistryForTests,
  noteFileWrite,
  wasFileModifiedAfterReadByAnotherContext,
} from '../../../utils/fileStateRegistry.js'
import type { Attachment } from '../../../utils/attachments.js'

function makeContext(agentId?: ReturnType<typeof asAgentId>) {
  return {
    agentId,
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  }
}

function makeRelevantMemory(
  path: string,
  limit?: number,
  content = 'memory content',
): Attachment {
  return {
    type: 'relevant_memories',
    memories: [
      {
        path,
        content,
        mtimeMs: 1,
        ...(limit === undefined ? {} : { limit }),
      },
    ],
  } as Attachment
}

describe('attachment file state registry integration', () => {
  beforeEach(() => {
    clearFileStateRegistryForTests()
  })

  test('marks surfaced relevant memories as observed reads for sibling stale checks', () => {
    const path = normalize('/tmp/relevant-memory.md')
    const parent = makeContext()
    const child = makeContext(asAgentId('achild000000000401'))

    noteFileWrite(child, path)
    const attachments = filterDuplicateMemoryAttachments(
      [makeRelevantMemory(path)],
      parent,
    )

    expect(attachments).toHaveLength(1)
    expect(parent.readFileState.get(path)?.registrySequence).toBeDefined()
    expect(wasFileModifiedAfterReadByAnotherContext(parent, path)).toBe(false)

    noteFileWrite(child, path)
    expect(wasFileModifiedAfterReadByAnotherContext(parent, path)).toBe(true)
  })

  test('marks truncated relevant memories as partial views', () => {
    const path = normalize('/tmp/truncated-memory.md')
    const parent = makeContext()

    filterDuplicateMemoryAttachments([makeRelevantMemory(path, 25)], parent)

    expect(parent.readFileState.get(path)).toMatchObject({
      limit: 25,
      isPartialView: true,
    })
  })

  test('LF-normalizes surfaced memory content so a CRLF memory is not falsely stale', () => {
    // A CRLF memory must be stored LF-normalized: the Write/Edit staleness gate
    // compares normalizeContentToLf(disk), so a raw-CRLF full-read coordinate
    // would falsely reject edits/overwrites once the file's mtime advances.
    const path = normalize('/tmp/crlf-memory.md')
    const parent = makeContext()

    filterDuplicateMemoryAttachments(
      [makeRelevantMemory(path, undefined, '# Mem\r\n\r\nline\r\n')],
      parent,
    )

    const stored = parent.readFileState.get(path)
    expect(stored?.content).toBe('# Mem\n\nline\n')
    expect(stored?.content).not.toContain('\r')
  })
})
