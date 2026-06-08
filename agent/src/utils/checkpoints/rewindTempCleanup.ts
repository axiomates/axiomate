/**
 * Cleanup helpers for rewind transaction temp directories.
 *
 * Rewind reconciliation writes large NUL pathspec files and a scratch
 * index under os.tmpdir()/axiomate-rewind-*. Normal transactions remove
 * their own temp directory in finally; this helper is the janitor for
 * crash/kill leftovers.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from 'fs'
import { rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logForDebugging } from '../debug.js'

export const REWIND_TEMP_PREFIX = 'axiomate-rewind-'
export const REWIND_TEMP_OWNER_FILE = '.axiomate-owner.json'
export const PRUNE_REWIND_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000
const REWIND_TEMP_ROOT_ENV = 'AXIOMATE_REWIND_TEMP_ROOT_FOR_TESTING'

export interface RewindTempCleanupReport {
  dirsRemoved: number
  bytesFreed: number
  skippedYoung: number
  skippedActive: number
  errors: string[]
}

export interface CleanupRewindTempDirsOptions {
  /**
   * When set, only delete directories whose mtime is at least this old.
   * Used by prune so it cannot delete a normal in-flight rewind.
   */
  olderThanMs?: number
  /**
   * When true, delete matching temp dirs even if their owner pid appears
   * alive. Intended only for explicit /checkpoints clear.
   */
  includeActive?: boolean
  nowMs?: number
  tempRoot?: string
}

export async function writeRewindTempOwnerFile(tempDir: string): Promise<void> {
  const payload = JSON.stringify({
    pid: process.pid,
    createdAtMs: Date.now(),
  })
  await writeFile(join(tempDir, REWIND_TEMP_OWNER_FILE), payload, 'utf-8')
}

export function getRewindTempRoot(): string {
  return process.env[REWIND_TEMP_ROOT_ENV] || tmpdir()
}

export async function cleanupRewindTempDirs(
  options: CleanupRewindTempDirsOptions = {},
): Promise<RewindTempCleanupReport> {
  const report: RewindTempCleanupReport = {
    dirsRemoved: 0,
    bytesFreed: 0,
    skippedYoung: 0,
    skippedActive: 0,
    errors: [],
  }
  const root = options.tempRoot ?? getRewindTempRoot()
  const nowMs = options.nowMs ?? Date.now()
  const includeActive = options.includeActive === true

  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    report.errors.push(`readdir ${root}: ${msg}`)
    return report
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(REWIND_TEMP_PREFIX)) continue
    const full = join(root, entry.name)
    let stat
    try {
      stat = lstatSync(full)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      report.errors.push(`lstat ${full}: ${msg}`)
      continue
    }
    if (!stat.isDirectory()) continue

    if (options.olderThanMs !== undefined) {
      const ageMs = nowMs - stat.mtimeMs
      if (!Number.isFinite(ageMs) || ageMs < options.olderThanMs) {
        report.skippedYoung++
        continue
      }
    }
    if (!includeActive && ownerProcessAppearsAlive(full)) {
      report.skippedActive++
      continue
    }

    const bytes = dirSizeBytesBestEffort(full)
    try {
      await rm(full, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
      report.dirsRemoved++
      report.bytesFreed += bytes
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      report.errors.push(`rm ${full}: ${msg}`)
      logForDebugging(`rewindTempCleanup: rm failed for ${full}: ${msg}`)
    }
  }
  return report
}

function ownerProcessAppearsAlive(tempDir: string): boolean {
  const ownerPath = join(tempDir, REWIND_TEMP_OWNER_FILE)
  if (!existsSync(ownerPath)) return false
  try {
    const parsed = JSON.parse(readFileSync(ownerPath, 'utf-8')) as { pid?: unknown }
    const pid = parsed.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return false
    }
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'EPERM'
    }
  } catch {
    return false
  }
}

function dirSizeBytesBestEffort(path: string): number {
  let total = 0
  const stack: string[] = [path]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile()) {
          total += statSync(full).size
        }
      } catch {
        // File may vanish while cleanup is walking it.
      }
    }
  }
  return total
}
