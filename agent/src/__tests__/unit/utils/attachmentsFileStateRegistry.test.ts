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

function makeRelevantMemory(path: string, limit?: number): Attachment {
  return {
    type: 'relevant_memories',
    memories: [
      {
        path,
        content: 'memory content',
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
})
