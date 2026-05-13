/**
 * Read/write `<dir>/.axiomate/scheduled_tasks.json`.
 *
 * File format: { "tasks": [{ id, cron, prompt, createdAt, lastFiredAt?, recurring?, permanent? }] }
 *
 * Tasks with invalid cron strings or missing required fields are silently
 * dropped on read so a single bad entry doesn't block the whole file.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseCronExpression, nextCronRunMs } from './cron.js'
import type { CronTask } from './types/index.js'

const TASKS_FILE_REL = join('.axiomate', 'scheduled_tasks.json')

export function getCronFilePath(dir: string): string {
  return join(dir, TASKS_FILE_REL)
}

type CronFile = { tasks: CronTask[] }

export async function readCronTasks(dir: string): Promise<CronTask[]> {
  let raw: string
  try {
    raw = await readFile(getCronFilePath(dir), 'utf8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (!parsed || typeof parsed !== 'object') return []
  const file = parsed as Partial<CronFile>
  if (!Array.isArray(file.tasks)) return []

  const out: CronTask[] = []
  for (const t of file.tasks) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.cron !== 'string' ||
      typeof t.prompt !== 'string' ||
      typeof t.createdAt !== 'number'
    ) {
      continue
    }
    if (!parseCronExpression(t.cron)) continue
    out.push({
      id: t.id,
      cron: t.cron,
      prompt: t.prompt,
      createdAt: t.createdAt,
      ...(typeof (t as { lastFiredAt?: number }).lastFiredAt === 'number'
        ? { lastFiredAt: (t as { lastFiredAt?: number }).lastFiredAt }
        : {}),
      ...(t.recurring ? { recurring: true } : {}),
    })
  }
  return out
}

export async function writeCronTasks(tasks: CronTask[], dir: string): Promise<void> {
  const filePath = getCronFilePath(dir)
  await mkdir(dirname(filePath), { recursive: true })
  const body: CronFile = { tasks }
  await writeFile(filePath, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

export async function markCronTasksFired(
  ids: string[],
  firedAt: number,
  dir: string,
): Promise<void> {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  let changed = false
  for (const t of tasks) {
    if (idSet.has(t.id)) {
      ;(t as CronTask & { lastFiredAt?: number }).lastFiredAt = firedAt
      changed = true
    }
  }
  if (!changed) return
  await writeCronTasks(tasks, dir)
}

export async function removeCronTasks(ids: string[], dir: string): Promise<void> {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  const remaining = tasks.filter((t) => !idSet.has(t.id))
  if (remaining.length === tasks.length) return
  await writeCronTasks(remaining, dir)
}

/**
 * Find tasks whose next scheduled run (computed from createdAt) is in the past.
 * Used to surface tasks that fired while the daemon was offline.
 */
export function findMissedTasks(tasks: CronTask[], nowMs: number): CronTask[] {
  return tasks.filter((t) => {
    const next = nextCronRunMs(t.cron, t.createdAt)
    return next !== null && next < nowMs
  })
}
