import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readFileInRange } from '../../../utils/readFileInRange.js'

let tmpDir = ''

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'axiomate-read-file-range-'))
})

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
    tmpDir = ''
  }
})

describe('readFileInRange', () => {
  test('normalizes lone CR line endings in the fast path', async () => {
    const path = join(tmpDir, 'old-mac.txt')
    await writeFile(path, 'alpha\rbeta\r', 'utf8')

    const result = await readFileInRange(path)

    expect(result.content).toBe('alpha\nbeta\n')
    expect(result.lineCount).toBe(3)
    expect(result.totalLines).toBe(3)
  })

  test('normalizes lone CR line endings in the streaming path', async () => {
    const path = join(tmpDir, 'old-mac-large.txt')
    await writeFile(path, 'alpha\rbeta\rgamma\r'.repeat(700_000), 'utf8')

    const result = await readFileInRange(path, 0, 3)

    expect(result.content).toBe('alpha\nbeta\ngamma')
    expect(result.lineCount).toBe(3)
  })
})
