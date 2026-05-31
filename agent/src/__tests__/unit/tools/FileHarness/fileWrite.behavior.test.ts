import { chmod, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../../../../tools/FileEditTool/constants.js'
import { FILE_UNCHANGED_STUB } from '../../../../tools/FileReadTool/prompt.js'
import { asAgentId } from '../../../../types/ids.js'
import { cloneFileStateCache } from '../../../../utils/fileStateCache.js'
import {
  allowToolUse,
  getHarnessCwd,
  makeToolContext,
  mockFileHarnessRuntime,
  parentMessage,
  setupFileHarness,
} from './helpers.js'

mockFileHarnessRuntime()
setupFileHarness()

let FileReadTool: Awaited<
  typeof import('../../../../tools/FileReadTool/FileReadTool.js')
>['FileReadTool']
let FileWriteTool: Awaited<
  typeof import('../../../../tools/FileWriteTool/FileWriteTool.js')
>['FileWriteTool']

beforeAll(async () => {
  ;({ FileReadTool } = await import(
    '../../../../tools/FileReadTool/FileReadTool.js'
  ))
  ;({ FileWriteTool } = await import(
    '../../../../tools/FileWriteTool/FileWriteTool.js'
  ))
}, 120_000)

async function loadFileTools() {
  return { FileReadTool, FileWriteTool }
}

async function readIntoContext(path: string) {
  const { FileReadTool } = await loadFileTools()
  const context = makeToolContext()
  await FileReadTool.call(
    { file_path: path },
    context,
    allowToolUse,
    parentMessage,
  )
  return context
}

describe('FileWriteTool file harness behavior', () => {
  test('validateInput rejects writing the internal unchanged-read stub', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'stub-write.txt')
    const result = await FileWriteTool.validateInput!(
      { file_path: path, content: FILE_UNCHANGED_STUB },
      makeToolContext(),
    )

    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(4)
    expect(result.message).toContain('internal Read status text')
  })

  test('call rejects writing the internal unchanged-read stub before touching disk', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'stub-write-call.txt')

    await expect(
      FileWriteTool.call(
        { file_path: path, content: FILE_UNCHANGED_STUB },
        makeToolContext(),
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow('internal Read status text')
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  test('validateInput rejects short wrapper content around the internal unchanged-read stub', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'stub-wrapper.txt')
    const wrapped = `Note: ${FILE_UNCHANGED_STUB}\n\n(continuing.)`

    const result = await FileWriteTool.validateInput!(
      { file_path: path, content: wrapped },
      makeToolContext(),
    )

    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(4)
    expect(result.message).toContain('internal Read status text')
  })

  test('allows normal file content that quotes the unchanged-read stub', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'stub-doc.txt')
    const content = [
      '# Notes',
      '',
      'This document quotes an internal status message as an example:',
      '',
      `    ${FILE_UNCHANGED_STUB}`,
      '',
      'The rest of this file is real documentation content. '.repeat(20),
    ].join('\n')
    const context = makeToolContext()

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content },
      context,
    )
    expect(validation.result).toBe(true)

    await FileWriteTool.call(
      { file_path: path, content },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(await readFile(path, 'utf8')).toBe(content)
  })

  test('rejects overwriting an existing file that was not read first', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'unread.txt')
    await writeFile(path, 'alpha\n', 'utf8')

    const result = await FileWriteTool.validateInput!(
      { file_path: path, content: 'beta\n' },
      makeToolContext(),
    )

    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(2)
    expect(result.message).toContain('File has not been read yet')
  })

  test('creates a new file without requiring a prior read', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'nested', 'created.txt')
    const context = makeToolContext()

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'created\n' },
      context,
    )
    expect(validation.result).toBe(true)

    const result = await FileWriteTool.call(
      { file_path: path, content: 'created\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(result.data.type).toBe('create')
    expect(result.data.originalFile).toBeNull()
    expect(await readFile(path, 'utf8')).toBe('created\n')
    expect(context.readFileState.get(path)?.content).toBe('created\n')
    expect(context.readFileState.get(path)?.offset).toBeUndefined()
    expect(context.readFileState.get(path)?.limit).toBeUndefined()
  })

  test('overwrites a fully read file and updates readFileState', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'write.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'gamma\n' },
      context,
    )
    expect(validation.result).toBe(true)

    const result = await FileWriteTool.call(
      { file_path: path, content: 'gamma\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(result.data.type).toBe('update')
    expect(result.data.originalFile).toBe('alpha\nbeta\n')
    expect(await readFile(path, 'utf8')).toBe('gamma\n')
    expect(context.readFileState.get(path)?.content).toBe('gamma\n')
    expect(context.readFileState.get(path)?.offset).toBeUndefined()
    expect(context.readFileState.get(path)?.limit).toBeUndefined()
  })

  test('rejects overwriting after a range Read because readFileState is partial', async () => {
    const { FileReadTool, FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'range-write.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path, offset: 2, limit: 1 },
      context,
      allowToolUse,
      parentMessage,
    )

    const result = await FileWriteTool.validateInput!(
      { file_path: path, content: 'replacement\n' },
      context,
    )

    expect(context.readFileState.get(path)?.isPartialView).toBe(true)
    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(2)
    expect(result.message).toContain('File has not been read yet')
  })

  test('call rejects overwriting after a range Read before touching disk', async () => {
    const { FileReadTool, FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'range-write-call.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path, offset: 2, limit: 1 },
      context,
      allowToolUse,
      parentMessage,
    )

    await expect(
      FileWriteTool.call(
        { file_path: path, content: 'replacement\n' },
        context,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readFile(path, 'utf8')).toBe('alpha\nbeta\ngamma\n')
  })

  test('uses the provided LF line endings when overwriting a CRLF file', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'crlf-write.txt')
    await writeFile(path, 'alpha\r\nbeta\r\n', 'utf8')
    const context = await readIntoContext(path)

    await FileWriteTool.call(
      { file_path: path, content: 'one\nTWO\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    const raw = await readFile(path)
    expect(raw.toString('utf8')).toBe('one\nTWO\n')
    expect(raw.includes(Buffer.from('\r\n'))).toBe(false)
  })

  test('validateInput allows mtime-only drift when readFileState came from full Read', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mtime-only-write.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = await readIntoContext(path)
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'beta\n' },
      context,
    )
    expect(context.readFileState.get(path)?.offset).toBe(1)
    expect(validation.result).toBe(true)
  })

  test('call allows mtime-only drift when readFileState came from full Read', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mtime-only-write-call.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = await readIntoContext(path)

    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    await FileWriteTool.call(
      { file_path: path, content: 'beta\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(context.readFileState.get(path)?.offset).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe('beta\n')
  })

  test('rejects overwriting after a sibling subagent writes even if mtime is unchanged', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'sibling-write.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const parentContext = await readIntoContext(path)
    const originalTimestamp = parentContext.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000002'),
      readFileState: cloneFileStateCache(parentContext.readFileState),
    })
    await FileWriteTool.call(
      { file_path: path, content: 'child\n' },
      childContext,
      allowToolUse,
      parentMessage,
    )
    const originalDate = new Date(originalTimestamp!)
    await utimes(path, originalDate, originalDate)
    expect(Math.floor((await stat(path)).mtimeMs)).toBe(originalTimestamp)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'parent\n' },
      parentContext,
    )
    expect(validation.result).toBe(false)
    if (!validation.result) {
      expect(validation.errorCode).toBe(3)
      expect(validation.message).toContain('modified since read')
    }

    await expect(
      FileWriteTool.call(
        { file_path: path, content: 'parent\n' },
        parentContext,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readFile(path, 'utf8')).toBe('child\n')
  })

  test('call allows mtime-only drift after write-updated full-file state', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mtime-after-write.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = await readIntoContext(path)

    await FileWriteTool.call(
      { file_path: path, content: 'beta\n' },
      context,
      allowToolUse,
      parentMessage,
    )
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    await FileWriteTool.call(
      { file_path: path, content: 'gamma\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(context.readFileState.get(path)?.offset).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe('gamma\n')
  })

  test('validateInput rejects stale content after external modification', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'stale-write.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = await readIntoContext(path)
    await writeFile(path, 'changed\n', 'utf8')
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const result = await FileWriteTool.validateInput!(
      { file_path: path, content: 'beta\n' },
      context,
    )

    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(3)
    expect(result.message).toContain('modified since read')
  })

  test('call rejects stale content changed after validation', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'stale-after-validation.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = await readIntoContext(path)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'beta\n' },
      context,
    )
    expect(validation.result).toBe(true)

    await writeFile(path, 'changed\n', 'utf8')
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    await expect(
      FileWriteTool.call(
        { file_path: path, content: 'beta\n' },
        context,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
  })

  test('successful overwrite cleans up its atomic temp file', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'temp-cleanup.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = await readIntoContext(path)

    await FileWriteTool.call(
      { file_path: path, content: 'beta\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    const entries = await readdir(dirname(path))
    expect(
      entries.filter(name => name.startsWith(`${basename(path)}.tmp.`)),
    ).toEqual([])
  })

  test('preserves POSIX mode when overwriting an existing file', async () => {
    if (process.platform === 'win32') {
      return
    }

    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mode.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    await chmod(path, 0o744)
    const context = await readIntoContext(path)

    await FileWriteTool.call(
      { file_path: path, content: 'beta\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect((await stat(path)).mode & 0o777).toBe(0o744)
  })
})
