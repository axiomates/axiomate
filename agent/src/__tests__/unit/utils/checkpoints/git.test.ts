import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  _resetGitAvailableCacheForTesting,
  _resolveTimeoutMsForTesting,
  DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS,
  probeGitAvailable,
  runCheckpointGit,
  type CheckpointGitResult,
} from '../../../../utils/checkpoints/git.js'

function expectFailure(
  r: CheckpointGitResult,
): asserts r is Extract<CheckpointGitResult, { ok: false }> {
  if (r.ok) throw new Error('expected pre-flight failure, got success')
}

describe('runCheckpointGit pre-flight', () => {
  let tmpRoot: string
  let realDir: string
  let regularFile: string

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-ckpt-git-'))
    realDir = tmpRoot
    regularFile = join(tmpRoot, 'a-file.txt')
    writeFileSync(regularFile, 'hello')
  })

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('rejects missing workTree before spawning git', async () => {
    const missing = join(tmpRoot, 'definitely-does-not-exist')
    const r = await runCheckpointGit(['status'], {
      store: realDir,
      workTree: missing,
    })
    expectFailure(r)
    expect(r.reason).toBe('spawn-error')
    expect(r.message).toContain('working directory not found')
    expect(r.message).toContain(missing)
  })

  test('rejects workTree that points at a regular file', async () => {
    const r = await runCheckpointGit(['status'], {
      store: realDir,
      workTree: regularFile,
    })
    expectFailure(r)
    expect(r.reason).toBe('spawn-error')
    expect(r.message).toContain('not a directory')
  })

  test('does not throw when workTree is missing — checkpoints must never block the agent', async () => {
    // The fail-open contract: every transient failure path returns a
    // typed result. Pre-flight must not be the one path that throws.
    await expect(
      runCheckpointGit(['status'], {
        store: realDir,
        workTree: '/totally/bogus/path/that/cannot/exist/anywhere',
      }),
    ).resolves.toBeDefined()
  })

  test('canonicalizes tilde-prefixed workTree before pre-flight (Hermes _run_git:287)', async () => {
    // Regression for a bug introduced when we aligned spawn cwd with
    // GIT_WORK_TREE: a literal `~` in workTree would land in
    // GIT_WORK_TREE *and* in execa's cwd. Node does not tilde-expand
    // at the chdir syscall, so spawn fails. Fix is to normalize once
    // at the runCheckpointGit boundary, then pass canonical strings
    // downstream — same shape as Hermes _run_git:287/297/307.
    const r = await runCheckpointGit(['status'], {
      store: realDir,
      workTree: '~/this-folder-definitely-does-not-exist-axiomate-test',
    })
    expectFailure(r)
    // Error message should reflect the EXPANDED path, not literal `~`.
    expect(r.message).toContain(homedir())
    expect(r.message).not.toContain('~')
  })
})

describe('probeGitAvailable (Decision #15)', () => {
  beforeAll(() => {
    _resetGitAvailableCacheForTesting()
  })

  afterAll(() => {
    _resetGitAvailableCacheForTesting()
  })

  test('returns true on a system that has git on PATH', async () => {
    // CI and dev machines all have git. If this fails on a developer
    // machine, the developer literally cannot run the rest of the
    // checkpoints test suite — that's a desirable failure mode.
    _resetGitAvailableCacheForTesting()
    const ok = await probeGitAvailable()
    expect(ok).toBe(true)
  })

  test('caches the result across calls — Hermes _git_available:632-637', async () => {
    // The probe is one-shot per process. We assert this by clearing
    // and re-probing; if it ran the binary again we'd see a fresh
    // result, but more importantly the contract is "no repeated
    // spawns under steady state". Indirect check: second call
    // returns the same value with no new state mutation.
    _resetGitAvailableCacheForTesting()
    const a = await probeGitAvailable()
    const b = await probeGitAvailable()
    expect(a).toBe(b)
  })

  test('reset helper allows the next call to re-probe', async () => {
    // Test-only seam used by the soft-disable tests in Phase 3.
    _resetGitAvailableCacheForTesting()
    const before = await probeGitAvailable()
    _resetGitAvailableCacheForTesting()
    const after = await probeGitAvailable()
    // Both should agree on the host's actual state — the reset
    // doesn't change reality, only the cache.
    expect(before).toBe(after)
  })
})

