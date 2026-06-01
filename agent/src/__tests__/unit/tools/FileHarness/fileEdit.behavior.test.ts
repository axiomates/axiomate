import {
  mkdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../../../../tools/FileEditTool/constants.js'
import { asAgentId } from '../../../../types/ids.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
} from '../../../../utils/fileStateCache.js'
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
let FileEditTool: Awaited<
  typeof import('../../../../tools/FileEditTool/FileEditTool.js')
>['FileEditTool']

beforeAll(async () => {
  ;[{ FileReadTool }, { FileEditTool }] = await Promise.all([
    import('../../../../tools/FileReadTool/FileReadTool.js'),
    import('../../../../tools/FileEditTool/FileEditTool.js'),
  ])
}, 120_000)

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

async function createSymlinkAliasFile(name: string) {
  const realDir = join(getHarnessCwd(), `${name}-real`)
  const linkDir = join(getHarnessCwd(), `${name}-link`)
  await mkdir(realDir, { recursive: true })
  try {
    await symlink(
      realDir,
      linkDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  } catch {
    return null
  }

  return {
    realPath: join(realDir, 'target.txt'),
    linkPath: join(linkDir, 'target.txt'),
  }
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

    expectValidationFailure(result)
    expect(result.errorCode).toBe(6)
    expect(result.message).toContain('File has not been read yet')
  })

  test('allows manually marked partial-view read state before precise edit when file is unchanged', async () => {
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

    expect(result.result).toBe(true)
  })

  test('allows editing after a range Read because Edit applies a precise replacement to current disk content', async () => {
    const { FileReadTool, FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'range-edit.txt')
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

    expect(context.readFileState.get(path)?.isPartialView).toBe(true)
    expect(result.result).toBe(true)
  })

  test('call allows editing after a range Read and updates readFileState to full post-edit content', async () => {
    const { FileReadTool, FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'range-edit-call.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path, offset: 2, limit: 1 },
      context,
      allowToolUse,
      parentMessage,
    )

    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(await readFile(path, 'utf8')).toBe('alpha\nBETA\ngamma\n')
    expect(context.readFileState.get(path)?.content).toBe(
      'alpha\nBETA\ngamma\n',
    )
    expect(context.readFileState.get(path)?.offset).toBeUndefined()
  })

  test('rejects editing after a range Read when the file mtime changed', async () => {
    const { FileReadTool, FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'range-edit-stale.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path, offset: 2, limit: 1 },
      context,
      allowToolUse,
      parentMessage,
    )
    await writeFile(path, 'alpha\nchanged\ngamma\n', 'utf8')
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'changed', new_string: 'CHANGED' },
      context,
    )
    expectValidationFailure(result)
    expect(result.errorCode).toBe(7)
    expect(result.message).toContain('modified since read')

    await expect(
      FileEditTool.call(
        { file_path: path, old_string: 'changed', new_string: 'CHANGED' },
        context,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readFile(path, 'utf8')).toBe('alpha\nchanged\ngamma\n')
  })

  test('allows partial-read edit after a sibling write that happened before the partial Read', async () => {
    const { FileReadTool, FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'sibling-before-partial.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const seedContext = await readIntoContext(path)
    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000004'),
      readFileState: cloneFileStateCache(seedContext.readFileState),
    })
    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'child' },
      childContext,
      allowToolUse,
      parentMessage,
    )

    const parentContext = makeToolContext()
    await FileReadTool.call(
      { file_path: path, offset: 2, limit: 1 },
      parentContext,
      allowToolUse,
      parentMessage,
    )

    const validation = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'child', new_string: 'CHILD' },
      parentContext,
    )
    expect(validation.result).toBe(true)

    await FileEditTool.call(
      { file_path: path, old_string: 'child', new_string: 'CHILD' },
      parentContext,
      allowToolUse,
      parentMessage,
    )
    expect(await readFile(path, 'utf8')).toBe('alpha\nCHILD\n')
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

  test('preserves the majority line ending style when editing mixed line endings', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mixed-majority-crlf.txt')
    await writeFile(path, 'alpha\r\nbeta\r\ngamma\n', 'utf8')
    const context = await readIntoContext(path)

    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(await readFile(path, 'utf8')).toBe('alpha\r\nBETA\r\ngamma\r\n')
  })

  test('defaults tied mixed line endings to LF when editing', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mixed-tie-lf.txt')
    await writeFile(path, 'alpha\r\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(await readFile(path, 'utf8')).toBe('alpha\nBETA\n')
  })

  test('preserves existing UTF-8 BOM when editing', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'bom-edit.txt')
    await writeFile(path, '\ufeffalpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )

    const raw = await readFile(path)
    expect(raw[0]).toBe(0xef)
    expect(raw[1]).toBe(0xbb)
    expect(raw[2]).toBe(0xbf)
    expect(raw.toString('utf8')).toBe('\ufeffalpha\nBETA\n')
    expect(context.readFileState.get(path)?.content).toBe('alpha\nBETA\n')
  })

  test('preserves existing UTF-16LE BOM encoding when editing', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'utf16-bom-edit.txt')
    await writeFile(path, Buffer.from('\ufeffalpha\nbeta\n', 'utf16le'))
    const context = await readIntoContext(path)

    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )

    const raw = await readFile(path)
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    expect(raw.toString('utf16le')).toBe('\ufeffalpha\nBETA\n')
    expect(context.readFileState.get(path)?.content).toBe('alpha\nBETA\n')
  })

  test('allows mtime-only drift when readFileState came from full Read', async () => {
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

    expect(context.readFileState.get(path)?.offset).toBe(1)
    expect(result.result).toBe(true)
  })

  test('allows mtime-only drift for a BOM file after full Read', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'bom-mtime-only-edit.txt')
    await writeFile(path, '\ufeffalpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const result = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )

    expect(context.readFileState.get(path)?.content).toBe('alpha\nbeta\n')
    expect(result.result).toBe(true)
  })

  test('call allows mtime-only drift when readFileState came from full Read', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mtime-only-call.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    await FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(context.readFileState.get(path)?.offset).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe('alpha\nBETA\n')
  })

  test('rejects editing after a sibling subagent writes even if mtime is unchanged', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'sibling-edit.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const parentContext = await readIntoContext(path)
    const originalTimestamp = parentContext.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000001'),
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

    const validation = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'alpha', new_string: 'ALPHA' },
      parentContext,
    )
    expectValidationFailure(validation)
    expect(validation.errorCode).toBe(7)
    expect(validation.message).toContain('modified since read')

    await expect(
      FileEditTool.call(
        { file_path: path, old_string: 'alpha', new_string: 'ALPHA' },
        parentContext,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readFile(path, 'utf8')).toBe('alpha\nchild\n')
  })

  test('rejects editing after a sibling writes through a symlink alias', async () => {
    const { FileEditTool } = await loadFileTools()
    const alias = await createSymlinkAliasFile('sibling-alias-edit')
    if (!alias) return

    await writeFile(alias.realPath, 'alpha\nbeta\n', 'utf8')
    const parentContext = await readIntoContext(alias.linkPath)
    const originalTimestamp = parentContext.readFileState.get(
      alias.linkPath,
    )?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = await readIntoContext(alias.realPath)
    childContext.agentId = asAgentId('achild000000000307')
    await FileEditTool.call(
      { file_path: alias.realPath, old_string: 'beta', new_string: 'child' },
      childContext,
      allowToolUse,
      parentMessage,
    )

    const originalDate = new Date(originalTimestamp!)
    await utimes(alias.realPath, originalDate, originalDate)
    expect(Math.floor((await stat(alias.realPath)).mtimeMs)).toBe(
      originalTimestamp,
    )

    const validation = await FileEditTool.validateInput!(
      { file_path: alias.linkPath, old_string: 'alpha', new_string: 'ALPHA' },
      parentContext,
    )
    expectValidationFailure(validation)
    expect(validation.errorCode).toBe(7)
    expect(validation.message).toContain('modified since read')

    await expect(
      FileEditTool.call(
        { file_path: alias.linkPath, old_string: 'alpha', new_string: 'ALPHA' },
        parentContext,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readFile(alias.realPath, 'utf8')).toBe('alpha\nchild\n')
  })

  test('call waits for the same-path file state lock before final stale check and write', async () => {
    const { FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'locked-edit.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    let releaseLock!: () => void
    const lockMayRelease = new Promise<void>(resolve => {
      releaseLock = resolve
    })
    const lockHolder = withFileStatePathLock(path, async () => {
      await lockMayRelease
    })

    let editSettled = false
    const editAttempt = FileEditTool.call(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
      allowToolUse,
      parentMessage,
    ).finally(() => {
      editSettled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(editSettled).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('alpha\nbeta\n')

    releaseLock()
    await lockHolder
    await editAttempt

    expect(await readFile(path, 'utf8')).toBe('alpha\nBETA\n')
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

    expectValidationFailure(result)
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
    expectValidationFailure(missing)
    expect(missing.errorCode).toBe(8)

    const ambiguous = await FileEditTool.validateInput!(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      context,
    )
    expectValidationFailure(ambiguous)
    expect(ambiguous.errorCode).toBe(9)
  })
})
