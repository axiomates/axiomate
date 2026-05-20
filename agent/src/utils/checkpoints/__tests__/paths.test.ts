import { homedir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_EXCLUDES,
  getCheckpointBase,
  getLastPrunePath,
  getStoreDir,
  indexPath,
  infoExcludePath,
  normalizePath,
  projectHash,
  projectMetaPath,
  refName,
} from '../paths.js'

describe('projectHash', () => {
  test('is deterministic — same input → same hash', () => {
    const path = process.platform === 'win32' ? 'C:\\foo\\bar' : '/foo/bar'
    expect(projectHash(path)).toBe(projectHash(path))
  })

  test('returns 16 hex chars', () => {
    const hash = projectHash('/some/abs/path')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  test('different absolute paths → different hashes', () => {
    expect(projectHash('/proj/a')).not.toBe(projectHash('/proj/b'))
  })

  test('paths differing only in case produce different hashes', () => {
    // Case sensitivity is intentional: on case-insensitive filesystems the
    // user's actual abs path is what we get, and we should treat distinct
    // string inputs as distinct projects rather than lowercase-collapsing.
    expect(projectHash('/Proj/foo')).not.toBe(projectHash('/proj/foo'))
  })
})

describe('refName', () => {
  test('builds the refs/axiomate/<hash> path', () => {
    expect(refName('abcdef0123456789')).toBe('refs/axiomate/abcdef0123456789')
  })
})

describe('store path helpers', () => {
  test('checkpoint base is under the config home', () => {
    const base = getCheckpointBase()
    // Don't hard-code the home path — just check the suffix is right.
    expect(base.endsWith('checkpoints')).toBe(true)
  })

  test('store dir is under base', () => {
    expect(getStoreDir()).toBe(join(getCheckpointBase(), 'store'))
  })

  test('last_prune marker lives at base, not inside store', () => {
    expect(getLastPrunePath()).toBe(join(getCheckpointBase(), '.last_prune'))
  })

  test('per-project index path uses hash', () => {
    expect(indexPath('abc123def456789')).toBe(
      join(getStoreDir(), 'indexes', 'abc123def456789'),
    )
  })

  test('per-project meta path uses .json suffix', () => {
    expect(projectMetaPath('abc123def456789')).toBe(
      join(getStoreDir(), 'projects', 'abc123def456789.json'),
    )
  })

  test('info/exclude lives under the store dir', () => {
    expect(infoExcludePath()).toBe(join(getStoreDir(), 'info', 'exclude'))
  })
})

describe('projectHash invariants', () => {
  test('different string forms of the same path produce different hashes (caller must canonicalize)', () => {
    // Documents the JSDoc contract: callers must pass path.resolve()-form
    // input. The function does not normalize internally — that policy
    // belongs to the Phase 2 store API boundary, not this value layer.
    const noisy = process.platform === 'win32'
      ? 'C:\\proj\\.\\sub'
      : '/proj/./sub'
    const clean = process.platform === 'win32'
      ? 'C:\\proj\\sub'
      : '/proj/sub'
    expect(projectHash(noisy)).not.toBe(projectHash(clean))
  })
})

describe('normalizePath', () => {
  test('expands `~` to the user home directory', () => {
    expect(normalizePath('~')).toBe(homedir())
  })

  test('expands `~/foo` to <home>/foo', () => {
    expect(normalizePath('~/foo')).toBe(join(homedir(), 'foo'))
  })

  test('expands `~\\foo` (Windows form) to <home>/foo', () => {
    expect(normalizePath('~\\foo')).toBe(join(homedir(), 'foo'))
  })

  test('leaves absolute paths idempotent (resolve normalizes `.` and `..`)', () => {
    const abs = process.platform === 'win32' ? 'C:\\proj\\.\\sub' : '/proj/./sub'
    const expected = process.platform === 'win32' ? 'C:\\proj\\sub' : '/proj/sub'
    expect(normalizePath(abs)).toBe(expected)
  })

  test('does NOT expand `~user` form (mirrors Hermes/Node limitation)', () => {
    // Hermes' Path.expanduser() supports `~user`; Node has no equivalent.
    // We document the limitation rather than reach for a userdb lookup.
    const result = normalizePath('~bob/foo')
    expect(result).not.toBe(join(homedir(), 'foo'))
    // It just gets path.resolve'd against cwd — the literal `~bob` survives.
    expect(result.includes('~bob')).toBe(true)
  })

  test('paired with projectHash, gives stable hashes across noisy/clean inputs', () => {
    // This is the use case: Phase 2 store API normalizes at the boundary,
    // then hashes — so `~/proj`, `/home/user/proj`, and `/home/user/./proj`
    // all collapse to the same project.
    const noisy = process.platform === 'win32'
      ? 'C:\\proj\\.\\sub'
      : '/proj/./sub'
    const clean = process.platform === 'win32'
      ? 'C:\\proj\\sub'
      : '/proj/sub'
    expect(projectHash(normalizePath(noisy))).toBe(
      projectHash(normalizePath(clean)),
    )
  })
})

describe('DEFAULT_EXCLUDES invariants', () => {
  test('always excludes the user .git/', () => {
    expect(DEFAULT_EXCLUDES).toContain('.git/')
  })

  test('always excludes secrets', () => {
    expect(DEFAULT_EXCLUDES).toContain('.env')
    expect(DEFAULT_EXCLUDES).toContain('.env.*')
  })

  test('covers Visual Studio C++/C# ecosystem', () => {
    expect(DEFAULT_EXCLUDES).toContain('bin/')
    expect(DEFAULT_EXCLUDES).toContain('obj/')
    expect(DEFAULT_EXCLUDES).toContain('.vs/')
    expect(DEFAULT_EXCLUDES).toContain('*.pdb')
  })

  test('covers Python ecosystem', () => {
    expect(DEFAULT_EXCLUDES).toContain('__pycache__/')
    expect(DEFAULT_EXCLUDES).toContain('.venv/')
  })

  test('covers JS/Bun ecosystem', () => {
    expect(DEFAULT_EXCLUDES).toContain('node_modules/')
    expect(DEFAULT_EXCLUDES).toContain('bun.lockb')
  })

  test('top-level Axiomate state is anchored (so nested agent/.axiomate/ stays rewindable)', () => {
    // The slash prefix on `/.axiomate/` is the load-bearing detail —
    // gitignore's anchor semantics mean it ONLY matches at the project root,
    // not at any depth. This is what keeps `agent/.axiomate/settings.local.json`
    // (a user-facing settings file Axiomate edits) snapshot-able.
    expect(DEFAULT_EXCLUDES).toContain('/.axiomate/')
    expect(DEFAULT_EXCLUDES).not.toContain('.axiomate/') // the unanchored form would leak
  })

  test('does not mistakenly include settings.local.json', () => {
    // Sanity check — settings files must remain rewindable.
    expect(DEFAULT_EXCLUDES).not.toContain('settings.local.json')
    expect(DEFAULT_EXCLUDES).not.toContain('agent/.axiomate/')
  })

  test('keeps Cargo.lock rewindable (binary-crate reproducibility)', () => {
    expect(DEFAULT_EXCLUDES).not.toContain('Cargo.lock')
  })
})
