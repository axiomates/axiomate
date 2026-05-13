/**
 * Scheduler engine for axiomate-sdk's `watchScheduledTasks()`.
 *
 * Watches `<dir>/.axiomate/scheduled_tasks.json` and yields events as tasks
 * fire or are detected as missed. Acquires a per-directory PID-based lock
 * so multiple processes watching the same dir don't double-fire.
 *
 * Differences from the upstream CLI scheduler (intentional simplifications):
 * - Uses Node's built-in fs.watch instead of chokidar (no extra deps).
 * - No "session-only" task store — SDK consumers handle ephemeral tasks
 *   themselves; the file is the only source of truth.
 * - No analytics/logging hooks; failures are silent.
 */

import { type FSWatcher, watch } from 'node:fs'
import {
  type LockHandle,
  tryAcquireSchedulerLock,
} from './cronLock.js'
import {
  findMissedTasks,
  getCronFilePath,
  markCronTasksFired,
  readCronTasks,
  removeCronTasks,
} from './cronTasks.js'
import {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from './cron.js'
import type {
  CronJitterConfig,
  CronTask,
  ScheduledTaskEvent,
  ScheduledTasksHandle,
} from './types/index.js'

const CHECK_INTERVAL_MS = 1000
const LOCK_PROBE_INTERVAL_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 10_000

type TaskWithFireTime = CronTask & { nextFireAt: number }

function computeNextFireAt(
  task: CronTask,
  nowMs: number,
  cfg: CronJitterConfig,
): number | null {
  const anchor = task.lastFiredAt ?? task.createdAt
  if (task.recurring) {
    return jitteredNextCronRunMs(task.cron, Math.max(nowMs, anchor), task.id, cfg)
  }
  return oneShotJitteredNextCronRunMs(task.cron, anchor, task.id, cfg)
}

function isRecurringTaskAged(t: CronTask, nowMs: number, maxAgeMs: number): boolean {
  if (maxAgeMs === 0) return false
  return Boolean(t.recurring && nowMs - t.createdAt >= maxAgeMs)
}

type EventQueue = {
  push: (event: ScheduledTaskEvent) => void
  pull: () => Promise<ScheduledTaskEvent | undefined>
  close: () => void
}

function makeEventQueue(): EventQueue {
  const buffer: ScheduledTaskEvent[] = []
  const waiters: Array<(value: ScheduledTaskEvent | undefined) => void> = []
  let closed = false

  return {
    push(event) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) {
        waiter(event)
      } else {
        buffer.push(event)
      }
    },
    pull() {
      return new Promise<ScheduledTaskEvent | undefined>((resolve) => {
        if (buffer.length > 0) {
          resolve(buffer.shift())
          return
        }
        if (closed) {
          resolve(undefined)
          return
        }
        waiters.push(resolve)
      })
    },
    close() {
      if (closed) return
      closed = true
      for (const waiter of waiters) waiter(undefined)
      waiters.length = 0
    },
  }
}

export type WatchScheduledTasksOptions = {
  dir: string
  signal: AbortSignal
  getJitterConfig?: () => CronJitterConfig
}

