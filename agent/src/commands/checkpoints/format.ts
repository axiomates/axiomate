/**
 * Pure formatters for `/checkpoints` and `axiomate checkpoints` views.
 *
 * Mirrors Hermes `_fmt_bytes` / `_fmt_age`
 * (`hermes_cli/checkpoints.py::_fmt_bytes` / `::_fmt_age`) with one
 * divergence: `formatBytes` here delegates to axiomate's existing
 * `formatFileSize` (`utils/format.ts:9`) when the value fits its grammar
 * ("1.5KB"). Hermes prints "1.5 KB" with a space; axiomate's house style
 * is no space — pick one and stay consistent.
 *
 * Kept leaf-only (no Ink, no React) so the same module backs the slash
 * command, the CLI subcommand, and tests.
 */

import { formatFileSize } from '../../utils/format.js'

export const formatBytes = formatFileSize

/** "now" / "12s ago" / "5m ago" / "3h ago" / "9d ago" / "—" on bad input. */
export function formatAge(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '—'
  const ageSec = Date.now() / 1000 - epochSeconds
  if (ageSec < 0) return 'now'
  if (ageSec < 60) return `${Math.floor(ageSec)}s ago`
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`
  return `${Math.floor(ageSec / 86400)}d ago`
}

/** "2026-05-21 14:30" / "—" on bad input. */
export function formatTimestamp(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '—'
  const d = new Date(epochSeconds * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/**
 * Right-truncate to `width`, replacing the leading characters with `…`
 * when the string overflows. Mirrors Hermes' "…" + tail-59 trick at
 * `hermes_cli/checkpoints.py::cmd_status` so the workdir column lines up.
 */
export function ellipsisLeft(s: string, width: number): string {
  if (s.length <= width) return s
  return '…' + s.slice(-(width - 1))
}

/** Pad-right to `width` for monospace column alignment. */
export function padRight(s: string, width: number): string {
  if (s.length >= width) return s
  return s + ' '.repeat(width - s.length)
}

/** Pad-left to `width` for monospace right-aligned columns. */
export function padLeft(s: string, width: number): string {
  if (s.length >= width) return s
  return ' '.repeat(width - s.length) + s
}
