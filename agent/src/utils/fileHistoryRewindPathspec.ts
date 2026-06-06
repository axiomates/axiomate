import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { open, rename, rm, stat } from 'fs/promises'
import { gitExe } from './git.js'
import { checkpointGitEnv } from './checkpoints/gitEnv.js'
import { DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS } from './checkpoints/git.js'
import { normalizePath } from './checkpoints/paths.js'

type ByteChunk = Buffer | string | Uint8Array

export type StreamGitPathspecResult =
  | { ok: true; path: string; count: number }
  | {
      ok: false
      reason: 'non-zero-exit' | 'timeout' | 'git-not-found' | 'spawn-error'
      code: number
      stderr: string
      message: string
    }

export async function writeAtomicPathspecFromStream(
  chunks: AsyncIterable<ByteChunk>,
  finalPath: string,
): Promise<{ path: string; count: number }> {
  const tempPath = `${finalPath}.tmp-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let count = 0
  let hasRecordBytes = false
  try {
    handle = await open(tempPath, 'wx')
    for await (const chunk of chunks) {
      const buffer = toBuffer(chunk)
      for (const byte of buffer) {
        if (byte === 0) {
          if (hasRecordBytes) count++
          hasRecordBytes = false
        } else {
          hasRecordBytes = true
        }
      }
      await handle.write(buffer)
    }
    await handle.close()
    handle = undefined
    await rename(tempPath, finalPath)
    return { path: finalPath, count }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

export async function* readNulPathspecFile(
  pathspecFile: string,
): AsyncGenerator<string> {
  let pending = Buffer.alloc(0)
  for await (const chunk of createReadStream(pathspecFile)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const combined = pending.length === 0 ? buffer : Buffer.concat([pending, buffer])
    let recordStart = 0
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] !== 0) continue
      if (i > recordStart) {
        yield combined.subarray(recordStart, i).toString('utf-8')
      }
      recordStart = i + 1
    }
    pending = combined.subarray(recordStart)
  }
  if (pending.length > 0) {
    yield pending.toString('utf-8')
  }
}

export async function countNulRecordsFromChunks(
  chunks: AsyncIterable<ByteChunk>,
): Promise<number> {
  let count = 0
  let hasRecordBytes = false
  for await (const chunk of chunks) {
    const buffer = toBuffer(chunk)
    for (const byte of buffer) {
      if (byte === 0) {
        if (hasRecordBytes) count++
        hasRecordBytes = false
      } else {
        hasRecordBytes = true
      }
    }
  }
  return count
}

export async function streamGitPathspecFromDiff(args: {
  store: string
  workTree: string
  indexFile: string
  gitArgs: string[]
  pathspecFile: string
  timeoutMs?: number
}): Promise<StreamGitPathspecResult> {
  const workTree = normalizePath(args.workTree)
  try {
    const st = await stat(workTree)
    if (!st.isDirectory()) {
      return failure('spawn-error', -1, '', `working directory is not a directory: ${workTree}`)
    }
  } catch {
    return failure('spawn-error', -1, '', `working directory not found: ${workTree}`)
  }

  const pendingPath = `${args.pathspecFile}.pending-${randomUUID()}`
  const timeoutMs = args.timeoutMs ?? resolveTimeoutMs()
  const child = spawn(gitExe(), args.gitArgs, {
    cwd: workTree,
    env: checkpointGitEnv({
      store: args.store,
      workTree,
      indexFile: args.indexFile,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)

  const stderrPromise = collectBoundedStderr(child.stderr)
  const exitPromise = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code: code ?? -1, signal }))
  })

  try {
    if (!child.stdout) {
      child.kill()
      const stderr = await stderrPromise
      return failure('spawn-error', -1, stderr, 'git stdout stream unavailable')
    }

    const written = await writeAtomicPathspecFromStream(child.stdout, pendingPath)
    const exit = await exitPromise
    const stderr = await stderrPromise
    clearTimeout(timer)

    if (timedOut) {
      await rm(pendingPath, { force: true }).catch(() => {})
      return failure('timeout', exit.code, stderr, `git timed out after ${timeoutMs}ms`)
    }
    if (exit.code !== 0) {
      await rm(pendingPath, { force: true }).catch(() => {})
      return failure('non-zero-exit', exit.code, stderr, stderr || `git exited with code ${exit.code}`)
    }

    await rename(pendingPath, args.pathspecFile)
    return { ok: true, path: args.pathspecFile, count: written.count }
  } catch (error) {
    clearTimeout(timer)
    child.kill()
    await exitPromise.catch(() => {})
    const stderr = await stderrPromise.catch(() => '')
    await rm(pendingPath, { force: true }).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    const reason = message.toLowerCase().includes('enoent') ? 'git-not-found' : 'spawn-error'
    return failure(reason, -1, stderr, message)
  }
}

function resolveTimeoutMs(): number {
  const raw = process.env.AXIOMATE_CHECKPOINT_TIMEOUT
  if (!raw) return DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS
  const seconds = Number.parseInt(raw, 10)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS
  }
  const clamped = Math.max(10, Math.min(600, seconds))
  return clamped * 1000
}

function toBuffer(chunk: ByteChunk): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf-8')
  return Buffer.from(chunk)
}

async function collectBoundedStderr(
  stream: NodeJS.ReadableStream | null,
  maxBytes = 64 * 1024,
): Promise<string> {
  if (!stream) return ''
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = toBuffer(chunk as ByteChunk)
    if (size >= maxBytes) continue
    const take = buffer.subarray(0, maxBytes - size)
    chunks.push(take)
    size += take.length
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function failure(
  reason: 'non-zero-exit' | 'timeout' | 'git-not-found' | 'spawn-error',
  code: number,
  stderr: string,
  message: string,
): StreamGitPathspecResult {
  return { ok: false, reason, code, stderr, message }
}
