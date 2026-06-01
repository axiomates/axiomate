import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../../../../tools/FileEditTool/constants.js'
import { asAgentId } from '../../../../types/ids.js'
import { cloneFileStateCache } from '../../../../utils/fileStateCache.js'
import { withFileStatePathLock } from '../../../../utils/fileStateRegistry.js'
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
  ;({ FileWriteTool } = await import(
    '../../../../tools/FileWriteTool/FileWriteTool.js'
  ))
  ;({ NotebookEditTool } = await import(
    '../../../../tools/NotebookEditTool/NotebookEditTool.js'
  ))
}, 120_000)

function createNotebook(source: string) {
  return {
    cells: [
      {
        cell_type: 'code',
        execution_count: 1,
        id: 'cell-a',
        metadata: {},
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'old\n' }],
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

async function readNotebookSource(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8')
  const content = raw.startsWith('\ufeff') ? raw.slice(1) : raw
  const notebook = JSON.parse(content) as ReturnType<
    typeof createNotebook
  >
  return String(notebook.cells[0]?.source ?? '')
}

async function readNotebookIntoContext(path: string) {
  const context = makeToolContext()
  await FileReadTool.call(
    { file_path: path },
    context,
    allowToolUse,
    parentMessage,
  )
  return context
}

async function editNotebookCell(
  path: string,
  source: string,
  context: ReturnType<typeof makeToolContext>,
) {
  return NotebookEditTool.call(
    {
      notebook_path: path,
      cell_id: 'cell-a',
      new_source: source,
      edit_mode: 'replace',
    },
    context,
    allowToolUse,
    parentMessage,
  )
}

describe('NotebookEditTool file harness behavior', () => {
  test('rejects editing a notebook that was not read first', async () => {
    const path = join(getHarnessCwd(), 'unread.ipynb')
    await writeNotebook(path, 'print("one")')

    const validation = await NotebookEditTool.validateInput!(
      {
        notebook_path: path,
        cell_id: 'cell-a',
        new_source: 'print("two")',
        edit_mode: 'replace',
      },
      makeToolContext(),
    )

    expectValidationFailure(validation)
    expect(validation.errorCode).toBe(9)
    expect(validation.message).toContain('File has not been read yet')
  })

  test('records notebook writes so later stale parent writes are blocked even if mtime is restored', async () => {
    const path = join(getHarnessCwd(), 'sibling-notebook.ipynb')
    await writeNotebook(path, 'print("one")')
    const parentContext = await readNotebookIntoContext(path)
    const originalTimestamp = parentContext.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000101'),
      readFileState: cloneFileStateCache(parentContext.readFileState),
    })
    await editNotebookCell(path, 'print("child")', childContext)
    const originalDate = new Date(originalTimestamp!)
    await utimes(path, originalDate, originalDate)
    expect(Math.floor((await stat(path)).mtimeMs)).toBe(originalTimestamp)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: JSON.stringify(createNotebook('parent')) },
      parentContext,
    )
    expectValidationFailure(validation)
    expect(validation.errorCode).toBe(3)
    expect(validation.message).toContain('modified since read')

    await expect(
      FileWriteTool.call(
        { file_path: path, content: JSON.stringify(createNotebook('parent')) },
        parentContext,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readNotebookSource(path)).toBe('print("child")')
  })

  test('rejects stale notebook edits after a sibling write even if mtime is restored', async () => {
    const path = join(getHarnessCwd(), 'stale-notebook-edit.ipynb')
    await writeNotebook(path, 'print("one")')
    const parentContext = await readNotebookIntoContext(path)
    const originalTimestamp = parentContext.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000102'),
      readFileState: cloneFileStateCache(parentContext.readFileState),
    })
    await editNotebookCell(path, 'print("child")', childContext)
    const originalDate = new Date(originalTimestamp!)
    await utimes(path, originalDate, originalDate)
    expect(Math.floor((await stat(path)).mtimeMs)).toBe(originalTimestamp)

    const validation = await NotebookEditTool.validateInput!(
      {
        notebook_path: path,
        cell_id: 'cell-a',
        new_source: 'print("parent")',
        edit_mode: 'replace',
      },
      parentContext,
    )
    expectValidationFailure(validation)
    expect(validation.errorCode).toBe(10)
    expect(validation.message).toContain('modified since read')

    await expect(
      editNotebookCell(path, 'print("parent")', parentContext),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readNotebookSource(path)).toBe('print("child")')
  })

  test('allows notebook edit when mtime changes but full-read content is unchanged', async () => {
    const path = join(getHarnessCwd(), 'mtime-only-notebook.ipynb')
    await writeNotebook(path, 'print("one")')
    const context = await readNotebookIntoContext(path)
    const originalTimestamp = context.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const touchedDate = new Date(originalTimestamp! + 2_000)
    await utimes(path, touchedDate, touchedDate)

    const validation = await NotebookEditTool.validateInput!(
      {
        notebook_path: path,
        cell_id: 'cell-a',
        new_source: 'print("two")',
        edit_mode: 'replace',
      },
      context,
    )
    expect(validation.result).toBe(true)

    await editNotebookCell(path, 'print("two")', context)

    expect(await readNotebookSource(path)).toBe('print("two")')
  })

  test('still rejects notebook mtime drift after partial read state', async () => {
    const path = join(getHarnessCwd(), 'partial-mtime-notebook.ipynb')
    await writeNotebook(path, 'print("one")')
    const context = await readNotebookIntoContext(path)
    const fullState = context.readFileState.get(path)
    expect(fullState).toBeDefined()
    context.readFileState.set(path, {
      ...fullState!,
      offset: 1,
      limit: 10,
      isPartialView: true,
    })

    const touchedDate = new Date(fullState!.timestamp + 2_000)
    await utimes(path, touchedDate, touchedDate)

    const validation = await NotebookEditTool.validateInput!(
      {
        notebook_path: path,
        cell_id: 'cell-a',
        new_source: 'print("two")',
        edit_mode: 'replace',
      },
      context,
    )
    expectValidationFailure(validation)
    expect(validation.errorCode).toBe(10)
    expect(validation.fileHarnessFailure).toMatchObject({
      reason: 'stale_mtime',
      phase: 'validation',
      path,
    })

    await expect(
      editNotebookCell(path, 'print("two")', context),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readNotebookSource(path)).toBe('print("one")')
  })

  test('call waits for the same-path file state lock before final stale check and write', async () => {
    const path = join(getHarnessCwd(), 'locked-notebook.ipynb')
    await writeNotebook(path, 'print("one")')
    const context = await readNotebookIntoContext(path)

    let releaseLock!: () => void
    const lockMayRelease = new Promise<void>(resolve => {
      releaseLock = resolve
    })
    const lockHolder = withFileStatePathLock(path, async () => {
      await lockMayRelease
    })

    let editSettled = false
    const editAttempt = editNotebookCell(
      path,
      'print("two")',
      context,
    ).finally(() => {
      editSettled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(editSettled).toBe(false)
    expect(await readNotebookSource(path)).toBe('print("one")')

    releaseLock()
    await lockHolder
    await editAttempt

    expect(await readNotebookSource(path)).toBe('print("two")')
  })

  test('preserves an existing UTF-8 BOM when editing a notebook', async () => {
    const path = join(getHarnessCwd(), 'bom-notebook.ipynb')
    await writeFile(path, `\ufeff${JSON.stringify(createNotebook('print("one")'), null, 1)}`, 'utf8')
    const context = await readNotebookIntoContext(path)

    await editNotebookCell(path, 'print("two")', context)

    const raw = await readFile(path)
    expect(raw[0]).toBe(0xef)
    expect(raw[1]).toBe(0xbb)
    expect(raw[2]).toBe(0xbf)
    expect(await readNotebookSource(path)).toBe('print("two")')
  })
})
