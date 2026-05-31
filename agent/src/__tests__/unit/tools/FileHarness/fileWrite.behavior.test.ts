import { chmod, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../../../../tools/FileEditTool/constants.js'
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
}, 60_000)

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

  test('call rejects mtime-only drift when readFileState came from Read', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mtime-only-write.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = await readIntoContext(path)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'beta\n' },
      context,
    )
    expect(validation.result).toBe(true)

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
