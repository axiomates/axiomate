/**
 * T5 (completion-plan 6D) — transient-error injection on `createSnapshot`.
 *
 * The fail-open contract on `createSnapshot` says: any non-allowed git
 * failure (EBUSY on the index, code 2 from rev-parse, spawn errors,
 * timeouts) maps to `{ ok: false, skipped: 'transient-error' }` and
 * never throws. The Phase 3 fileHistory swap depends on this — if a
 * transient error escaped as a thrown exception, tool execution would
 * be blocked for that turn.
 *
 * We can't easily produce code 2 from real git on a happy store, so
 * this file mocks `runCheckpointGit` with a pass-through wrapper that
 * matches a target argv prefix and substitutes a fixture failure
 * result. All other calls forward to the real implementation against
 * the test's real shadow store. This isolates the "what does
 * createSnapshot do when rev-parse fails non-fatally" question without
 * stubbing the entire pipeline.
 *
 * Three injection scenarios:
 *   1. rev-parse returns code 2 (unallowed) → transient-error.
 *   2. read-tree spawn-error while clearing the index → transient-error.
 *   3. update-index returns timeout → transient-error.
 *
 * In every case we assert: result.ok === false, result.skipped ===
 * 'transient-error', no exception escaped, the promise resolved.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import type { CheckpointGitResult } from '../../../../utils/checkpoints/git.js'

/**
 * Shared injection state. Each test sets `INJECT.matcher` + `INJECT.result`
 * and clears them in afterEach. The mock wrapper consults this on every
 * call and either substitutes the fixture result or forwards to the
 * real `runCheckpointGit`.
 */
const INJECT: {
  matcher: ((args: readonly string[]) => boolean) | null
  result: CheckpointGitResult | null
  hits: number
} = { matcher: null, result: null, hits: 0 }

vi.mock('../../../../utils/checkpoints/git.js', async () => {
  const real = await vi.importActual<typeof import('../../../../utils/checkpoints/git.js')>('../../../../utils/checkpoints/git.js')
  return {
    ...real,
    runCheckpointGit: vi.fn(async (args: string[], opts: unknown) => {
      if (INJECT.matcher !== null && INJECT.matcher(args)) {
        INJECT.hits++
        return INJECT.result as CheckpointGitResult
      }
      return real.runCheckpointGit(args, opts as Parameters<typeof real.runCheckpointGit>[1])
    }),
  }
})

// Imports below the mock so they pick up the wrapped runCheckpointGit.
import { ensureStore } from '../../../../utils/checkpoints/store.js'
import { createSnapshot } from '../../../../utils/checkpoints/createSnapshot.js'

let tmpRoot: string
let workTree: string
let originalBase: string | undefined

beforeAll(() => {
  originalBase = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (originalBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalBase
})

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-snap-trans-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
  // Seed something snapshottable so the no-changes branch doesn't mask
  // the injected failure.
  writeFileSync(join(workTree, 'a.txt'), 'hello')
})

afterEach(() => {
  INJECT.matcher = null
  INJECT.result = null
  INJECT.hits = 0
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('createSnapshot — transient-error fail-open', () => {
  test('T5a: rev-parse returns unallowed exit code 2 → transient-error', async () => {
    INJECT.matcher = args =>
      args[0] === 'rev-parse' &&
      args.includes('--verify') &&
      args.some(s => s.endsWith('^{commit}'))
    INJECT.result = {
      ok: false,
      reason: 'non-zero-exit',
      code: 2,
      stdout: '',
      stderr: 'fatal: simulated unallowed failure',
      message: 'rev-parse: simulated',
    }

    const r = await createSnapshot(workTree, {
      messageId: 'msg-trans-rev',
      label: 'turn 1',
    })

    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.skipped).toBe('transient-error')
    expect(INJECT.hits).toBeGreaterThanOrEqual(1)
  })

  test('T5b: read-tree spawn-error while clearing index → transient-error', async () => {
    INJECT.matcher = args => args[0] === 'read-tree'
    INJECT.result = {
      ok: false,
      reason: 'spawn-error',
      code: -1,
      stdout: '',
      stderr: 'EBUSY: resource busy or locked',
      message: 'read-tree: EBUSY',
    }

    const r = await createSnapshot(workTree, {
      messageId: 'msg-trans-rt',
      label: 'turn 2',
    })

    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.skipped).toBe('transient-error')
    expect(INJECT.hits).toBeGreaterThanOrEqual(1)
  })

  test('T5c: update-index timeout → transient-error', async () => {
    INJECT.matcher = args =>
      args[0] === 'update-index' && args.includes('--stdin')
    INJECT.result = {
      ok: false,
      reason: 'timeout',
      code: -1,
      stdout: '',
      stderr: '',
      message: 'update-index: timed out after 60000ms',
    }

    const r = await createSnapshot(workTree, {
      messageId: 'msg-trans-add',
      label: 'turn 1',
    })

    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.skipped).toBe('transient-error')
    expect(INJECT.hits).toBeGreaterThanOrEqual(1)
  })

  test('T5d: never throws — promise always resolves', async () => {
    // Inject a result the type doesn't normally produce — proves the
    // wrapper's resolve-not-throw contract holds even on bizarre inputs.
    INJECT.matcher = args => args[0] === 'rev-parse'
    INJECT.result = {
      ok: false,
      reason: 'non-zero-exit',
      code: 99,
      stdout: '',
      stderr: 'simulated',
      message: 'rev-parse: simulated',
    }

    await expect(
      createSnapshot(workTree, { messageId: 'msg-trans-99', label: 't' }),
    ).resolves.toBeDefined()
  })
})
