import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../../../../tools/FileEditTool/constants.js'
import { FILE_UNCHANGED_STUB } from '../../../../tools/FileReadTool/prompt.js'
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
import { withFileStatePathLock } from '../../../../utils/fileStateRegistry.js'

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

describe('FileWriteTool file harness behavior', () => {
  test('validateInput rejects writing the internal unchanged-read stub', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'stub-write.txt')
    const result = await FileWriteTool.validateInput!(
      { file_path: path, content: FILE_UNCHANGED_STUB },
      makeToolContext(),
    )

    expectValidationFailure(result)
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

    expectValidationFailure(result)
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

    expectValidationFailure(result)
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

  test('canonicalizes new file writes to LF without leading BOM', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'canonical-created.txt')
    const context = makeToolContext()

    await FileWriteTool.call(
      { file_path: path, content: '\ufeffalpha\r\nbeta\r\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    const raw = await readFile(path)
    expect(raw[0]).not.toBe(0xef)
    expect(raw.toString('utf8')).toBe('alpha\nbeta\n')
    expect(raw.includes(Buffer.from('\r\n'))).toBe(false)
    expect(context.readFileState.get(path)?.content).toBe('alpha\nbeta\n')
    expect(context.readFileState.get(path)?.toolNormalization).toEqual({
      sourceTool: 'Write',
      removedLeadingBom: true,
      normalizedLineEndings: true,
    })
  })

  test('format-only Write normalization still leaves full semantic content known', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'canonical-known.txt')
    const context = makeToolContext()

    await FileWriteTool.call(
      { file_path: path, content: 'alpha\r\nbeta\r\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'gamma\n' },
      context,
    )

    expect(validation.result).toBe(true)
    expect(context.readFileState.get(path)?.content).toBe('alpha\nbeta\n')
    expect(context.readFileState.get(path)?.toolNormalization).toEqual({
      sourceTool: 'Write',
      normalizedLineEndings: true,
    })
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
    expectValidationFailure(result)
    expect(result.errorCode).toBe(2)
    expect(result.message).toContain('File was only partially read')
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
    ).rejects.toThrow('File was only partially read')
    expect(await readFile(path, 'utf8')).toBe('alpha\nbeta\ngamma\n')
  })

  test('allows overwriting after a bounded Read that covered the full file', async () => {
    const { FileReadTool, FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'bounded-full-write.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path, offset: 1, limit: 10 },
      context,
      allowToolUse,
      parentMessage,
    )

    const readState = context.readFileState.get(path)
    expect(readState?.isPartialView).toBeUndefined()
    expect(readState?.totalLines).toBe(4)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'replacement\n' },
      context,
    )

    expect(validation.result).toBe(true)
    await FileWriteTool.call(
      { file_path: path, content: 'replacement\n' },
      context,
      allowToolUse,
      parentMessage,
    )
    expect(await readFile(path, 'utf8')).toBe('replacement\n')
  })

  test.runIf(process.platform === 'win32')(
    'overwrites after a full Read when only Windows path casing differs',
    async () => {
      const { FileReadTool, FileWriteTool } = await loadFileTools()
      const path = join(getHarnessCwd(), 'case-write.txt')
      await writeFile(path, 'alpha\nbeta\n', 'utf8')
      const context = makeToolContext()
      const upperDrivePath = path.replace(/^[a-z]:/, drive =>
        drive.toUpperCase(),
      )
      const lowerDrivePath = path.replace(/^[A-Z]:/, drive =>
        drive.toLowerCase(),
      )

      await FileReadTool.call(
        { file_path: upperDrivePath },
        context,
        allowToolUse,
        parentMessage,
      )

      const validation = await FileWriteTool.validateInput!(
        { file_path: lowerDrivePath, content: 'replacement\n' },
        context,
      )

      expect(validation.result).toBe(true)
      await FileWriteTool.call(
        { file_path: lowerDrivePath, content: 'replacement\n' },
        context,
        allowToolUse,
        parentMessage,
      )
      expect(await readFile(path, 'utf8')).toBe('replacement\n')
    },
  )

  test('rejects overwriting partial state with limit even when isPartialView is missing', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'manual-partial-limit-write.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const stats = await stat(path)
    const context = makeToolContext()
    context.readFileState.set(path, {
      content: 'alpha\n',
      timestamp: Math.floor(stats.mtimeMs),
      offset: 1,
      limit: 1,
    })

    const result = await FileWriteTool.validateInput!(
      { file_path: path, content: 'replacement\n' },
      context,
    )

    expectValidationFailure(result)
    expect(result.errorCode).toBe(2)
    expect(result.fileHarnessFailure).toMatchObject({
      reason: 'partial_read_for_write',
      phase: 'validation',
      path,
    })
  })

  test('call rejects partial state with limit even when isPartialView is missing', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'manual-partial-limit-write-call.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const stats = await stat(path)
    const context = makeToolContext()
    context.readFileState.set(path, {
      content: 'alpha\n',
      timestamp: Math.floor(stats.mtimeMs),
      offset: 1,
      limit: 1,
    })

    await expect(
      FileWriteTool.call(
        { file_path: path, content: 'replacement\n' },
        context,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow('File was only partially read')
    expect(await readFile(path, 'utf8')).toBe('alpha\nbeta\ngamma\n')
  })

  test('preserves existing CRLF line endings when overwriting a CRLF file', async () => {
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
    expect(raw.toString('utf8')).toBe('one\r\nTWO\r\n')
    expect(context.readFileState.get(path)?.content).toBe('one\nTWO\n')
  })

  test('preserves existing UTF-8 BOM when overwriting a BOM file', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'bom-write.txt')
    await writeFile(path, '\ufeffalpha\n', 'utf8')
    const context = await readIntoContext(path)

    await FileWriteTool.call(
      { file_path: path, content: '\ufeffbeta\r\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    const raw = await readFile(path)
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(raw.toString('utf8')).toBe('\ufeffbeta\n')
    expect(context.readFileState.get(path)?.content).toBe('beta\n')
  })

  test('preserves existing UTF-16LE BOM encoding when overwriting a UTF-16LE file', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'utf16-write.txt')
    await writeFile(path, Buffer.from('\ufeffalpha\n', 'utf16le'))
    const context = await readIntoContext(path)

    await FileWriteTool.call(
      { file_path: path, content: 'beta\r\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    const raw = await readFile(path)
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    expect(raw.toString('utf16le')).toBe('\ufeffbeta\n')
    expect(context.readFileState.get(path)?.content).toBe('beta\n')
  })

  test('preserves majority line ending style and defaults mixed ties to LF on overwrite', async () => {
    const { FileWriteTool } = await loadFileTools()
    const crlfMajority = join(getHarnessCwd(), 'crlf-majority-write.txt')
    await writeFile(crlfMajority, 'a\r\nb\r\nc\n', 'utf8')
    const crlfContext = await readIntoContext(crlfMajority)

    await FileWriteTool.call(
      { file_path: crlfMajority, content: 'one\ntwo\n' },
      crlfContext,
      allowToolUse,
      parentMessage,
    )

    expect((await readFile(crlfMajority)).toString('utf8')).toBe(
      'one\r\ntwo\r\n',
    )
    expect(crlfContext.readFileState.get(crlfMajority)?.content).toBe(
      'one\ntwo\n',
    )

    const mixedTie = join(getHarnessCwd(), 'mixed-tie-write.txt')
    await writeFile(mixedTie, 'a\r\nb\n', 'utf8')
    const tieContext = await readIntoContext(mixedTie)

    await FileWriteTool.call(
      { file_path: mixedTie, content: 'one\ntwo\n' },
      tieContext,
      allowToolUse,
      parentMessage,
    )

    expect((await readFile(mixedTie)).toString('utf8')).toBe('one\ntwo\n')
    expect(tieContext.readFileState.get(mixedTie)?.content).toBe('one\ntwo\n')
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

  test('validateInput allows mtime-only drift after reading a lone-CR file', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'mtime-only-cr-write.txt')
    await writeFile(path, 'alpha\rbeta\r', 'utf8')
    const context = await readIntoContext(path)
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'replacement\n' },
      context,
    )

    expect(context.readFileState.get(path)?.content).toBe('alpha\nbeta\n')
    expect(validation.result).toBe(true)
  })

  test('validateInput allows mtime-only drift for a BOM file after full Read', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'bom-mtime-only-write.txt')
    await writeFile(path, '\ufeffalpha\n', 'utf8')
    const context = await readIntoContext(path)
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'beta\n' },
      context,
    )

    expect(context.readFileState.get(path)?.content).toBe('alpha\n')
    expect(validation.result).toBe(true)
  })

  test('validateInput allows mtime-only drift for a UTF-16LE BOM file after full Read', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'utf16-mtime-only-write.txt')
    await writeFile(path, Buffer.from('\ufeffalpha\n', 'utf16le'))
    const context = await readIntoContext(path)
    const future = new Date(Date.now() + 10_000)
    await utimes(path, future, future)

    const validation = await FileWriteTool.validateInput!(
      { file_path: path, content: 'beta\n' },
      context,
    )

    expect(context.readFileState.get(path)?.content).toBe('alpha\n')
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
    expectValidationFailure(validation)
    expect(validation.errorCode).toBe(3)
    expect(validation.message).toContain('modified since read')

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

  test('rejects overwriting after a sibling writes through a symlink alias', async () => {
    const { FileWriteTool } = await loadFileTools()
    const alias = await createSymlinkAliasFile('sibling-alias-write')
    if (!alias) return

    await writeFile(alias.realPath, 'alpha\n', 'utf8')
    const parentContext = await readIntoContext(alias.realPath)
    const originalTimestamp = parentContext.readFileState.get(
      alias.realPath,
    )?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = await readIntoContext(alias.linkPath)
    childContext.agentId = asAgentId('achild000000000306')
    await FileWriteTool.call(
      { file_path: alias.linkPath, content: 'child\n' },
      childContext,
      allowToolUse,
      parentMessage,
    )

    const originalDate = new Date(originalTimestamp!)
    await utimes(alias.realPath, originalDate, originalDate)
    expect(Math.floor((await stat(alias.realPath)).mtimeMs)).toBe(
      originalTimestamp,
    )

    const validation = await FileWriteTool.validateInput!(
      { file_path: alias.realPath, content: 'parent\n' },
      parentContext,
    )
    expectValidationFailure(validation)
    expect(validation.errorCode).toBe(3)
    expect(validation.message).toContain('modified since read')

    await expect(
      FileWriteTool.call(
        { file_path: alias.realPath, content: 'parent\n' },
        parentContext,
        allowToolUse,
        parentMessage,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(await readFile(alias.realPath, 'utf8')).toBe('child\n')
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

    expectValidationFailure(result)
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

  test('call waits for the same-path file state lock before final stale check and write', async () => {
    const { FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'locked-write.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = await readIntoContext(path)

    let releaseLock!: () => void
    const lockMayRelease = new Promise<void>(resolve => {
      releaseLock = resolve
    })
    const lockHolder = withFileStatePathLock(path, async () => {
      await lockMayRelease
    })

    let writeSettled = false
    const writeAttempt = FileWriteTool.call(
      { file_path: path, content: 'beta\n' },
      context,
      allowToolUse,
      parentMessage,
    ).finally(() => {
      writeSettled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(writeSettled).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('alpha\n')

    releaseLock()
    await lockHolder
    await writeAttempt

    expect(await readFile(path, 'utf8')).toBe('beta\n')
  })

  test('call waits for a symlink-alias file state lock before writing', async () => {
    const { FileWriteTool } = await loadFileTools()
    const alias = await createSymlinkAliasFile('locked-alias-write')
    if (!alias) return

    await writeFile(alias.realPath, 'alpha\n', 'utf8')
    const context = await readIntoContext(alias.realPath)

    let releaseLock!: () => void
    const lockMayRelease = new Promise<void>(resolve => {
      releaseLock = resolve
    })
    const lockHolder = withFileStatePathLock(alias.linkPath, async () => {
      await lockMayRelease
    })

    let writeSettled = false
    const writeAttempt = FileWriteTool.call(
      { file_path: alias.realPath, content: 'beta\n' },
      context,
      allowToolUse,
      parentMessage,
    ).finally(() => {
      writeSettled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(writeSettled).toBe(false)
    expect(await readFile(alias.realPath, 'utf8')).toBe('alpha\n')

    releaseLock()
    await lockHolder
    await writeAttempt

    expect(await readFile(alias.realPath, 'utf8')).toBe('beta\n')
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
