import { readFile, writeFile } from 'node:fs/promises'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  detectLineEndingsForString,
  readFileSyncWithMetadata,
} from '../../../../utils/fileRead.js'
import { getHarnessCwd, mockFileHarnessRuntime, setupFileHarness } from './helpers.js'
import { join } from 'node:path'

mockFileHarnessRuntime()
setupFileHarness()

let FileReadTool: Awaited<
  typeof import('../../../../tools/FileReadTool/FileReadTool.js')
>['FileReadTool']

beforeAll(async () => {
  ;({ FileReadTool } = await import(
    '../../../../tools/FileReadTool/FileReadTool.js'
  ))
}, 120_000)

describe('file harness metadata reads', () => {
  test('detectLineEndingsForString distinguishes LF and CRLF', () => {
    expect(detectLineEndingsForString('a\nb\n')).toBe('LF')
    expect(detectLineEndingsForString('a\r\nb\r\n')).toBe('CRLF')
  })

  test('readFileSyncWithMetadata normalizes CRLF content but reports original line ending', async () => {
    const path = join(getHarnessCwd(), 'crlf.txt')
    await writeFile(path, 'a\r\nb\r\n', 'utf8')

    const meta = readFileSyncWithMetadata(path)

    expect(meta.content).toBe('a\nb\n')
    expect(meta.lineEndings).toBe('CRLF')
    expect(meta.encoding).toBe('utf8')
  })

  test('readFileSyncWithMetadata preserves current UTF-8 BOM visibility for edit/write metadata reads', async () => {
    const path = join(getHarnessCwd(), 'bom.txt')
    await writeFile(path, '\ufeffhello\n', 'utf8')

    const meta = readFileSyncWithMetadata(path)

    expect(meta.encoding).toBe('utf8')
    expect(meta.content.charCodeAt(0)).toBe(0xfeff)
    expect(meta.content).toBe('\ufeffhello\n')
  })

  test('readFileInRange-facing reads strip UTF-8 BOM for model-visible Read results', async () => {
    const { allowToolUse, makeToolContext, parentMessage } = await import(
      './helpers.js'
    )
    const path = join(getHarnessCwd(), 'read-bom.txt')
    await writeFile(path, '\ufeffhello\nworld\n', 'utf8')

    const result = await FileReadTool.call(
      { file_path: path },
      makeToolContext(),
      allowToolUse,
      parentMessage,
    )

    expect(result.data.type).toBe('text')
    if (result.data.type !== 'text') return
    expect(result.data.file.content).toBe('hello\nworld\n')
    expect(result.data.file.content.charCodeAt(0)).not.toBe(0xfeff)
  })

  test('utf16le files are decoded for edit/write metadata reads', async () => {
    const path = join(getHarnessCwd(), 'utf16.txt')
    await writeFile(path, Buffer.from('\ufeffhello\n', 'utf16le'))

    const meta = readFileSyncWithMetadata(path)
    const raw = await readFile(path)

    expect(raw[0]).toBe(0xff)
    expect(raw[1]).toBe(0xfe)
    expect(meta.encoding).toBe('utf16le')
    expect(meta.content).toContain('hello')
  })
})
