import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createFileStateCacheWithSizeLimit,
  fileStateHasFullContent,
} from '../../../utils/fileStateCache.js'
import type { Output as FileReadToolOutput } from '../../../tools/FileReadTool/FileReadTool.js'
import {
  reconstructFileStateFromTranscriptMessages,
  restoreObservedReadFilesFromMessages,
} from '../../../utils/queryHelpers.js'
import {
  clearFileStateRegistryForTests,
  noteFileWrite,
  wasFileModifiedAfterReadByAnotherContext,
} from '../../../utils/fileStateRegistry.js'
import type { Message } from '../../../types/message.js'
import { asAgentId } from '../../../types/ids.js'
import { notebookRawJsonToReadStateContent } from '../../../utils/notebook.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

beforeEach(() => {
  clearFileStateRegistryForTests()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'axiomate-query-helpers-'))
  tmpDirs.push(dir)
  return dir
}

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'test',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as Message
}

function toolResult(
  id: string,
  timestamp: string,
  options: { isError?: boolean; content?: string } = {},
): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: options.content ?? 'ok',
          ...(options.isError ? { is_error: true } : {}),
        },
      ],
    },
  } as Message
}

function readResult(
  id: string,
  timestamp: string,
  content: string,
): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
        },
      ],
    },
  } as Message
}

function fileAttachment(
  filename: string,
  timestamp: string,
  content: FileReadToolOutput,
  truncated?: boolean,
): Message {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp,
    attachment: {
      type: 'file',
      filename,
      displayPath: filename,
      content,
      ...(truncated ? { truncated: true } : {}),
    },
  } as Message
}

