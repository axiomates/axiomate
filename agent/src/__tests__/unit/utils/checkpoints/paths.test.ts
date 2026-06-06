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
} from '../../../../utils/checkpoints/paths.js'

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

describe('AXIOMATE_CHECKPOINT_BASE override (Decision #12)', () => {
  test('redirects getCheckpointBase to the override path when env is set', () => {
    const original = process.env.AXIOMATE_CHECKPOINT_BASE
    try {
      const override =
        process.platform === 'win32' ? 'C:\\tmp\\fake-axiomate-base' : '/tmp/fake-axiomate-base'
      process.env.AXIOMATE_CHECKPOINT_BASE = override
      expect(getCheckpointBase()).toBe(override)
      // Downstream paths follow the override automatically.
      expect(getStoreDir()).toBe(join(override, 'store'))
      expect(infoExcludePath()).toBe(join(override, 'store', 'info', 'exclude'))
    } finally {
      if (original === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
      else process.env.AXIOMATE_CHECKPOINT_BASE = original
    }
  })

  test('falls back to ~/.axiomate/checkpoints when env is unset or empty', () => {
    const original = process.env.AXIOMATE_CHECKPOINT_BASE
    try {
      delete process.env.AXIOMATE_CHECKPOINT_BASE
      const unset = getCheckpointBase()
      expect(unset.endsWith('checkpoints')).toBe(true)
      // Empty string is treated identically to unset (defense against
      // accidental `EXPORT FOO=""` tests setting it to nothing).
      process.env.AXIOMATE_CHECKPOINT_BASE = ''
      expect(getCheckpointBase()).toBe(unset)
    } finally {
      if (original === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
      else process.env.AXIOMATE_CHECKPOINT_BASE = original
    }
  })

  test('canonicalizes tilde-prefixed override (defensive — env vars are user input)', () => {
    const original = process.env.AXIOMATE_CHECKPOINT_BASE
    try {
      process.env.AXIOMATE_CHECKPOINT_BASE = '~/axiomate-base-test'
      expect(getCheckpointBase()).toBe(join(homedir(), 'axiomate-base-test'))
    } finally {
      if (original === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
      else process.env.AXIOMATE_CHECKPOINT_BASE = original
    }
  })
})

describe('DEFAULT_EXCLUDES invariants', () => {
  test('keeps only tiny checkpoint-owned defaults', () => {
    expect(DEFAULT_EXCLUDES).toEqual([
      '.git/',
      '.hg/',
      '.svn/',
      'node_modules/',
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
    ])
  })

  test('does not default-exclude secrets, logs, build outputs, or language artifacts', () => {
    expect(DEFAULT_EXCLUDES).not.toContain('.env')
    expect(DEFAULT_EXCLUDES).not.toContain('.env.*')
    expect(DEFAULT_EXCLUDES).not.toContain('*.log')
    expect(DEFAULT_EXCLUDES).not.toContain('bin/')
    expect(DEFAULT_EXCLUDES).not.toContain('obj/')
    expect(DEFAULT_EXCLUDES).not.toContain('.vs/')
    expect(DEFAULT_EXCLUDES).not.toContain('__pycache__/')
    expect(DEFAULT_EXCLUDES).not.toContain('.venv/')
    expect(DEFAULT_EXCLUDES).not.toContain('.next/')
    expect(DEFAULT_EXCLUDES).not.toContain('build/')
  })

  test('keeps node_modules as the only dependency tree default', () => {
    expect(DEFAULT_EXCLUDES).toContain('node_modules/')
    expect(DEFAULT_EXCLUDES).not.toContain('bun.lockb')
    expect(DEFAULT_EXCLUDES).not.toContain('Cargo.lock')
  })
})
