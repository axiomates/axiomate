import { watchScheduledTasks as watchScheduledTasksImpl } from './scheduler.js'
import type {
  ConnectRemoteControlOptions,
  CronJitterConfig,
  CronTask,
  RemoteControlHandle,
  ScheduledTasksHandle,
} from './types/index.js'

/**
 * Watch `<dir>/.axiomate/scheduled_tasks.json` and yield events as tasks fire.
 *
 * Acquires a per-directory PID-based scheduler lock so multiple processes
 * watching the same dir won't double-fire. Non-owning processes periodically
 * probe the lock and take over if the holder dies.
 *
 * - `fire` — a task whose cron schedule was met. One-shot tasks are deleted
 *   from the file before the event is emitted; recurring tasks get their
 *   `lastFiredAt` stamped.
 * - `missed` — one-shot tasks whose window passed while the daemon was down.
 *   Yielded once on initial load; deleted from the file shortly after.
 *
 * Drain events with `for await (const event of handle.events()) { ... }`.
 * The generator returns when `signal` aborts.
 */
export function watchScheduledTasks(opts: {
  dir: string
  signal: AbortSignal
  getJitterConfig?: () => CronJitterConfig
}): ScheduledTasksHandle {
  return watchScheduledTasksImpl(opts)
}

/**
 * Format missed one-shot tasks into a prompt that asks the model to confirm
 * with the user before executing. Returns '' when the list is empty.
 */
export function buildMissedTaskNotification(missed: CronTask[]): string {
  if (missed.length === 0) return ''

  const lines = missed.map(
    (t) => `- [${t.id}] "${t.prompt}" (scheduled: ${t.cron})`,
  )

  return [
    `The following scheduled tasks were missed while the daemon was offline:`,
    '',
    ...lines,
    '',
    'Please confirm with the user before executing these tasks.',
  ].join('\n')
}

/**
 * Hold a claude.ai remote-control bridge connection from a daemon process.
 *
 * NOT SUPPORTED in axiomate — the bridge protocol is specific to Anthropic's
 * claude.ai infrastructure (OAuth + WebSocket to claude.ai/api/agent-bridge),
 * which is not applicable to axiomate's multi-provider model.
 *
 * This stub exists only for API compatibility with the upstream Claude Code
 * Agent SDK. Always returns null.
 */
export async function connectRemoteControl(
  _opts: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle | null> {
  return null
}
