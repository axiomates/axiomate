/**
 * Resolve the row count to render in `/checkpoints status` and
 * `/checkpoints list`.
 *
 * Priority (highest first):
 *   1. Explicit per-call override (e.g. `--rows N` from CLI/slash command)
 *   2. `globalConfig.checkpointsStatusRows`
 *   3. Hard-coded fallback `20` — matches Hermes' default and the historical
 *      `renderStatus(report, limit = 20)` signature.
 *
 * Invariants the caller can rely on:
 *   - Returns a finite integer in `[1, 500]`. Out-of-range or non-integer
 *     values from config silently fall back to 20 — config writes go through
 *     ConfigTool which already rejects bad values, but this defends against
 *     hand-edited `~/.axiomate.json`.
 */

import { getGlobalConfig } from '../../utils/config.js'

export const ROWS_MIN = 1
export const ROWS_MAX = 500
export const ROWS_FALLBACK = 20

export function resolveStatusRows(override?: number): number {
  if (override !== undefined) return clamp(override)
  const fromConfig = getGlobalConfig().checkpointsStatusRows
  return clamp(fromConfig)
}

function clamp(n: unknown): number {
  if (typeof n !== 'number') return ROWS_FALLBACK
  if (!Number.isFinite(n) || !Number.isInteger(n)) return ROWS_FALLBACK
  if (n < ROWS_MIN || n > ROWS_MAX) return ROWS_FALLBACK
  return n
}
