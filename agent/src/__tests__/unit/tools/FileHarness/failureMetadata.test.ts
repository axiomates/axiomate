import { stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../../../../tools/FileEditTool/constants.js'
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

const PARTIAL_READ_FOR_WRITE_ERROR =
  'File was only partially read. Read the whole file before writing to it, or use Edit for a targeted change.'

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

async function expectFileHarnessRejection(
  promise: Promise<unknown>,
  expectedMessage = FILE_UNEXPECTEDLY_MODIFIED_ERROR,
): Promise<Error & {
  fileHarnessFailure?: {
    reason?: string
    phase?: string
    path?: string
  }
}> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    const typed = error as Error & {
      fileHarnessFailure?: {
        reason?: string
        phase?: string
        path?: string
      }
    }
    expect(typed.message).toBe(expectedMessage)
    return typed
  }
  throw new Error('Expected FileHarness call to reject')
}

type FailedValidationResult = {
  result: false
  meta?: Record<string, unknown>
}

function expectEditEscalation(
  result: FailedValidationResult,
  expected: {
    reason: string
    count: number
    level: string
  },
): void {
  expect(result.meta?.fileEditFailureEscalation).toMatchObject(expected)
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

  test('escalates repeated FileEdit string_not_found failures on the same read snapshot', async () => {
    const path = join(getHarnessCwd(), 'edit-escalate-missing.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const first = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'gamma', new_string: 'GAMMA' },
      context,
    )
    expectValidationFailure(first)
    expect(first.errorCode).toBe(8)
    expect(first.message).toBe('String to replace not found in file.\nString: gamma')
    expectEditEscalation(first, {
      reason: 'string_not_found',
      count: 1,
      level: 'none',
    })

    const second = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'delta', new_string: 'DELTA' },
      context,
    )
    expectValidationFailure(second)
    expect(second.errorCode).toBe(8)
    expect(second.message).toBe('String to replace not found in file.\nString: delta')
    expectEditEscalation(second, {
      reason: 'string_not_found',
      count: 2,
      level: 'reread',
    })
  })

  test('resets FileEdit match failure escalation after a valid edit validation', async () => {
    const path = join(getHarnessCwd(), 'edit-escalate-reset.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const first = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'gamma', new_string: 'GAMMA' },
      context,
    )
    expectValidationFailure(first)
    expectEditEscalation(first, {
      reason: 'string_not_found',
      count: 1,
      level: 'none',
    })

    const valid = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )
    expect(valid.result).toBe(true)

    const afterReset = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'delta', new_string: 'DELTA' },
      context,
    )
    expectValidationFailure(afterReset)
    expectEditEscalation(afterReset, {
      reason: 'string_not_found',
      count: 1,
      level: 'none',
    })
  })

  test('escalates repeated FileEdit multiple_match failures independently', async () => {
    const path = join(getHarnessCwd(), 'edit-escalate-multiple.txt')
    await writeFile(path, 'alpha\nbeta\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const first = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )
    expectValidationFailure(first)
    expect(first.errorCode).toBe(9)
    expectEditEscalation(first, {
      reason: 'multiple_match',
      count: 1,
      level: 'none',
    })

    const second = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )
    expectValidationFailure(second)
    expect(second.errorCode).toBe(9)
    expectEditEscalation(second, {
      reason: 'multiple_match',
      count: 2,
      level: 'reread',
    })
  })

  test('resets FileEdit match failure escalation after a content-changing re-read', async () => {
    // B11: the consecutive-failure counter keys on the read-state object
    // identity. A re-read that yields new content replaces that object, so the
    // next match failure restarts at 1 — even though a plain Read does not call
    // clearFileEditMatchFailure. (An unchanged-content re-read hits dedup and
    // keeps the same object, so it intentionally does NOT reset.)
    const path = join(getHarnessCwd(), 'edit-escalate-reset-reread.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const first = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'gamma', new_string: 'GAMMA' },
      context,
    )
    expectValidationFailure(first)
    expectEditEscalation(first, {
      reason: 'string_not_found',
      count: 1,
      level: 'none',
    })

    const second = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'gamma', new_string: 'GAMMA' },
      context,
    )
    expectValidationFailure(second)
    expectEditEscalation(second, {
      reason: 'string_not_found',
      count: 2,
      level: 'reread',
    })

    // A content-changing re-read replaces the read-state object identity.
    await writeFile(path, 'alpha\nbeta\ndelta\n', 'utf8')
    await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )

    const afterReread = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'gamma', new_string: 'GAMMA' },
      context,
    )
    expectValidationFailure(afterReread)
    expectEditEscalation(afterReread, {
      reason: 'string_not_found',
      count: 1,
      level: 'none',
    })
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

  test('marks execution-time FileWrite stale content as stale_content while preserving error text', async () => {
    const path = join(getHarnessCwd(), 'write-execution-stale.txt')
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

    const error = await expectFileHarnessRejection(
      FileWriteTool.call(
        { file_path: path, content: 'beta\n' },
        context,
        allowToolUse,
        parentMessage,
      ),
    )
    expect(error.fileHarnessFailure?.reason).toBe('stale_content')
    expect(error.fileHarnessFailure?.phase).toBe('execution')
    expect(error.fileHarnessFailure?.path).toBe(path)
  })

  test('marks execution-time FileWrite partial read as partial_read_for_write', async () => {
    const path = join(getHarnessCwd(), 'write-execution-partial.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'replacement\n' },
      context,
    )
    expect(validation.result).toBe(true)
    context.readFileState.set(path, {
      content: 'alpha\n',
      timestamp: context.readFileState.get(path)!.timestamp,
      offset: 1,
      limit: 1,
      isPartialView: true,
    })

    const error = await expectFileHarnessRejection(
      FileWriteTool.call(
        { file_path: path, content: 'replacement\n' },
        context,
        allowToolUse,
        parentMessage,
      ),
      PARTIAL_READ_FOR_WRITE_ERROR,
    )
    expect(error.fileHarnessFailure?.reason).toBe('partial_read_for_write')
    expect(error.fileHarnessFailure?.phase).toBe('execution')
    expect(error.fileHarnessFailure?.path).toBe(path)
  })

  test('marks execution-time FileEdit stale content as stale_content', async () => {
    const path = join(getHarnessCwd(), 'edit-execution-stale.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    const validation = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )
    expect(validation.result).toBe(true)

    await writeFile(path, 'alpha\nchanged\n', 'utf8')
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const error = await expectFileHarnessRejection(
      FileEditTool.call(
        { file_path: path, old_string: 'beta', new_string: 'BETA' },
        context,
        allowToolUse,
        parentMessage,
      ),
    )
    expect(error.fileHarnessFailure?.reason).toBe('stale_content')
    expect(error.fileHarnessFailure?.phase).toBe('execution')
    expect(error.fileHarnessFailure?.path).toBe(path)
  })

  test('marks execution-time NotebookEdit sibling write as sibling_write_after_read', async () => {
    const path = join(getHarnessCwd(), 'notebook-execution-sibling.ipynb')
    await writeNotebook(path, 'print("one")')
    const parentContext = await readIntoContext(path)
    const originalTimestamp = parentContext.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const validation = await NotebookEditTool.validateInput!(
      {
        notebook_path: path,
        cell_id: 'cell-a',
        new_source: 'print("parent")',
        edit_mode: 'replace',
      },
      parentContext,
    )
    expect(validation.result).toBe(true)

    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000301'),
      readFileState: cloneFileStateCache(parentContext.readFileState),
    })
    await NotebookEditTool.call(
      {
        notebook_path: path,
        cell_id: 'cell-a',
        new_source: 'print("child")',
        edit_mode: 'replace',
      },
      childContext,
      allowToolUse,
      parentMessage,
    )
    const originalDate = new Date(originalTimestamp!)
    await utimes(path, originalDate, originalDate)

    const error = await expectFileHarnessRejection(
      NotebookEditTool.call(
        {
          notebook_path: path,
          cell_id: 'cell-a',
          new_source: 'print("parent")',
          edit_mode: 'replace',
        },
        parentContext,
        allowToolUse,
        parentMessage,
      ),
    )
    expect(error.fileHarnessFailure?.reason).toBe('sibling_write_after_read')
    expect(error.fileHarnessFailure?.phase).toBe('execution')
    expect(error.fileHarnessFailure?.path).toBe(path)
  })
})
