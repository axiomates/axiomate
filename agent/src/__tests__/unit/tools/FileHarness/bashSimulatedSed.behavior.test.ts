import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../../../../tools/FileEditTool/constants.js'
import { asAgentId } from '../../../../types/ids.js'
import { cloneFileStateCache } from '../../../../utils/fileStateCache.js'
import { withFileStatePathLock } from '../../../../utils/fileStateRegistry.js'
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
let BashTool: Awaited<
  typeof import('../../../../tools/BashTool/BashTool.js')
>['BashTool']

beforeAll(async () => {
  ;({ FileReadTool } = await import(
    '../../../../tools/FileReadTool/FileReadTool.js'
  ))
  ;({ FileWriteTool } = await import(
    '../../../../tools/FileWriteTool/FileWriteTool.js'
  ))
  ;({ BashTool } = await import('../../../../tools/BashTool/BashTool.js'))
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

describe('BashTool simulated sed file harness behavior', () => {
  test('records simulated sed writes so stale parent writes are blocked even if mtime is restored', async () => {
    const path = join(getHarnessCwd(), 'sed-sibling.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const parentContext = await readIntoContext(path)
    const originalTimestamp = parentContext.readFileState.get(path)?.timestamp
    expect(originalTimestamp).toBeDefined()

    const childContext = makeToolContext({
      agentId: asAgentId('achild000000000201'),
      readFileState: cloneFileStateCache(parentContext.readFileState),
    })
    await BashTool.call(
      {
        command: `sed -i 's/beta/child/' ${path}`,
        _simulatedSedEdit: {
          filePath: path,
          newContent: 'alpha\nchild\n',
        },
      },
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
    expect(await readFile(path, 'utf8')).toBe('alpha\nchild\n')
  })

  test('simulated sed waits for the same-path file state lock before writing', async () => {
    const path = join(getHarnessCwd(), 'locked-sed.txt')
    await writeFile(path, 'alpha\nbeta\n', 'utf8')
    const context = await readIntoContext(path)

    let releaseLock!: () => void
    const lockMayRelease = new Promise<void>(resolve => {
      releaseLock = resolve
    })
    const lockHolder = withFileStatePathLock(path, async () => {
      await lockMayRelease
    })

    let sedSettled = false
    const sedAttempt = BashTool.call(
      {
        command: `sed -i 's/beta/BETA/' ${path}`,
        _simulatedSedEdit: {
          filePath: path,
          newContent: 'alpha\nBETA\n',
        },
      },
      context,
      allowToolUse,
      parentMessage,
    ).finally(() => {
      sedSettled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(sedSettled).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('alpha\nbeta\n')

    releaseLock()
    await lockHolder
    await sedAttempt

    expect(await readFile(path, 'utf8')).toBe('alpha\nBETA\n')
  })
})
