import { stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { asAgentId } from '../../../../types/ids.js'
import { cloneFileStateCache } from '../../../../utils/fileStateCache.js'
import {
  allowToolUse,
  expectValidationFailure,
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
let FileWriteTool: Awaited<
  typeof import('../../../../tools/FileWriteTool/FileWriteTool.js')
>['FileWriteTool']
let NotebookEditTool: Awaited<
  typeof import('../../../../tools/NotebookEditTool/NotebookEditTool.js')
>['NotebookEditTool']

beforeAll(async () => {
  ;({ FileReadTool } = await import(
    '../../../../tools/FileReadTool/FileReadTool.js'
  ))
  ;({ FileEditTool } = await import(
    '../../../../tools/FileEditTool/FileEditTool.js'
  ))
  ;({ FileWriteTool } = await import(
    '../../../../tools/FileWriteTool/FileWriteTool.js'
  ))
  ;({ NotebookEditTool } = await import(
    '../../../../tools/NotebookEditTool/NotebookEditTool.js'
  ))
}, 120_000)

async function readIntoContext(path: string) {
  const context = makeToolContext()
  await FileReadTool.call(
    { file_path: path },
    context,
    allowToolUse,
    parentMessage,
  )
  return context
}

function createNotebook(source: string) {
  return {
    cells: [
      {
        cell_type: 'code',
        execution_count: 1,
        id: 'cell-a',
        metadata: {},
        outputs: [],
        source,
      },
    ],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

async function writeNotebook(path: string, source: string): Promise<void> {
  await writeFile(path, JSON.stringify(createNotebook(source), null, 1), 'utf8')
}

describe('FileHarness failure metadata', () => {
  test('marks unread existing FileWrite validation as not_read without changing message or error code', async () => {
    const path = join(getHarnessCwd(), 'write-unread.txt')
    await writeFile(path, 'alpha\n', 'utf8')

    const result = await FileWriteTool.validateInput!(
      { file_path: path, content: 'beta\n' },
      makeToolContext(),
    )

    expectValidationFailure(result)
    expect(result.errorCode).toBe(2)
    expect(result.message).toBe(
      'File has not been read yet. Read it first before writing to it.',
    )
    expect(result.fileHarnessFailure?.reason).toBe('not_read')
    expect(result.fileHarnessFailure?.phase).toBe('validation')
    expect(result.fileHarnessFailure?.path).toBe(path)
  })

  test('marks partial-view FileWrite validation as partial_read_for_write', async () => {
    const path = join(getHarnessCwd(), 'write-partial.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
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

    expectValidationFailure(result)
    expect(result.errorCode).toBe(2)
    expect(result.fileHarnessFailure?.reason).toBe('partial_read_for_write')
  })

  test('marks sibling FileEdit validation as sibling_write_after_read', async () => {
    const path = join(getHarnessCwd(), 'edit-sibling.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const parentContext = await readIntoContext(path)
    const originalTimestamp = parentContext.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000201'),
      readFileState: cloneFileStateCache(parentContext.readFileState),
    })
    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'child' },
      childContext,
      allowToolUse,
      parentMessage,
    )
    const originalDate = new Date(originalTimestamp!)
    await utimes(path, originalDate, originalDate)
    expect(Math.floor((await stat(path)).mtimeMs)).toBe(originalTimestamp)

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'alpha', new_string: 'ALPHA' },
      parentContext,
    )

    expectValidationFailure(result)
    expect(result.errorCode).toBe(7)
    expect(result.fileHarnessFailure?.reason).toBe('sibling_write_after_read')
  })

  test('marks external stale FileEdit validation as stale_content', async () => {
    const path = join(getHarnessCwd(), 'edit-stale-content.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)
    await writeFile(path, 'alpha\nchanged\n', 'utf8')
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )

    expectValidationFailure(result)
    expect(result.errorCode).toBe(7)
    expect(result.fileHarnessFailure?.reason).toBe('stale_content')
  })

  test('marks partial-read mtime drift FileEdit validation as stale_mtime', async () => {
    const path = join(getHarnessCwd(), 'edit-stale-partial.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = makeToolContext()
    await FileReadTool.call(
      { file_path: path, offset: 2, limit: 1 },
      context,
      allowToolUse,
      parentMessage,
    )
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )

    expectValidationFailure(result)
    expect(result.errorCode).toBe(7)
    expect(result.fileHarnessFailure?.reason).toBe('stale_mtime')
  })

  test('marks FileEdit match failures as string_not_found and multiple_match', async () => {
    const path = join(getHarnessCwd(), 'edit-matches.txt')
    await writeFile(path, 'alpha\nbeta\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const missing = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'gamma', new_string: 'GAMMA' },
      context,
    )
    expectValidationFailure(missing)
    expect(missing.errorCode).toBe(8)
    expect(missing.fileHarnessFailure?.reason).toBe('string_not_found')

    const ambiguous = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )
    expectValidationFailure(ambiguous)
    expect(ambiguous.errorCode).toBe(9)
    expect(ambiguous.fileHarnessFailure?.reason).toBe('multiple_match')
  })

  test('marks unread NotebookEdit validation as not_read', async () => {
    const path = join(getHarnessCwd(), 'notebook-unread.ipynb')
    await writeNotebook(path, 'print("one")')

    const result = await NotebookEditTool.validateInput!(
      {
        notebook_path: path,
        cell_id: 'cell-a',
        new_source: 'print("two")',
        edit_mode: 'replace',
      },
      makeToolContext(),
    )

    expectValidationFailure(result)
    expect(result.errorCode).toBe(9)
    expect(result.fileHarnessFailure?.reason).toBe('not_read')
    expect(result.fileHarnessFailure?.path).toBe(path)
  })
})
