import { describe, expect, test } from 'vitest'
import {
  validateCommitHash,
  validateRelativePath,
} from '../../../../utils/checkpoints/validate.js'

describe('validateCommitHash', () => {
  test('accepts short hex hashes (4 chars)', () => {
    expect(validateCommitHash('abcd')).toBeNull()
    expect(validateCommitHash('1234')).toBeNull()
    expect(validateCommitHash('a1b2')).toBeNull()
  })

  test('accepts full SHA-1 (40 hex chars)', () => {
    expect(validateCommitHash('a'.repeat(40))).toBeNull()
    expect(validateCommitHash('0123456789abcdef0123456789abcdef01234567')).toBeNull()
  })

  test('accepts full SHA-256 (64 hex chars)', () => {
    expect(validateCommitHash('f'.repeat(64))).toBeNull()
  })

  test('rejects empty / whitespace', () => {
    expect(validateCommitHash('')).toContain('Empty')
    expect(validateCommitHash('   ')).toContain('Empty')
  })

  test('rejects whitespace-only with tabs/newlines', () => {
    // `!commitHash.trim()` should normalize all whitespace forms, not
    // just plain spaces. If someone reads a hash from a file with a
    // CRLF or pastes from a TSV column we should still bail cleanly
    // instead of trying to send a whitespace-mangled value to git.
    expect(validateCommitHash('\t')).toContain('Empty')
    expect(validateCommitHash('\n')).toContain('Empty')
    expect(validateCommitHash('\r\n')).toContain('Empty')
    expect(validateCommitHash(' \t \n ')).toContain('Empty')
  })

  test('rejects hashes with embedded or leading whitespace as non-hex', () => {
    // Leading-space input doesn't trigger the .trim() empty check (it
    // has non-whitespace chars), but the regex must still reject it —
    // we don't silently strip and accept, because that would mask
    // upstream parsing bugs.
    expect(validateCommitHash('  abc1')).toContain('hex')
    expect(validateCommitHash('abc1  ')).toContain('hex')
    expect(validateCommitHash('a\tb1')).toContain('hex')
  })

  test('rejects values starting with dash (git flag injection guard)', () => {
    expect(validateCommitHash('-p')).toContain("must not start with '-'")
    expect(validateCommitHash('--patch')).toContain("must not start with '-'")
    expect(validateCommitHash('-abcd')).toContain("must not start with '-'")
  })

  test('rejects too short (< 4 hex)', () => {
    expect(validateCommitHash('abc')).toContain('hex')
  })

  test('rejects too long (> 64 hex)', () => {
    expect(validateCommitHash('a'.repeat(65))).toContain('hex')
  })

  test('rejects non-hex characters', () => {
    expect(validateCommitHash('xyz1')).toContain('hex')
    expect(validateCommitHash('abcd!')).toContain('hex')
    expect(validateCommitHash('abcd ef')).toContain('hex')
  })
})

describe('validateRelativePath', () => {
  const workdir = process.platform === 'win32' ? 'C:\\proj' : '/proj'

  test('accepts simple relative path', () => {
    expect(validateRelativePath('src/foo.ts', workdir)).toBeNull()
  })

  test('accepts deeply nested relative path', () => {
    expect(validateRelativePath('src/a/b/c/d.ts', workdir)).toBeNull()
  })

  test('accepts file at workdir root', () => {
    expect(validateRelativePath('package.json', workdir)).toBeNull()
  })

  test('rejects empty / whitespace', () => {
    expect(validateRelativePath('', workdir)).toContain('Empty')
    expect(validateRelativePath('   ', workdir)).toContain('Empty')
  })

  test('rejects absolute path on POSIX', () => {
    if (process.platform === 'win32') return
    expect(validateRelativePath('/etc/passwd', workdir)).toContain('absolute')
  })

  test('rejects absolute path on Windows', () => {
    if (process.platform !== 'win32') return
    expect(validateRelativePath('C:\\Windows\\system32', workdir)).toContain(
      'absolute',
    )
  })

  test('rejects parent traversal escaping workdir', () => {
    expect(validateRelativePath('../etc/passwd', workdir)).toContain('escapes')
    expect(validateRelativePath('../../something', workdir)).toContain('escapes')
  })

  test('rejects nested traversal that resolves outside workdir', () => {
    expect(validateRelativePath('src/../../etc/passwd', workdir)).toContain(
      'escapes',
    )
  })

  test('accepts traversal that stays within workdir', () => {
    expect(validateRelativePath('src/../package.json', workdir)).toBeNull()
    expect(validateRelativePath('a/b/../c.ts', workdir)).toBeNull()
  })

  test('canonicalizes tilde-prefixed workdir before traversal check', () => {
    // Mirrors Hermes `_validate_file_path` calling `_normalize_path(working_dir)`.
    // If we didn't expand `~`, the relative-to check would compare against
    // a literal `~/proj/src` base, and benign traversal could falsely escape.
    expect(validateRelativePath('src/foo.ts', '~/proj')).toBeNull()
    // Path that escapes home/proj should still be rejected after expansion.
    expect(validateRelativePath('../../etc/passwd', '~/proj')).toContain(
      'escapes',
    )
  })

  test('does NOT treat backslash as a separator on POSIX', () => {
    // Important platform-specific contract: on Linux/macOS, `\` is a
    // perfectly legal filename character. A literal "..\\..\\etc/passwd"
    // is a single segment containing backslashes — it does NOT escape
    // the workdir there. On Windows, the same input IS a traversal.
    // We pin both behaviors to lock the platform-aware semantics in.
    if (process.platform === 'win32') {
      expect(
        validateRelativePath('..\\..\\Windows\\system32', 'C:\\proj'),
      ).toContain('escapes')
    } else {
      // POSIX: `\` is a legal filename character; this is a single
      // weirdly-named file inside workdir. No traversal.
      expect(validateRelativePath('..\\..\\etc/passwd', '/proj')).toBeNull()
    }
  })
})
