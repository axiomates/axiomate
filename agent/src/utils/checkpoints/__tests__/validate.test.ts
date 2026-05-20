import { describe, expect, test } from 'vitest'
import {
  validateCommitHash,
  validateRelativePath,
} from '../validate.js'

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
})