describe('reconstructFileStateFromTranscriptMessages file-state resume reconstruction', () => {
  test('reconstructs Write state from canonical tool semantics and records format normalization', () => {
    const dir = tempDir()
    const file = join(dir, 'write.txt')
    const messages = [
      assistantToolUse('write-1', 'Write', {
        file_path: file,
        content: '\ufeffalpha\r\nbeta\r\n',
      }),
      toolResult('write-1', '2026-01-01T00:00:01.000Z'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta\n')
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:01.000Z').getTime(),
    )
    expect(state?.toolNormalization).toEqual({
      sourceTool: 'Write',
      removedLeadingBom: true,
      normalizedLineEndings: true,
    })
  })

  test('reconstructs successful empty Write state', () => {
    const dir = tempDir()
    const file = join(dir, 'empty-write.txt')
    const messages = [
      assistantToolUse('write-1', 'Write', {
        file_path: file,
        content: '',
      }),
      toolResult('write-1', '2026-01-01T00:00:01.000Z'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('')
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:01.000Z').getTime(),
    )
  })

  test('does not reconstruct failed Write state', () => {
    const dir = tempDir()
    const file = join(dir, 'failed-write.txt')
    const messages = [
      assistantToolUse('write-1', 'Write', {
        file_path: file,
        content: 'replacement\n',
      }),
      toolResult('write-1', '2026-01-01T00:00:01.000Z', {
        isError: true,
        content: '<tool_use_error>File has not been read yet.</tool_use_error>',
      }),
    ]

    const cache = reconstructFileStateFromTranscriptMessages(messages, dir, 10)

    expect(cache.get(file)).toBeUndefined()
  })

  test('does not reconstruct failed Read state', () => {
    const dir = tempDir()
    const file = join(dir, 'failed-read.txt')
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
      }),
      toolResult('read-1', '2026-01-01T00:00:01.000Z', {
        isError: true,
        content: '<tool_use_error>File does not exist.</tool_use_error>',
      }),
    ]

    const cache = reconstructFileStateFromTranscriptMessages(messages, dir, 10)

    expect(cache.get(file)).toBeUndefined()
  })

  test('reconstructs bounded Read as full when transcript proves it reached EOF', () => {
    const dir = tempDir()
    const file = join(dir, 'bounded-full-read.txt')
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
        offset: 1,
        limit: 10,
      }),
      readResult('read-1', '2026-01-01T00:00:01.000Z', '1\talpha\n2\tbeta'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta')
    expect(state?.offset).toBe(1)
    expect(state?.limit).toBe(10)
    expect(state?.totalLines).toBe(2)
    expect(state && fileStateHasFullContent(state)).toBe(true)
  })

  test('reconstructs file attachment content as observed Read state', () => {
    const dir = tempDir()
    const file = join(dir, 'attached.txt')
    const messages = [
      fileAttachment(file, '2026-01-01T00:00:01.000Z', {
        type: 'text',
        file: {
          filePath: file,
          content: 'alpha\nbeta\n',
          numLines: 2,
          startLine: 1,
          totalLines: 2,
        },
      }),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta\n')
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:01.000Z').getTime(),
    )
    expect(state?.offset).toBe(1)
    expect(state?.limit).toBeUndefined()
    expect(state && fileStateHasFullContent(state)).toBe(true)
  })

  test('replays file attachment in transcript order', () => {
    const dir = tempDir()
    const file = join(dir, 'attached-after-write.txt')
    const messages = [
      assistantToolUse('write-1', 'Write', {
        file_path: file,
        content: 'old\n',
      }),
      toolResult('write-1', '2026-01-01T00:00:01.000Z'),
      fileAttachment(file, '2026-01-01T00:00:02.000Z', {
        type: 'text',
        file: {
          filePath: file,
          content: 'new\n',
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      }),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('new\n')
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:02.000Z').getTime(),
    )
  })

  test('reconstructs truncated file attachment as partial Read state', () => {
    const dir = tempDir()
    const file = join(dir, 'truncated-attachment.txt')
    const messages = [
      fileAttachment(
        file,
        '2026-01-01T00:00:01.000Z',
        {
          type: 'text',
          file: {
            filePath: file,
            content: 'alpha\nbeta\n',
            numLines: 2,
            startLine: 1,
            totalLines: 10,
          },
        },
        true,
      ),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta\n')
    expect(state?.offset).toBe(1)
    expect(state?.limit).toBe(2)
    expect(state?.totalLines).toBe(10)
    expect(state?.isPartialView).toBe(true)
    expect(state && fileStateHasFullContent(state)).toBe(false)
  })

  test('reconstructs limit-only Read as full when transcript proves it reached EOF', () => {
    const dir = tempDir()
    const file = join(dir, 'limit-only-full-read.txt')
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
        limit: 10,
      }),
      readResult('read-1', '2026-01-01T00:00:01.000Z', '1\talpha\n2\tbeta'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta')
    expect(state?.offset).toBe(1)
    expect(state?.limit).toBe(10)
    expect(state?.totalLines).toBe(2)
    expect(state && fileStateHasFullContent(state)).toBe(true)
  })

  test('reconstructs offset-one Read without limit as full', () => {
    const dir = tempDir()
    const file = join(dir, 'offset-one-full-read.txt')
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
        offset: 1,
      }),
      readResult('read-1', '2026-01-01T00:00:01.000Z', '1\talpha\n2\tbeta'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta')
    expect(state?.offset).toBe(1)
    expect(state?.limit).toBeUndefined()
    expect(state && fileStateHasFullContent(state)).toBe(true)
  })

  test('reconstructs bounded empty Read from the first line as full', () => {
    const dir = tempDir()
    const file = join(dir, 'bounded-empty-read.txt')
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
        offset: 1,
        limit: 10,
      }),
      readResult(
        'read-1',
        '2026-01-01T00:00:01.000Z',
        '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
      ),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('')
    expect(state?.offset).toBe(1)
    expect(state?.limit).toBe(10)
    expect(state?.totalLines).toBe(0)
    expect(state && fileStateHasFullContent(state)).toBe(true)
  })

  test('reconstructs bounded Read as partial when returned line count reaches limit', () => {
    const dir = tempDir()
    const file = join(dir, 'bounded-partial-read.txt')
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
        offset: 1,
        limit: 2,
      }),
      readResult('read-1', '2026-01-01T00:00:01.000Z', '1\talpha\n2\tbeta'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta')
    expect(state?.offset).toBe(1)
    expect(state?.limit).toBe(2)
    expect(state?.isPartialView).toBe(true)
    expect(state && fileStateHasFullContent(state)).toBe(false)
  })

  test('reconstructs non-leading bounded Read as partial', () => {
    const dir = tempDir()
    const file = join(dir, 'offset-partial-read.txt')
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
        offset: 3,
        limit: 10,
      }),
      readResult('read-1', '2026-01-01T00:00:01.000Z', '3\tgamma\n4\tdelta'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('gamma\ndelta')
    expect(state?.offset).toBe(3)
    expect(state?.limit).toBe(10)
    expect(state?.isPartialView).toBe(true)
    expect(state && fileStateHasFullContent(state)).toBe(false)
  })

  test('replays successful Edit against prior known content instead of reading current disk', () => {
    const dir = tempDir()
    const file = join(dir, 'edit.txt')
    writeFileSync(file, 'human offline edit\n', 'utf8')
    const messages = [
      assistantToolUse('write-1', 'Write', {
        file_path: file,
        content: 'alpha\nbeta\n',
      }),
      toolResult('write-1', '2026-01-01T00:00:01.000Z'),
      assistantToolUse('edit-1', 'Edit', {
        file_path: file,
        old_string: 'beta',
        new_string: 'BETA',
      }),
      toolResult('edit-1', '2026-01-01T00:00:02.000Z'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nBETA\n')
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:02.000Z').getTime(),
    )
  })

  test('replays successful NotebookEdit state from tool output', () => {
    const dir = tempDir()
    const file = join(dir, 'notebook.ipynb')
    const original = JSON.stringify([
      { cellType: 'code', source: 'print("old")', cell_id: 'cell-1' },
    ])
    const updated = JSON.stringify({
      cells: [
        {
          id: 'cell-1',
          cell_type: 'code',
          source: 'print("new")',
          metadata: {},
          execution_count: null,
          outputs: [],
        },
      ],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    })
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
      }),
      toolResult('read-1', '2026-01-01T00:00:01.000Z', {
        content: `Result of calling the Read tool:\n${original}`,
      }),
      assistantToolUse('notebook-edit-1', 'NotebookEdit', {
        notebook_path: file,
        cell_id: 'cell-1',
        new_source: 'print("new")',
        cell_type: 'code',
      }),
      toolResult('notebook-edit-1', '2026-01-01T00:00:02.000Z', {
        content: 'Updated cell cell-1 with print("new")',
      }),
    ]
    ;(messages[3] as any).toolUseResult = {
      new_source: 'print("new")',
      cell_type: 'code',
      language: 'python',
      edit_mode: 'replace',
      cell_id: 'cell-1',
      error: '',
      notebook_path: file,
      original_file: '{}',
      updated_file: updated,
    }

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe(notebookRawJsonToReadStateContent(updated))
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:02.000Z').getTime(),
    )
    expect(state?.offset).toBeUndefined()
    expect(state?.limit).toBeUndefined()
  })

  test('does not seed Edit state from current disk when replay has no prior known content', () => {
    const dir = tempDir()
    const file = join(dir, 'edit-without-prior.txt')
    writeFileSync(file, 'human offline edit\n', 'utf8')
    const messages = [
      assistantToolUse('edit-1', 'Edit', {
        file_path: file,
        old_string: 'alpha',
        new_string: 'ALPHA',
      }),
      toolResult('edit-1', '2026-01-01T00:00:02.000Z'),
    ]

    const cache = reconstructFileStateFromTranscriptMessages(messages, dir, 10)

    expect(cache.get(file)).toBeUndefined()
  })

  test('does not overwrite prior known content when Edit replay fails', () => {
    const dir = tempDir()
    const file = join(dir, 'edit-fails.txt')
    writeFileSync(file, 'human offline edit\n', 'utf8')
    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
      }),
      readResult('read-1', '2026-01-01T00:00:01.000Z', '1\talpha\n2\tbeta'),
      assistantToolUse('edit-1', 'Edit', {
        file_path: file,
        old_string: 'gamma',
        new_string: 'GAMMA',
      }),
      toolResult('edit-1', '2026-01-01T00:00:02.000Z'),
    ]

    const state = reconstructFileStateFromTranscriptMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta')
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:01.000Z').getTime(),
    )
  })

  test('TUI resume marks restored Read state as an observed registry read without changing historical timestamp', () => {
    const dir = tempDir()
    const file = join(dir, 'tui-resume-observed-read.txt')
    const readTimestamp = '2026-01-01T00:00:01.000Z'
    const parent = {
      readFileState: createFileStateCacheWithSizeLimit(10),
    }
    const child = {
      agentId: asAgentId('achild000000000901'),
      readFileState: createFileStateCacheWithSizeLimit(10),
    }

    noteFileWrite(child, file)

    const messages = [
      assistantToolUse('read-1', 'Read', {
        file_path: file,
      }),
      readResult('read-1', readTimestamp, '1\talpha\n2\tbeta'),
    ]

    parent.readFileState = restoreObservedReadFilesFromMessages(
      parent.readFileState,
      messages,
      dir,
      10,
    )

    const restored = parent.readFileState.get(file)
    expect(restored?.content).toBe('alpha\nbeta')
    expect(restored?.timestamp).toBe(new Date(readTimestamp).getTime())
    expect(restored?.registrySequence).toBeDefined()
    expect(wasFileModifiedAfterReadByAnotherContext(parent, file)).toBe(false)
  })

  test('TUI resume stamps an equivalent restored state that was already cached without a registry read', () => {
    const dir = tempDir()
    const file = join(dir, 'tui-resume-existing-read.txt')
    const readTimestamp = '2026-01-01T00:00:01.000Z'
    const parent = {
      readFileState: createFileStateCacheWithSizeLimit(10),
    }
    const child = {
      agentId: asAgentId('achild000000000902'),
      readFileState: createFileStateCacheWithSizeLimit(10),
    }

    parent.readFileState.set(file, {
      content: 'alpha\nbeta',
      timestamp: new Date(readTimestamp).getTime(),
      offset: undefined,
      limit: undefined,
    })
    noteFileWrite(child, file)

    parent.readFileState = restoreObservedReadFilesFromMessages(
      parent.readFileState,
      [
        assistantToolUse('read-1', 'Read', {
          file_path: file,
        }),
        readResult('read-1', readTimestamp, '1\talpha\n2\tbeta'),
      ],
      dir,
      10,
    )

    const restored = parent.readFileState.get(file)
    expect(restored?.content).toBe('alpha\nbeta')
    expect(restored?.timestamp).toBe(new Date(readTimestamp).getTime())
    expect(restored?.registrySequence).toBeDefined()
    expect(wasFileModifiedAfterReadByAnotherContext(parent, file)).toBe(false)
  })
})
