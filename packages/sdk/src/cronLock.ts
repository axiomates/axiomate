/**
 * Per-directory scheduler lock to prevent duplicate fires when multiple
 * processes watch the same scheduled_tasks.json. PID-based liveness; stale
 * locks (dead PID, mismatched hostname, expired heartbeat) are reclaimed.
 *
 * Lock file path: <dir>/.axiomate/scheduler.lock
 */

import { open, readFile, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'

type LockContent = {
  pid: number
  hostname: string
  /** Epoch ms — refreshed by the holder every heartbeat. */
  heartbeatAt: number
  /** Random per-acquire token, lets the holder verify it still owns the lock. */
  token: string
}

export type LockHandle = {
  token: string
  filePath: string
  release(): Promise<void>
  heartbeat(): Promise<void>
}

const HEARTBEAT_STALE_MS = 30_000

function lockPath(dir: string): string {
  return join(dir, '.axiomate', 'scheduler.lock')
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    // Signal 0 doesn't actually kill — it tests for existence.
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM = process exists but we lack permission — treat as alive
    return code === 'EPERM'
  }
}

async function readLock(filePath: string): Promise<LockContent | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as LockContent
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.heartbeatAt !== 'number' ||
      typeof parsed.token !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function isStale(lock: LockContent, nowMs: number): boolean {
  // Different host — we can't check liveness, fall back to heartbeat staleness
  if (lock.hostname !== hostname()) {
    return nowMs - lock.heartbeatAt > HEARTBEAT_STALE_MS
  }
  // Same host — definitive PID check
  if (!isProcessAlive(lock.pid)) return true
  return nowMs - lock.heartbeatAt > HEARTBEAT_STALE_MS
}

export async function tryAcquireSchedulerLock(dir: string): Promise<LockHandle | null> {
  const filePath = lockPath(dir)
  await mkdir(dirname(filePath), { recursive: true })

  const myToken = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const content: LockContent = {
    pid: process.pid,
    hostname: hostname(),
    heartbeatAt: Date.now(),
    token: myToken,
  }

  // Atomic create via O_EXCL ('wx')
  try {
    const fh = await open(filePath, 'wx')
    await fh.writeFile(JSON.stringify(content), 'utf8')
    await fh.close()
    return makeHandle(filePath, myToken)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
  }

  // Lock exists — check staleness, try to steal
  const existing = await readLock(filePath)
  if (!existing) {
    // Unreadable lock file — try to remove and retry
    try {
      await unlink(filePath)
    } catch {
      return null
    }
    return tryAcquireSchedulerLock(dir)
  }

  if (!isStale(existing, Date.now())) return null

  // Stale: rewrite atomically — write then read-back to confirm we won
  await writeFile(filePath, JSON.stringify(content), 'utf8')
  const after = await readLock(filePath)
  if (after && after.token === myToken) {
    return makeHandle(filePath, myToken)
  }
  return null
}

function makeHandle(filePath: string, token: string): LockHandle {
  let released = false
  return {
    token,
    filePath,
    async release() {
      if (released) return
      released = true
      try {
        const current = await readLock(filePath)
        if (current?.token === token) {
          await unlink(filePath)
        }
      } catch {
        // best-effort cleanup
      }
    },
    async heartbeat() {
      if (released) return
      try {
        const current = await readLock(filePath)
        if (!current || current.token !== token) return
        current.heartbeatAt = Date.now()
        await writeFile(filePath, JSON.stringify(current), 'utf8')
      } catch {
        // best-effort
      }
    },
  }
}
