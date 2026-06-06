import { mkdtempSync, readFileSync, rmSync, existsSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { execFileNoThrowWithCwd } from '../../../../utils/execFileNoThrow.js'
import { gitExe } from '../../../../utils/git.js'
import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import {
  DEFAULT_EXCLUDES,
  getStoreDir,
  indexPath,
  infoExcludePath,
  projectHash,
  refName,
} from '../../../../utils/checkpoints/paths.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { buildFixtureCommit } from './fixtures.js'

/**
 * Tests run against a tmpdir-rooted store via AXIOMATE_CHECKPOINT_BASE
 * (Decision #12) — the real `~/.axiomate/checkpoints/` is never touched.
 */

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-store-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = tmpRoot
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('ensureStore — happy path', () => {
  test('creates store + indexes/ + projects/ + info/exclude', async () => {
    const r = await ensureStore()
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const storeDir = getStoreDir()
    expect(existsSync(storeDir)).toBe(true)
    expect(existsSync(join(storeDir, 'HEAD'))).toBe(true)
    expect(existsSync(join(storeDir, 'indexes'))).toBe(true)
    expect(existsSync(join(storeDir, 'projects'))).toBe(true)
    expect(existsSync(infoExcludePath())).toBe(true)
  })

  test('info/exclude content matches DEFAULT_EXCLUDES exactly', async () => {
    await ensureStore()
    const content = readFileSync(infoExcludePath(), 'utf-8')
    const lines = content.split('\n').filter(l => l.length > 0)
    expect(lines).toEqual([...DEFAULT_EXCLUDES])
  })

  test('writes repo-local config: gpgsign=false, gc.auto=0, user.email/name', async () => {
    await ensureStore()
    const storeDir = getStoreDir()
    const cfg = readFileSync(join(storeDir, 'config'), 'utf-8')
    expect(cfg).toMatch(/gpgsign\s*=\s*false/i)
    expect(cfg).toMatch(/auto\s*=\s*0/)
    expect(cfg).toMatch(/email\s*=\s*axiomate@local/)
    expect(cfg).toMatch(/Axiomate Checkpoint/)
  })

  test('initializes a bare repository (bare = true in config)', async () => {
    await ensureStore()
    const cfg = readFileSync(join(getStoreDir(), 'config'), 'utf-8')
    expect(cfg).toMatch(/bare\s*=\s*true/)
  })

  test('idempotent — second call is fast and does not re-init', async () => {
    const first = await ensureStore()
    expect(first.ok).toBe(true)

    // Capture the contents of HEAD as the canary — `git init --bare`
    // touches it; if we re-init we'd see a new mtime.
    const headPath = join(getStoreDir(), 'HEAD')
    const before = readFileSync(headPath, 'utf-8')

    const second = await ensureStore()
    expect(second.ok).toBe(true)

    const after = readFileSync(headPath, 'utf-8')
    expect(after).toBe(before)
  })

  test('returned store path is canonical (resolved)', async () => {
    const r = await ensureStore()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // No `~`, no relative segments — Hermes/Axiomate contract.
    expect(r.store).not.toContain('~')
    expect(r.store).not.toMatch(/[/\\]\.[/\\]/)
  })
})

describe('ensureStore — git is actually usable afterward', () => {
  test('we can spawn git against the freshly-initialized store', async () => {
    const r = await ensureStore()
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // `git rev-parse --is-bare-repository` exits 0 with "true\n".
    // We use raw execFileNoThrow here (not runCheckpointGit) so we
    // don't depend on the runCheckpointGit pre-flight stat — we want
    // to assert git can actually read the store.
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['--git-dir', r.store, 'rev-parse', '--is-bare-repository'],
      {
        timeout: 10_000,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    )
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('true')
  })
})

describe('ensureStore — error handling', () => {
  test('returns typed failure when base path cannot be created', async () => {
    // Point the override at a path that is itself a regular file —
    // mkdir cannot create a directory under it. Cleanest cross-platform
    // way to force a mkdir failure without messing with permissions.
    const fakeFile = join(tmpRoot, 'i-am-a-file')
    writeFileSync(fakeFile, 'content')
    process.env.AXIOMATE_CHECKPOINT_BASE = join(fakeFile, 'nested')

    const r = await ensureStore()
    expect(r.ok).toBe(false)
    if (r.ok === false) {
      expect(r.reason).toMatch(/mkdir failed/)
    }
  })

  test('does not throw on failure — fail-open contract', async () => {
    const fakeFile = join(tmpRoot, 'i-am-a-file-2')
    writeFileSync(fakeFile, 'content')
    process.env.AXIOMATE_CHECKPOINT_BASE = join(fakeFile, 'nested')
    await expect(ensureStore()).resolves.toBeDefined()
  })
})

/**
 * Phase 4 anchor: pins behaviors that Phase 4 might inadvertently change.
 *
 * 1. `info/exclude` is managed by checkpoint code so `git check-ignore`
 *    sees the current tiny DEFAULT_EXCLUDES, even after store reuse.
 * 2. `for-each-ref refs/axiomate/*` enumerability — Phase 4 size-cap
 *    pass 3 enumerates refs via this exact prefix query (Hermes
 *    `_enforce_size_cap:1102-1106`). If a future refactor moves ref
 *    location, this query goes silently empty and size-cap zero-ops.
 */
describe('ensureStore — Phase 4 behavior anchors', () => {
  test('rewrites info/exclude on a second call to current defaults', async () => {
    await ensureStore()
    const path = infoExcludePath()

    writeFileSync(path, 'user-added-pattern/\n', 'utf-8')

    await ensureStore()
    expect(readFileSync(path, 'utf-8')).toBe(
      DEFAULT_EXCLUDES.join('\n') + '\n',
    )
  })

  test('recreates info/exclude after deletion', async () => {
    await ensureStore()
    unlinkSync(infoExcludePath())

    await ensureStore()
    expect(readFileSync(infoExcludePath(), 'utf-8')).toBe(
      DEFAULT_EXCLUDES.join('\n') + '\n',
    )
  })
})

describe('Phase 4 anchor: refs/axiomate/* enumerable via for-each-ref', () => {
  test('for-each-ref refs/axiomate returns the per-project ref after a fixture commit', async () => {
    // Phase 4 size-cap pass uses this exact query to find candidates.
    // Lock the assumption now so a refs-location refactor cannot silently
    // make size-cap a no-op.
    const r = await ensureStore()
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const workTree = mkdtempSync(join(tmpRoot, 'wt-'))
    const hash = projectHash(workTree)
    const ref = refName(hash)
    await buildFixtureCommit({
      store: r.store,
      workTree,
      indexFile: indexPath(hash),
      ref,
      files: { 'a.txt': 'content' },
      subject: 'axiomate:m1:turn 1',
    })

    const enumeration = await runCheckpointGit(
      ['for-each-ref', '--format=%(refname)', 'refs/axiomate'],
      { store: r.store, workTree },
    )
    expect(enumeration.ok).toBe(true)
    if (!enumeration.ok) return
    const refs = enumeration.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0)
    expect(refs).toContain(ref)
  })
})
