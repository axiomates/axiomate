import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { countFilesUnder } from '../countFiles.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-count-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function touch(rel: string, content = ''): void {
  const full = join(tmpRoot, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

describe('countFilesUnder — basics', () => {
  test('empty directory → count 0, not aborted', async () => {
    const r = await countFilesUnder(tmpRoot, { max: 10 })
    expect(r).toEqual({ count: 0, aborted: false })
  })

  test('counts plain files at multiple depths', async () => {
    touch('a.txt')
    touch('sub/b.txt')
    touch('sub/deep/c.txt')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r).toEqual({ count: 3, aborted: false })
  })

  test('does not count directories themselves', async () => {
    touch('sub/sub2/keep.txt')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r.count).toBe(1)
  })
})

describe('countFilesUnder — DEFAULT_EXCLUDES applied', () => {
  test('skips node_modules/ entirely', async () => {
    touch('src/a.ts')
    touch('node_modules/foo/index.js')
    touch('node_modules/foo/bar/baz.js')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r.count).toBe(1)
  })

  test('skips .git/ (the user .git/ — never our shadow store)', async () => {
    touch('a.ts')
    touch('.git/HEAD')
    touch('.git/objects/ab/cd')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r.count).toBe(1)
  })

  test('skips .env and .env.* secrets', async () => {
    touch('a.ts')
    touch('.env')
    touch('.env.production')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r.count).toBe(1)
  })

  test('skips Visual Studio bin/ and obj/', async () => {
    touch('Foo.csproj')
    touch('bin/Debug/Foo.dll')
    touch('obj/Debug/Foo.pdb')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r.count).toBe(1)
  })

  test('skips top-level /.axiomate/ but keeps nested agent/.axiomate/', async () => {
    // Anchor matters — /.axiomate/ is rooted, agent/.axiomate/ is not
    // (and so should be tracked, since it's the user-facing settings dir).
    touch('agent/.axiomate/settings.local.json')
    touch('.axiomate/state.json')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r.count).toBe(1) // only the agent/.axiomate file survives
  })
})

describe('countFilesUnder — .gitignore at root', () => {
  test('respects user .gitignore patterns', async () => {
    touch('keep.ts')
    touch('skipme.log')
    touch('.gitignore', '*.log\n')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    // .gitignore itself is a regular file → counts.
    expect(r.count).toBe(2) // keep.ts + .gitignore
  })

  test('directory ignore in .gitignore prevents descent', async () => {
    touch('.gitignore', 'build/\n')
    touch('keep.ts')
    touch('build/output.bin')
    touch('build/nested/more.bin')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r.count).toBe(2) // keep.ts + .gitignore
  })

  test('absent .gitignore is fine — DEFAULT_EXCLUDES still applies', async () => {
    touch('a.ts')
    touch('node_modules/foo.js')
    const r = await countFilesUnder(tmpRoot, { max: 100 })
    expect(r.count).toBe(1)
  })
})

describe('countFilesUnder — early-abort', () => {
  test('aborts once count exceeds max — does NOT walk full tree', async () => {
    for (let i = 0; i < 50; i++) touch(`f${i}.txt`)
    const r = await countFilesUnder(tmpRoot, { max: 10 })
    expect(r.aborted).toBe(true)
    expect(r.count).toBe(11) // exactly cap + 1, the moment we crossed
  })

  test('exactly at the cap → not aborted', async () => {
    for (let i = 0; i < 5; i++) touch(`f${i}.txt`)
    const r = await countFilesUnder(tmpRoot, { max: 5 })
    expect(r).toEqual({ count: 5, aborted: false })
  })

  test('extraExcludes are honored', async () => {
    touch('a.ts')
    touch('skip-me.txt')
    const r = await countFilesUnder(tmpRoot, {
      max: 100,
      extraExcludes: ['skip-me.txt'],
    })
    expect(r.count).toBe(1)
  })
})

describe('countFilesUnder — robustness', () => {
  test('does not throw on a missing root (returns count: 0, aborted: false)', async () => {
    const r = await countFilesUnder(join(tmpRoot, 'does-not-exist'), {
      max: 100,
    })
    expect(r).toEqual({ count: 0, aborted: false })
  })
})
