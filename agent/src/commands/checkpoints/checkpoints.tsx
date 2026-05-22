/**
 * `/checkpoints` slash command — sub-arg dispatcher.
 *
 * Subcommands (matches `axiomate checkpoints` CLI shape, Hermes parity
 * `hermes_cli/checkpoints.py::cmd_prune` / `::cmd_clear`):
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
import { resolveStatusRows } from './resolveStatusRows.js'

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

/**
 * Parse `--rows N` (or `--rows=N`) from an already-tokenized arg list.
 * Returns `{ rows }` on success, `{ error }` on a malformed value, or
 * `{ rows: undefined }` when the flag is absent.
 *
 * Range-checks to [1..500] to match the CLI handler and the renderer's
 * sane upper bound.
 */
function parseRowsToken(
  tokens: readonly string[],
): { rows?: number } | { error: string } {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    let raw: string | undefined
    if (t === '--rows') raw = tokens[i + 1]
    else if (t.startsWith('--rows=')) raw = t.slice('--rows='.length)
    else continue
    if (raw === undefined || raw === '') {
      return { error: '--rows requires an integer value (e.g. --rows 50).' }
    }
    const n = Number(raw)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
      return { error: `Invalid --rows ${raw}. Expected an integer in [1..500].` }
    }
    return { rows: n }
  }
  return {}
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
      const tokens = parsed.rest === '' ? [] : parsed.rest.split(/\s+/)
      const rowsParsed = parseRowsToken(tokens)
      if ('error' in rowsParsed) {
        onDone(rowsParsed.error)
        return null
      }
      const report = await storeStatus()
      onDone(renderStatus(report, resolveStatusRows(rowsParsed.rows)))
      return null
    }
    case 'list': {
      const tokens = parsed.rest === '' ? [] : parsed.rest.split(/\s+/)
      const rowsParsed = parseRowsToken(tokens)
      if ('error' in rowsParsed) {
        onDone(rowsParsed.error)
        return null
      }
      const cwd = getOriginalCwd()
      const entries = await listSnapshots(cwd)
      onDone(renderList(cwd, entries, resolveStatusRows(rowsParsed.rows)))
      return null
    }
    case 'prune': {
      const tokens = parsed.rest.split(/\s+/)
      const force = tokens.includes('--force')
      const keepOrphans = tokens.includes('--keep-orphans')
      const report = await pruneCheckpoints({
        forceNow: force,
        keepOrphans,
      })
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
export const _internal = { parseSub, parseRowsToken }