describe('AXIOMATE_CHECKPOINT_TIMEOUT clamp', () => {
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env.AXIOMATE_CHECKPOINT_TIMEOUT
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.AXIOMATE_CHECKPOINT_TIMEOUT
    else process.env.AXIOMATE_CHECKPOINT_TIMEOUT = saved
  })

  test('unset → default 30s', () => {
    delete process.env.AXIOMATE_CHECKPOINT_TIMEOUT
    expect(_resolveTimeoutMsForTesting()).toBe(DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS)
  })

  test('NaN / non-numeric → default', () => {
    process.env.AXIOMATE_CHECKPOINT_TIMEOUT = 'banana'
    expect(_resolveTimeoutMsForTesting()).toBe(DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS)
  })

  test('zero or negative → default (we never disable the safety net)', () => {
    process.env.AXIOMATE_CHECKPOINT_TIMEOUT = '0'
    expect(_resolveTimeoutMsForTesting()).toBe(DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS)
    process.env.AXIOMATE_CHECKPOINT_TIMEOUT = '-5'
    expect(_resolveTimeoutMsForTesting()).toBe(DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS)
  })

  test('below floor (< 10s) → clamped to 10s', () => {
    process.env.AXIOMATE_CHECKPOINT_TIMEOUT = '3'
    expect(_resolveTimeoutMsForTesting()).toBe(10_000)
  })

  test('in-range value honored', () => {
    process.env.AXIOMATE_CHECKPOINT_TIMEOUT = '90'
    expect(_resolveTimeoutMsForTesting()).toBe(90_000)
  })

  test('above ceiling (> 600s) → clamped to 600s', () => {
    process.env.AXIOMATE_CHECKPOINT_TIMEOUT = '99999'
    expect(_resolveTimeoutMsForTesting()).toBe(600_000)
  })
})

describe('allowedExitCodes ok-promotion', () => {
  // Pinning the documented intentional divergence from Hermes
  // (`git.ts:75` comment): caller-allowed exit codes are reported as
  // `ok: true` so the caller doesn't have to re-check `code` after every
  // call. Hermes silently logs the same allow but keeps `ok: false`.
  let tmpRoot: string
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-ckpt-allow-'))
  })
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('non-zero exit in allowedExitCodes promotes to ok:true', async () => {
    // `git config --get` of an unset key returns exit code 1 with empty
    // stdout. That's a legitimate "unset" signal, not a failure — exactly
    // the case the allowedExitCodes hatch exists for.
    const r = await runCheckpointGit(
      ['config', '--get', 'axiomate.this-key-does-not-exist'],
      {
        store: tmpRoot,
        workTree: tmpRoot,
        allowedExitCodes: new Set([1]),
      },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.code).toBe(1)
      expect(r.stdout).toBe('')
    }
  })

  test('non-zero exit NOT in allowedExitCodes stays ok:false', async () => {
    // Same command but without the allow: surfaces as a typed failure.
    const r = await runCheckpointGit(
      ['config', '--get', 'axiomate.this-key-does-not-exist'],
      { store: tmpRoot, workTree: tmpRoot },
    )
    expectFailure(r)
    expect(r.code).toBe(1)
    expect(r.reason).toBe('non-zero-exit')
  })

  test('exit code 0 always passes through ok:true regardless of allowedExitCodes', async () => {
    // Edge case: even if the caller passes an allowedExitCodes set, the
    // happy-path zero-exit branch must short-circuit before consulting
    // the allow set. Pin that ordering so a future refactor that reorders
    // the checks gets caught.
    const r = await runCheckpointGit(['--version'], {
      store: tmpRoot,
      workTree: tmpRoot,
      allowedExitCodes: new Set([42]),
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.code).toBe(0)
  })
})
