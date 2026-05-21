/**
 * `axiomate checkpoints` CLI subcommand handlers.
 *
 * Each handler owns its own `process.exit` code:
 *   - 0 on success
 *   - 1 on a captured failure that the user can act on (e.g. clear
 *     reported `errors[]`)
 *
 * Handlers reuse the pure renderers from `commands/checkpoints/views.ts`
 * so the slash command and the CLI print identical output. The single
 * divergence is `clear`: in the slash command it shows a confirm dialog;
 * in the CLI we require `--force` (matches Hermes `cmd_clear` style at
 * `hermes_cli/checkpoints.py::cmd_clear` — Hermes prompts; we prefer a
 * non-interactive `--force` because users will sometimes pipe this in
 * scripts and prompts hang).
 */

import { clearAll } from '../../utils/checkpoints/clearAll.js'
import { listSnapshots } from '../../utils/checkpoints/listSnapshots.js'
import { pruneCheckpoints } from '../../utils/checkpoints/prune.js'
import { storeStatus } from '../../utils/checkpoints/storeStatus.js'
import { getCwd } from '../../utils/cwd.js'
import { formatBytes } from '../../commands/checkpoints/format.js'
import {
  renderList,
  renderPruneReport,
  renderStatus,
} from '../../commands/checkpoints/views.js'

export async function checkpointsStatusHandler(): Promise<void> {
  const report = await storeStatus()
  console.log(renderStatus(report))
}

export async function checkpointsListHandler(): Promise<void> {
  const cwd = getCwd()
  const entries = await listSnapshots(cwd)
  console.log(renderList(cwd, entries))
}

export interface CheckpointsPruneOptions {
  retentionDays?: number | string
  maxSizeMb?: number | string
  force?: boolean
}

export async function checkpointsPruneHandler(
  opts: CheckpointsPruneOptions,
): Promise<void> {
  const retentionDays =
    opts.retentionDays !== undefined ? Number(opts.retentionDays) : undefined
  const maxTotalSizeMb =
    opts.maxSizeMb !== undefined ? Number(opts.maxSizeMb) : undefined
  if (
    (opts.retentionDays !== undefined && !Number.isFinite(retentionDays)) ||
    (opts.maxSizeMb !== undefined && !Number.isFinite(maxTotalSizeMb))
  ) {
    console.error(
      'Invalid numeric option. --retention-days and --max-size-mb must be numbers.',
    )
    process.exit(1)
  }
  const report = await pruneCheckpoints({
    retentionDays,
    maxTotalSizeMb,
    forceNow: opts.force === true,
  })
  console.log(renderPruneReport(report))
  if (report.errors.length > 0) process.exit(1)
}

export interface CheckpointsClearOptions {
  force?: boolean
}

/**
 * Non-interactive clear. Without `--force` we abort with a one-line
 * message — diverges from the slash command's confirm dialog because
 * a CLI subcommand can't safely prompt when stdin is piped or when run
 * from a script.
 */
export async function checkpointsClearHandler(
  opts: CheckpointsClearOptions,
): Promise<void> {
  if (opts.force !== true) {
    console.error(
      'Refusing to clear without --force. ' +
        'This deletes ~/.axiomate/checkpoints/ and cannot be undone.',
    )
    process.exit(1)
  }
  const status = await storeStatus()
  if (status.total_size_bytes === 0 && status.project_count === 0) {
    console.log(`Nothing to clear at ${status.base}.`)
    return
  }
  const report = await clearAll()
  if (report.deleted) {
    console.log(
      `Cleared ${formatBytes(report.bytes_freed)} from ${status.base}.`,
    )
    return
  }
  console.error(
    `Could not clear ${status.base} (${formatBytes(report.bytes_freed)} on disk):`,
  )
  for (const e of report.errors) console.error(`  - ${e}`)
  process.exit(1)
}
