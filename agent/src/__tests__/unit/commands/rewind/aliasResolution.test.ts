/**
 * Anchor test for the `/rewind` ↔ `/checkpoints` alias-collision risk.
 *
 * `/rewind` registers the alias `'checkpoint'` (singular) at
 * `commands/rewind/index.ts:6`. Phase 5 introduces a new `/checkpoints`
 * (plural) command. The two are distinct strings, so they coexist — but:
 *
 *   - `findCommand` (`commands.ts:359-369`) is a `commands.find(...)`
 *     scan that returns the FIRST entry where `name === q ||
 *     getCommandName(c) === q || aliases?.includes(q)`. Registration order
 *     therefore decides ties.
 *   - A future contributor renaming the singular `'checkpoint'` alias to
 *     plural `'checkpoints'` (or adding `'checkpoints'` to rewind's
 *     aliases) would silently route every `/checkpoints` invocation to
 *     `rewind` whenever rewind appears earlier in `COMMANDS` — or vice
 *     versa. That kind of swap is impossible to spot in code review;
 *     regression-testing the lookups is the only cheap defense.
 *
 * The test pins the resolution table:
 *
 *   /rewind       → rewind
 *   /checkpoint   → rewind   (singular alias — must NOT be claimed by /checkpoints)
 *   /checkpoints  → checkpoints   (plural — must NOT be claimed by rewind)
 *
 * It uses synthetic command objects rather than the real `COMMANDS` array
 * so it stays independent of how/when the new command lands. Synthetic
 * objects intentionally cover both registration orderings — if either
 * order ever resolves wrong, the failure surfaces here.
 */

import { describe, expect, test } from 'vitest'
import { findCommand } from '../../../../commands.js'
import type { Command } from '../../../../commands.js'
import rewind from '../../../../commands/rewind/index.js'

function makeCheckpointsStub(): Command {
  return {
    description: 'Manage filesystem checkpoint store (Phase 5 placeholder)',
    name: 'checkpoints',
    argumentHint: '',
    type: 'local-jsx',
    load: () =>
      Promise.resolve({
        call: () => Promise.resolve(null),
      }),
  } satisfies Command
}

describe('/rewind ↔ /checkpoints alias resolution', () => {
  test('rewind resolves /rewind, /checkpoint (singular) — alone', () => {
    const commands: Command[] = [rewind]
    expect(findCommand('rewind', commands)?.name).toBe('rewind')
    expect(findCommand('checkpoint', commands)?.name).toBe('rewind')
    expect(findCommand('checkpoints', commands)).toBeUndefined()
  })

  test('with /checkpoints registered AFTER /rewind: singular still routes to rewind, plural to checkpoints', () => {
    const commands: Command[] = [rewind, makeCheckpointsStub()]
    expect(findCommand('rewind', commands)?.name).toBe('rewind')
    expect(findCommand('checkpoint', commands)?.name).toBe('rewind')
    expect(findCommand('checkpoints', commands)?.name).toBe('checkpoints')
  })

  test('with /checkpoints registered BEFORE /rewind: same resolutions hold (ties are impossible by design)', () => {
    const commands: Command[] = [makeCheckpointsStub(), rewind]
    expect(findCommand('rewind', commands)?.name).toBe('rewind')
    expect(findCommand('checkpoint', commands)?.name).toBe('rewind')
    expect(findCommand('checkpoints', commands)?.name).toBe('checkpoints')
  })

  test('rewind aliases array is exactly ["checkpoint"] (defends future addition of "checkpoints" to rewind)', () => {
    expect(rewind.aliases).toEqual(['checkpoint'])
  })
})
