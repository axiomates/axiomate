import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runCheckpointGit, type CheckpointGitResult } from '../git.js'

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
})
