/**
 * `/checkpoints` slash command — sub-arg dispatcher.
 *
 * Subcommands (matches `axiomate checkpoints` CLI shape, Hermes parity
 * `hermes_cli/checkpoints.py:158-237`):
 *   `/checkpoints`            → status (also `/checkpoints status`)
 *   `/checkpoints list`       → read-only snapshot list for cwd
 *   `/checkpoints prune`      → run prune now (`--force`)
 *   `/checkpoints clear`      → confirm + nuke `~/.axiomate/checkpoints/`
 *
 * One divergence: `/checkpoints list` is read-only; the interactive
 * rollback selector lives in `/rewind`, which keeps `appState.fileHistory`
 * in sync with the worktree (REPL.tsx:4007-4013). Cross-session rollback
 * via the store-level commit list is intentionally *not* offered here —
 * that would desync REPL state. See progress doc Phase 5 step 3.
 */

import React from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { listSnapshots } from '../../utils/checkpoints/listSnapshots.js'
import { pruneCheckpoints } from '../../utils/checkpoints/prune.js'
import { storeStatus } from '../../utils/checkpoints/storeStatus.js'
import { startClearFlow } from './ClearView.js'
import {
  renderList,
  renderPruneReport,
  renderStatus,
} from './views.js'

type Sub = 'status' | 'list' | 'prune' | 'clear'

function parseSub(args: string): { sub: Sub; rest: string } | { error: string } {
  const trimmed = args.trim()
  if (trimmed === '') return { sub: 'status', rest: '' }
  const [head, ...rest] = trimmed.split(/\s+/)
  if (head === 'status' || head === 'list' || head === 'prune' || head === 'clear') {
    return { sub: head, rest: rest.join(' ') }
  }
  return {
    error:
      `Unknown subcommand: ${head}. ` +
      `Valid: status, list, prune, clear. (Or no argument for status.)`,
  }
}

export async function call(
  onDone: (result?: string) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode | null> {
  const parsed = parseSub(args ?? '')
  if ('error' in parsed) {
    onDone(parsed.error)
    return null
  }

  switch (parsed.sub) {
    case 'status': {
      const report = await storeStatus()
      onDone(renderStatus(report))
      return null
    }
    case 'list': {
      const cwd = getOriginalCwd()
      const entries = await listSnapshots(cwd)
      onDone(renderList(cwd, entries))
      return null
    }
    case 'prune': {
      const force = parsed.rest.split(/\s+/).includes('--force')
      const report = await pruneCheckpoints({ forceNow: force })
      onDone(renderPruneReport(report))
      return null
    }
    case 'clear': {
      return await startClearFlow(onDone)
    }
  }
}

// Exposed for the CLI subcommand and tests so the same parser/dispatcher
// table stays the single source of truth for valid sub-args.
export const _internal = { parseSub }
