import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  countNulRecordsFromChunks,
  readNulPathspecFile,
  writeAtomicPathspecFromStream,
} from '../../../utils/fileHistoryRewindPathspec.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-pathspec-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function collect(pathspecFile: string): Promise<string[]> {
  const out: string[] = []
  for await (const rel of readNulPathspecFile(pathspecFile)) out.push(rel)
  return out
}

async function* chunks(values: readonly (string | Buffer)[]): AsyncGenerator<string | Buffer> {
  for (const value of values) yield value
}

describe('fileHistoryRewindPathspec', () => {
  test('parses NUL pathspec records across chunk boundaries', async () => {
    const pathspecFile = join(tmpRoot, 'paths.nul')
    writeFileSync(pathspecFile, Buffer.concat([
      Buffer.from('src/fo'),
      Buffer.from('o.ts\0bar'),
      Buffer.from('.ts\0'),
    ]))

    await expect(collect(pathspecFile)).resolves.toEqual(['src/foo.ts', 'bar.ts'])
  })

  test('skips trailing and adjacent empty NUL records', async () => {
    const pathspecFile = join(tmpRoot, 'paths.nul')
    writeFileSync(pathspecFile, 'a.txt\0\0b.txt\0')

    await expect(collect(pathspecFile)).resolves.toEqual(['a.txt', 'b.txt'])
  })

  test('handles empty pathspec files', async () => {
    const pathspecFile = join(tmpRoot, 'paths.nul')
    writeFileSync(pathspecFile, '')

    await expect(collect(pathspecFile)).resolves.toEqual([])
  })

  test('preserves unicode paths when multibyte characters cross chunks', async () => {
    const encoded = Buffer.from('unicode/文件.txt\0')
    const pathspecFile = join(tmpRoot, 'unicode.nul')
    writeFileSync(pathspecFile, Buffer.concat([
      encoded.subarray(0, 10),
      encoded.subarray(10, 12),
      encoded.subarray(12),
    ]))

    await expect(collect(pathspecFile)).resolves.toEqual(['unicode/文件.txt'])
  })

  test('counts non-empty NUL records across chunks', async () => {
    await expect(countNulRecordsFromChunks(chunks(['src/fo', 'o.ts\0\0bar', '.ts\0']))).resolves.toBe(2)
  })

  test('writes pathspecs atomically through a sibling temp file', async () => {
    const pathspecFile = join(tmpRoot, 'checkout-paths.nul')

    const result = await writeAtomicPathspecFromStream(
      chunks(['a.txt\0', 'dir/b.txt\0']),
      pathspecFile,
    )

    expect(result).toEqual({ path: pathspecFile, count: 2 })
    expect(readFileSync(pathspecFile, 'utf-8')).toBe('a.txt\0dir/b.txt\0')
    expect(readdirSync(tmpRoot).filter(name => name.includes('.tmp-'))).toEqual([])
  })

  test('removes partial temp files and preserves an existing final file on stream failure', async () => {
    const pathspecFile = join(tmpRoot, 'checkout-paths.nul')
    writeFileSync(pathspecFile, 'old.txt\0')
    const error = new Error('injected stream failure')

    async function* failingChunks(): AsyncGenerator<string> {
      yield 'new.txt\0'
      throw error
    }

    await expect(writeAtomicPathspecFromStream(failingChunks(), pathspecFile)).rejects.toThrow(error)
    expect(readFileSync(pathspecFile, 'utf-8')).toBe('old.txt\0')
    expect(readdirSync(tmpRoot).filter(name => name.includes('.tmp-'))).toEqual([])
  })

  test('streams large synthetic pathspecs without array-returning APIs', async () => {
    const pathspecFile = join(tmpRoot, 'large.nul')
    const total = 20_000

    async function* manyPaths(): AsyncGenerator<Buffer> {
      for (let i = 0; i < total; i++) {
        yield Buffer.from(`dir/file-${i}.txt\0`)
      }
    }

    const result = await writeAtomicPathspecFromStream(manyPaths(), pathspecFile)
    expect(result.count).toBe(total)

    let count = 0
    for await (const rel of readNulPathspecFile(pathspecFile)) {
      if (count === 0) expect(rel).toBe('dir/file-0.txt')
      if (count === total - 1) expect(rel).toBe(`dir/file-${total - 1}.txt`)
      count++
    }
    expect(count).toBe(total)
  })

  test('round-trips literal special paths', async () => {
    const paths = [
      'space dir/file name.txt',
      'unicode/文件.txt',
      'symbols/a[1]+(x).txt',
      '--not-a-flag.txt',
      'nested/deep/file.txt',
    ]
    const pathspecFile = join(tmpRoot, 'special.nul')

    await writeAtomicPathspecFromStream(
      Readable.from(paths.map(path => `${path}\0`)),
      pathspecFile,
    )

    await expect(collect(pathspecFile)).resolves.toEqual(paths)
  })

  test('does not create the final file until a stream succeeds', async () => {
    const pathspecFile = join(tmpRoot, 'failed.nul')

    async function* failingChunks(): AsyncGenerator<string> {
      yield 'partial.txt\0'
      throw new Error('stop')
    }

    await expect(writeAtomicPathspecFromStream(failingChunks(), pathspecFile)).rejects.toThrow('stop')
    expect(existsSync(pathspecFile)).toBe(false)
    expect(readdirSync(tmpRoot).filter(name => name.includes('.tmp-'))).toEqual([])
  })
})