export function watchScheduledTasks(opts: WatchScheduledTasksOptions): ScheduledTasksHandle {
  const { dir, signal, getJitterConfig } = opts

  const queue = makeEventQueue()
  let lock: LockHandle | null = null
  let lockProbeTimer: ReturnType<typeof setInterval> | null = null
  let checkTimer: ReturnType<typeof setInterval> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let watcher: FSWatcher | null = null
  let pendingReload = false
  let teardownStarted = false

  // Map of taskId → scheduled fire time. Recomputed on every file load.
  let scheduledFires: Map<string, TaskWithFireTime> = new Map()
  let nextFireTime: number | null = null
  let missedEmitted = false

  function getCfg(): CronJitterConfig {
    return getJitterConfig?.() ?? DEFAULT_CRON_JITTER_CONFIG
  }

  function recomputeNextFireTime() {
    let earliest: number | null = null
    for (const t of scheduledFires.values()) {
      if (earliest === null || t.nextFireAt < earliest) earliest = t.nextFireAt
    }
    nextFireTime = earliest
  }

  async function loadTasks() {
    const tasks = await readCronTasks(dir)
    const now = Date.now()
    const cfg = getCfg()

    // Surface missed one-shot tasks once per scheduler lifetime
    if (!missedEmitted) {
      const missed = findMissedTasks(
        tasks.filter((t) => !t.recurring),
        now,
      )
      if (missed.length > 0) {
        queue.push({ type: 'missed', tasks: missed })
        // Delete missed one-shots so they don't fire again
        await removeCronTasks(missed.map((m) => m.id), dir).catch(() => {})
      }
      missedEmitted = true
    }

    const next = new Map<string, TaskWithFireTime>()
    const expiredIds: string[] = []
    for (const t of tasks) {
      if (isRecurringTaskAged(t, now, cfg.recurringMaxAgeMs)) {
        expiredIds.push(t.id)
        continue
      }
      const fireAt = computeNextFireAt(t, now, cfg)
      if (fireAt === null) continue
      next.set(t.id, { ...t, nextFireAt: fireAt })
    }
    scheduledFires = next
    recomputeNextFireTime()

    if (expiredIds.length > 0) {
      await removeCronTasks(expiredIds, dir).catch(() => {})
    }
  }

  async function tick() {
    if (teardownStarted) return
    const now = Date.now()
    if (nextFireTime === null || now < nextFireTime) return

    const fired: TaskWithFireTime[] = []
    const oneShotIds: string[] = []
    const recurringIds: string[] = []

    for (const t of scheduledFires.values()) {
      if (now < t.nextFireAt) continue
      fired.push(t)
      if (t.recurring) {
        recurringIds.push(t.id)
      } else {
        oneShotIds.push(t.id)
      }
    }

    if (fired.length === 0) return

    // Remove one-shots from disk so we don't re-fire
    if (oneShotIds.length > 0) {
      await removeCronTasks(oneShotIds, dir).catch(() => {})
    }

    // Stamp recurring lastFiredAt
    if (recurringIds.length > 0) {
      await markCronTasksFired(recurringIds, now, dir).catch(() => {})
    }

    // Yield fire events
    for (const t of fired) {
      const { nextFireAt: _unused, ...task } = t
      queue.push({ type: 'fire', task })
    }

    // Recompute fire schedule with fresh timestamps
    await loadTasks()
  }

  async function tryAcquireLock(): Promise<boolean> {
    if (lock) return true
    lock = await tryAcquireSchedulerLock(dir)
    if (!lock) return false

    // Start scheduling work
    await loadTasks()

    checkTimer = setInterval(() => {
      tick().catch(() => {})
    }, CHECK_INTERVAL_MS)

    heartbeatTimer = setInterval(() => {
      lock?.heartbeat().catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)

    // Watch the file for changes
    try {
      watcher = watch(getCronFilePath(dir), { persistent: false }, () => {
        if (pendingReload) return
        pendingReload = true
        setTimeout(() => {
          pendingReload = false
          loadTasks().catch(() => {})
        }, 300)
      })
      // Ignore file-not-found errors — the file may not exist yet
      watcher.on('error', () => {})
    } catch {
      // File doesn't exist yet; rely on the periodic check + lock probe
    }

    return true
  }

  function startLockProbe() {
    if (lockProbeTimer) return
    lockProbeTimer = setInterval(() => {
      if (teardownStarted || lock) return
      tryAcquireLock().catch(() => {})
    }, LOCK_PROBE_INTERVAL_MS)
  }

  async function teardown() {
    if (teardownStarted) return
    teardownStarted = true

    if (checkTimer) clearInterval(checkTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (lockProbeTimer) clearInterval(lockProbeTimer)
    checkTimer = null
    heartbeatTimer = null
    lockProbeTimer = null

    if (watcher) {
      try {
        watcher.close()
      } catch {
        // ignore
      }
      watcher = null
    }

    if (lock) {
      await lock.release()
      lock = null
    }

    queue.close()
  }

  signal.addEventListener(
    'abort',
    () => {
      teardown().catch(() => {})
    },
    { once: true },
  )

  // Kick off lock acquisition / probe
  tryAcquireLock()
    .then((acquired) => {
      if (!acquired) startLockProbe()
    })
    .catch(() => {
      startLockProbe()
    })

  async function* events(): AsyncGenerator<ScheduledTaskEvent> {
    while (true) {
      const event = await queue.pull()
      if (event === undefined) return
      yield event
    }
  }

  return {
    events,
    getNextFireTime(): number | null {
      return nextFireTime
    },
  }
}
