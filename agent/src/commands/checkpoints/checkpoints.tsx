/**
 * `/checkpoints` slash command — sub-arg dispatcher.
 *
 * Subcommands (matches `axiomate checkpoints` CLI shape, Hermes parity
 * `hermes_cli/checkpoints.py::cmd_prune` / `::cmd_clear`):
 *   `/checkpoints`            → status (also `/checkpoints status`)
 *   `/checkpoints list`       → read-only snapshot list for cwd
 *   `/checkpoints prune`      → run prune now (`force`)
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
 * Parse a positional row count from the rest tokens of `/checkpoints
 * status` or `/checkpoints list` (e.g. `/checkpoints status 50`).
 *
 * Slash commands follow positional-arg style; the `--rows N` flag form
 * lives only on the CLI side. Returns `{ rows }` on success, `{ error }`
 * on a malformed value, or `{}` when the token is absent.
 *
 * Range-checks to [1..500] to match the resolver's clamp range.
 */
function parsePositionalRows(
  tokens: readonly string[],
): { rows?: number } | { error: string } {
  if (tokens.length === 0) return {}
  if (tokens.length > 1) {
    return {
      error:
        `Unexpected extra arguments: ${tokens.slice(1).join(' ')}. ` +
        `Usage: /checkpoints status [N] or /checkpoints list [N].`,
    }
  }
  const raw = tokens[0]!
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
    return {
      error:
        `Invalid row count: ${raw}. Expected an integer in [1..500] (e.g. /checkpoints status 50).`,
    }
  }
  return { rows: n }
}

/**
 * Parse the rest tokens of `/checkpoints prune`. Allowlist `force` and
 * `keep-orphans` as positional subwords (slash convention — no `--`
 * prefix). Anything else is a typo and gets rejected so a fat-fingered
 * `frce` doesn't silently run a default prune. The CLI side
 * (`axiomate checkpoints prune --force`) keeps POSIX-style flags.
 */
function parsePruneFlags(
  tokens: readonly string[],
): { force: boolean; keepOrphans: boolean } | { error: string } {
  let force = false
  let keepOrphans = false
  for (const token of tokens) {
    if (token === '') continue
    if (token === 'force') force = true
    else if (token === 'keep-orphans') keepOrphans = true
    else {
      return {
        error:
          `Unknown argument: ${token}. ` +
          `Usage: /checkpoints prune [force] [keep-orphans].`,
      }
    }
  }
  return { force, keepOrphans }
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
      const rowsParsed = parsePositionalRows(tokens)
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
      const rowsParsed = parsePositionalRows(tokens)
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
      const tokens = parsed.rest === '' ? [] : parsed.rest.split(/\s+/)
      const flagsParsed = parsePruneFlags(tokens)
      if ('error' in flagsParsed) {
        onDone(flagsParsed.error)
        return null
      }
      const report = await pruneCheckpoints({
        forceNow: flagsParsed.force,
        keepOrphans: flagsParsed.keepOrphans,
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
export const _internal = { parseSub, parsePositionalRows, parsePruneFlags }
