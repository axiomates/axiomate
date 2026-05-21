import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { projectHash, projectMetaPath } from '../paths.js'
import { touchProject, type ProjectMeta } from '../touchProject.js'

let tmpRoot: string
let originalBase: string | undefined

beforeAll(() => {
  originalBase = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (originalBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalBase
})

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-touch-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = tmpRoot
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function readMeta(hash: string): ProjectMeta {
  return JSON.parse(readFileSync(projectMetaPath(hash), 'utf-8')) as ProjectMeta
}

describe('touchProject — first call', () => {
  test('creates projects/<hash16>.json with workdir + created_at + last_touch', async () => {
    const wd = process.platform === 'win32' ? 'C:\\proj\\demo' : '/proj/demo'
    const hash = await touchProject(wd)

    expect(hash).toBe(projectHash(wd))
    expect(existsSync(projectMetaPath(hash))).toBe(true)

    const meta = readMeta(hash)
    expect(meta.workdir).toBe(wd)
    expect(typeof meta.created_at).toBe('number')
    expect(typeof meta.last_touch).toBe('number')
    expect(meta.created_at).toBe(meta.last_touch)
  })

  test('canonicalizes workdir before storing (defensive)', async () => {
    // ~/foo should expand. Hash is derived from canonical, file at canonical.
    const result = await touchProject('~')
    const meta = readMeta(result)
    expect(meta.workdir).not.toContain('~')
    expect(meta.workdir.length).toBeGreaterThan(1)
  })
})

describe('touchProject — second call (preserve created_at)', () => {
  test('preserves created_at, updates last_touch', async () => {
    const wd = process.platform === 'win32' ? 'C:\\proj\\demo2' : '/proj/demo2'
    const hash1 = await touchProject(wd)
    const first = readMeta(hash1)

    // Wait long enough that the millisecond reading actually changes.
    await new Promise(r => setTimeout(r, 20))

    const hash2 = await touchProject(wd)
    expect(hash2).toBe(hash1)
    const second = readMeta(hash2)

    expect(second.created_at).toBe(first.created_at)
    expect(second.last_touch).toBeGreaterThan(first.last_touch)
  })

  test('rewrites workdir on every touch (in case caller passed noisy form first)', async () => {
    // First call: canonical input. Second call: also canonical (touchProject
    // canonicalizes), so workdir stays equivalent. We just assert it survives.
    const wd = process.platform === 'win32' ? 'C:\\proj\\rewrite' : '/proj/rewrite'
    const hash = await touchProject(wd)
    await touchProject(wd)
    const meta = readMeta(hash)
    expect(meta.workdir).toBe(wd)
  })
})

describe('touchProject — corruption tolerance (Hermes type guard)', () => {
  test('non-dict JSON contents are ignored — fresh meta written', async () => {
    const wd = process.platform === 'win32' ? 'C:\\proj\\corrupt' : '/proj/corrupt'
    const hash = projectHash(wd)
    const path = projectMetaPath(hash)

    // Pre-populate with a JSON array (not a dict). Hermes line 485 type-guard.
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(['this', 'is', 'an', 'array']), 'utf-8')

    const out = await touchProject(wd)
    expect(out).toBe(hash)
    const meta = readMeta(hash)
    expect(meta.workdir).toBe(wd)
    expect(typeof meta.created_at).toBe('number')
    expect(typeof meta.last_touch).toBe('number')
  })

  test('null JSON contents are ignored', async () => {
    const wd = process.platform === 'win32' ? 'C:\\proj\\null' : '/proj/null'
    const hash = projectHash(wd)
    const path = projectMetaPath(hash)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'null', 'utf-8')

    const out = await touchProject(wd)
    expect(out).toBe(hash)
    const meta = readMeta(hash)
    expect(meta.workdir).toBe(wd)
  })

  test('malformed JSON does not throw — file rewritten', async () => {
    const wd = process.platform === 'win32' ? 'C:\\proj\\junk' : '/proj/junk'
    const hash = projectHash(wd)
    const path = projectMetaPath(hash)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'this is not json', 'utf-8')

    await expect(touchProject(wd)).resolves.toBe(hash)
    const meta = readMeta(hash)
    expect(meta.workdir).toBe(wd)
  })

  test('partial dict (missing created_at) — created_at gets fresh value', async () => {
    const wd = process.platform === 'win32' ? 'C:\\proj\\partial' : '/proj/partial'
    const hash = projectHash(wd)
    const path = projectMetaPath(hash)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ workdir: wd, last_touch: 12345 }), 'utf-8')

    await touchProject(wd)
    const meta = readMeta(hash)
    expect(typeof meta.created_at).toBe('number')
    expect(meta.created_at).not.toBe(12345) // fresh, not a copy of last_touch
  })
})
