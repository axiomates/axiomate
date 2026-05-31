import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { createFileStateCacheWithSizeLimit } from '../../../../utils/fileStateCache.js'
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
let FileEditTool: Awaited<
  typeof import('../../../../tools/FileEditTool/FileEditTool.js')
>['FileEditTool']

beforeAll(async () => {
  ;[{ FileReadTool }, { FileEditTool }] = await Promise.all([
    import('../../../../tools/FileReadTool/FileReadTool.js'),
    import('../../../../tools/FileEditTool/FileEditTool.js'),
  ])
}, 60_000)

async function loadFileTools() {
  return { FileReadTool, FileEditTool }
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

describe('FileEditTool file harness behavior', () => {
  test('rejects editing an existing file that was not read first', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'unread.txt')
    await writeFile(path, 'alpha\n', 'utf8')

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'alpha', new_string: 'beta' },
      makeToolContext(),
    )

    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(6)
    expect(result.message).toContain('File has not been read yet')
  })

  test('rejects manually marked partial-view read state before edit', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'partial.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const stats = await stat(path)
    const readFileState = createFileStateCacheWithSizeLimit(10)
    readFileState.set(path, {
      content: 'alpha\n',
      timestamp: Math.floor(stats.mtimeMs),
      offset: 1,
      limit: 1,
      isPartialView: true,
    })

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'alpha', new_string: 'ALPHA' },
      makeToolContext({ readFileState }),
    )

    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(6)
    expect(result.message).toContain('File has not been read yet')
  })

  test('range Read currently seeds readFileState without isPartialView', async () => {
    const { FileReadTool, FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'range-current.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path, offset: 1, limit: 1 },
      context,
      allowToolUse,
      parentMessage,
    )

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'alpha', new_string: 'ALPHA' },
      context,
    )

    expect(context.readFileState.get(path)?.isPartialView).toBeUndefined()
    expect(result.result).toBe(true)
  })

  test('edits a fully read file and updates readFileState', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'edit.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const validation = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )
    expect(validation.result).toBe(true)

    const result = await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(result.data.filePath).toBe(path)
    expect(await readFile(path, 'utf8')).toBe('alpha\nBETA\n')
    expect(context.readFileState.get(path)?.content).toBe('alpha\nBETA\n')
    expect(context.readFileState.get(path)?.offset).toBeUndefined()
  })

  test('preserves CRLF line endings when editing an existing CRLF file', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'crlf.txt')
    await writeFile(path, 'alpha\r\nbeta\r\n', 'utf8')
    const context = await readIntoContext(path)

    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )

    const raw = await readFile(path)
    expect(raw.toString('utf8')).toBe('alpha\r\nBETA\r\n')
    expect(raw.includes(Buffer.from('\n'))).toBe(true)
    expect(raw.includes(Buffer.from('\r\n'))).toBe(true)
    expect(raw.toString('utf8').replaceAll('\r\n', '')).not.toContain('\n')
  })

  test('rejects mtime-only drift when readFileState came from Read', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mtime-only.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )

    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(7)
    expect(result.message).toContain('modified since read')
  })

  test('allows mtime-only drift after edit-updated full-file state', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mtime-after-edit.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'BETA', new_string: 'beta' },
      context,
    )

    expect(context.readFileState.get(path)?.offset).toBeUndefined()
    expect(result.result).toBe(true)
  })

  test('rejects stale content after external modification', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'stale.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)
    await writeFile(path, 'alpha\nchanged\n', 'utf8')
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )

    expect(result.result).toBe(false)
    if (result.result) return
    expect(result.errorCode).toBe(7)
    expect(result.message).toContain('modified since read')
  })

  test('reports string-not-found and multiple-match validation errors', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'matches.txt')
    await writeFile(path, 'alpha\nbeta\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const missing = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'gamma', new_string: 'GAMMA' },
      context,
    )
    expect(missing.result).toBe(false)
    if (!missing.result) expect(missing.errorCode).toBe(8)

    const ambiguous = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )
    expect(ambiguous.result).toBe(false)
    if (!ambiguous.result) expect(ambiguous.errorCode).toBe(9)
  })
})
