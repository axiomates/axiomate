import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import { fileStateHasFullContent } from '../../../utils/fileStateCache.js'
import { extractReadFilesFromMessages } from '../../../utils/queryHelpers.js'
import type { Message } from '../../../types/message.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
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

describe('extractReadFilesFromMessages file-state resume reconstruction', () => {
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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

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

    const cache = extractReadFilesFromMessages(messages, dir, 10)

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

    const cache = extractReadFilesFromMessages(messages, dir, 10)

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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta')
    expect(state?.offset).toBe(1)
    expect(state?.limit).toBe(10)
    expect(state?.totalLines).toBe(2)
    expect(state && fileStateHasFullContent(state)).toBe(true)
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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nBETA\n')
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:02.000Z').getTime(),
    )
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

    const cache = extractReadFilesFromMessages(messages, dir, 10)

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

    const state = extractReadFilesFromMessages(messages, dir, 10).get(file)

    expect(state?.content).toBe('alpha\nbeta')
    expect(state?.timestamp).toBe(
      new Date('2026-01-01T00:00:01.000Z').getTime(),
    )
  })
})
