import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
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
let FileEditTool: Awaited<
  typeof import('../../../../tools/FileEditTool/FileEditTool.js')
>['FileEditTool']
let FileWriteTool: Awaited<
  typeof import('../../../../tools/FileWriteTool/FileWriteTool.js')
>['FileWriteTool']

beforeAll(async () => {
  ;[{ FileReadTool }, { FileEditTool }, { FileWriteTool }] = await Promise.all([
    import('../../../../tools/FileReadTool/FileReadTool.js'),
    import('../../../../tools/FileEditTool/FileEditTool.js'),
    import('../../../../tools/FileWriteTool/FileWriteTool.js'),
  ])
}, 120_000)

async function loadFileTools() {
  return { FileReadTool, FileEditTool, FileWriteTool }
}

describe('FileReadTool file harness dedup behavior', () => {
  test('returns file_unchanged for a repeated read of the same unchanged range', async () => {
    const { FileReadTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'same-range.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = makeToolContext()

    const first = await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )
    const second = await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(first.data.type).toBe('text')
    expect(second.data.type).toBe('file_unchanged')
    if (second.data.type !== 'file_unchanged') return
    expect(second.data.file.filePath).toBe(path)
    expect(second.data.file.dedupCount).toBe(1)
    expect(second.data.file.dedupLevel).toBe('none')
  })

  test('adds guidance after repeated unchanged reads of the same range', async () => {
    const { FileReadTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'same-range-loop.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )
    const firstDedup = await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )
    const secondDedup = await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )
    const thirdDedup = await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(firstDedup.data.type).toBe('file_unchanged')
    expect(secondDedup.data.type).toBe('file_unchanged')
    expect(thirdDedup.data.type).toBe('file_unchanged')
    if (
      firstDedup.data.type !== 'file_unchanged' ||
      secondDedup.data.type !== 'file_unchanged' ||
      thirdDedup.data.type !== 'file_unchanged'
    ) {
      return
    }

    expect(firstDedup.data.file.dedupCount).toBe(1)
    expect(firstDedup.data.file.dedupLevel).toBe('none')
    expect(secondDedup.data.file.dedupCount).toBe(2)
    expect(secondDedup.data.file.dedupLevel).toBe('reread-loop')
    expect(thirdDedup.data.file.dedupCount).toBe(3)
    expect(thirdDedup.data.file.dedupLevel).toBe('stop')

    const firstBlock = FileReadTool.mapToolResultToToolResultBlockParam(
      firstDedup.data,
      'read-1',
    )
    const secondBlock = FileReadTool.mapToolResultToToolResultBlockParam(
      secondDedup.data,
      'read-2',
    )
    const thirdBlock = FileReadTool.mapToolResultToToolResultBlockParam(
      thirdDedup.data,
      'read-3',
    )
    expect(firstBlock.content).not.toContain('Repeated Read calls')
    expect(secondBlock.content).toContain('Repeated Read calls')
    expect(thirdBlock.content).toContain('STOP')
  })

  test('does not dedup a different offset or limit', async () => {
    const { FileReadTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'different-range.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path, offset: 1, limit: 1 },
      context,
      allowToolUse,
      parentMessage,
    )

    const differentOffset = await FileReadTool.call(
      { file_path: path, offset: 2, limit: 1 },
      context,
      allowToolUse,
      parentMessage,
    )
    expect(differentOffset.data.type).toBe('text')
    if (differentOffset.data.type !== 'text') return
    expect(differentOffset.data.file.content).toBe('beta')

    const differentLimit = await FileReadTool.call(
      { file_path: path, offset: 2, limit: 2 },
      context,
      allowToolUse,
      parentMessage,
    )
    expect(differentLimit.data.type).toBe('text')
    if (differentLimit.data.type !== 'text') return
    expect(differentLimit.data.file.content).toBe('beta\ngamma')
  })

  test('does not dedup against FileEditTool post-edit readFileState', async () => {
    const { FileReadTool, FileEditTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'after-edit.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path },
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

    expect(context.readFileState.get(path)?.offset).toBeUndefined()

    const afterEdit = await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(afterEdit.data.type).toBe('text')
    if (afterEdit.data.type !== 'text') return
    expect(afterEdit.data.file.content).toBe('alpha\nBETA\n')
    expect(await readFile(path, 'utf8')).toBe('alpha\nBETA\n')
  })

  test('does not dedup against FileWriteTool post-write readFileState', async () => {
    const { FileReadTool, FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'after-write.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const context = makeToolContext()

    await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )
    await FileWriteTool.call(
      { file_path: path, content: 'written\n' },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(context.readFileState.get(path)?.offset).toBeUndefined()

    const afterWrite = await FileReadTool.call(
      { file_path: path },
      context,
      allowToolUse,
      parentMessage,
    )

    expect(afterWrite.data.type).toBe('text')
    if (afterWrite.data.type !== 'text') return
    expect(afterWrite.data.file.content).toBe('written\n')
    expect(await readFile(path, 'utf8')).toBe('written\n')
  })

  test('does not dedup after a sibling subagent writes even if mtime is unchanged', async () => {
    const { FileReadTool, FileWriteTool } = await loadFileTools()
    const path = join(getHarnessCwd(), 'after-sibling-write.txt')
    await writeFile(path, 'alpha\n', 'utf8')
    const parentContext = makeToolContext()
    await FileReadTool.call(
      { file_path: path },
      parentContext,
      allowToolUse,
      parentMessage,
    )
    const originalTimestamp = parentContext.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000003'),
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

    const reread = await FileReadTool.call(
      { file_path: path },
      parentContext,
      allowToolUse,
      parentMessage,
    )

    expect(reread.data.type).toBe('text')
    if (reread.data.type !== 'text') return
    expect(reread.data.file.content).toBe('child\n')
    expect(parentContext.readFileState.get(path)?.content).toBe('child\n')
  })
})
