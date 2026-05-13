import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { listSessionsImpl, parseSessionInfoFromLite } from './listSessionsImpl.js'
import { query } from './query.js'
import { readSessionLite, resolveSessionFilePath } from './sessionStorage.js'
import type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  Query,
  SDKResultMessage,
  SDKSession,
  SDKSessionInfo,
  SDKSessionOptions,
  SDKUserMessage,
  SessionMessage,
  SessionMutationOptions,
} from './types/index.js'

// ---------------------------------------------------------------------------
// V2 Session API (preview) — convenience wrappers around query()
// ---------------------------------------------------------------------------

export function unstable_v2_createSession(options: SDKSessionOptions): SDKSession {
  const sessionId = options.sessionId ?? randomUUID()

  return {
    get sessionId() {
      return sessionId
    },

    send(message: string | SDKUserMessage): Query {
      const prompt =
        typeof message === 'string'
          ? message
          : (async function* () {
              yield message
            })()

      return query({
        prompt: prompt as string | AsyncIterable<SDKUserMessage>,
        options: {
          ...options,
          sessionId,
          resume: sessionId,
        },
      })
    },

    async close() {
      // Session cleanup is handled by the CLI process
    },
  }
}

export function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions,
): SDKSession {
  return unstable_v2_createSession({ ...options, sessionId, resume: sessionId })
}

export async function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  const q = query({ prompt: message, options })

  let result: SDKResultMessage | undefined

  for await (const msg of q) {
    if (msg.type === 'result') {
      result = msg as SDKResultMessage
    }
  }

  if (!result) {
    throw new Error('No result message received from agent')
  }

  return result
}

// ---------------------------------------------------------------------------
// Filesystem-backed session reads (no CLI subprocess required)
// ---------------------------------------------------------------------------

function liteToSdkSessionInfo(info: ReturnType<typeof parseSessionInfoFromLite>): SDKSessionInfo | undefined {
  if (!info) return undefined
  return {
    id: info.sessionId,
    title: info.customTitle ?? info.summary,
    tag: info.tag,
    createdAt: info.createdAt,
    updatedAt: info.lastModified,
  }
}

export async function listSessions(
  options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]> {
  const sessions = await listSessionsImpl({
    dir: options?.dir,
    limit: options?.limit,
    offset: options?.offset,
  })
  return sessions.map((s) => ({
    id: s.sessionId,
    title: s.customTitle ?? s.summary,
    tag: s.tag,
    createdAt: s.createdAt,
    updatedAt: s.lastModified,
  }))
}

export async function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) return undefined

  const lite = await readSessionLite(resolved.filePath)
  if (!lite) return undefined

  const info = parseSessionInfoFromLite(sessionId, lite, resolved.projectPath)
  return liteToSdkSessionInfo(info)
}

export async function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) return []

  let content: string
  try {
    content = await readFile(resolved.filePath, 'utf8')
  } catch {
    return []
  }

  const includeSystem = options?.includeSystemMessages ?? false
  const offset = options?.offset ?? 0
  const limit = options?.limit
  const allowedTypes = new Set(includeSystem ? ['user', 'assistant', 'system'] : ['user', 'assistant'])

  const messages: SessionMessage[] = []

  for (const line of content.split('\n')) {
    if (!line) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = entry['type']
    if (typeof type !== 'string' || !allowedTypes.has(type)) continue

    let timestamp: number | undefined
    const ts = entry['timestamp']
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts)
      if (!Number.isNaN(parsed)) timestamp = parsed
    } else if (typeof ts === 'number') {
      timestamp = ts
    }

    messages.push({
      uuid: (entry['uuid'] as string) ?? '',
      parentUuid: entry['parentUuid'] as string | undefined,
      type: type as 'user' | 'assistant' | 'system',
      content: entry['message'] ?? entry['content'] ?? entry,
      timestamp,
    })
  }

  const sliced = messages.slice(offset)
  return limit && limit > 0 ? sliced.slice(0, limit) : sliced
}

// ---------------------------------------------------------------------------
// Filesystem-backed session mutations
// ---------------------------------------------------------------------------

async function appendJsonlEntry(
  filePath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const line = JSON.stringify(entry) + '\n'
  await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 })
}

export async function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) {
    throw new Error(`Session not found: ${sessionId}`)
  }
  await appendJsonlEntry(resolved.filePath, {
    type: 'custom-title',
    customTitle: title,
    sessionId,
  })
}

export async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) {
    throw new Error(`Session not found: ${sessionId}`)
  }
  await appendJsonlEntry(resolved.filePath, {
    type: 'tag',
    tag: tag ?? '',
    sessionId,
  })
}

// ---------------------------------------------------------------------------
// Fork session — JSONL transcript copy with UUID remapping
// ---------------------------------------------------------------------------

type RawEntry = Record<string, unknown> & { type?: string; uuid?: string }

export async function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  const sourceContent = await readFile(resolved.filePath, 'utf8')
  if (!sourceContent.trim()) {
    throw new Error('No conversation to branch')
  }

  const sourceEntries: RawEntry[] = []
  for (const line of sourceContent.split('\n')) {
    if (!line) continue
    try {
      sourceEntries.push(JSON.parse(line) as RawEntry)
    } catch {
      // Skip unparseable lines
    }
  }

  const allowedTranscriptTypes = new Set(['user', 'assistant', 'system'])
  const mainConversation = sourceEntries.filter(
    (e) =>
      typeof e['type'] === 'string' &&
      allowedTranscriptTypes.has(e['type']) &&
      !e['isSidechain'],
  )

  if (mainConversation.length === 0) {
    throw new Error('No messages to branch')
  }

  // Truncate at upToMessageId if specified (inclusive)
  let truncated = mainConversation
  if (options?.upToMessageId) {
    const idx = mainConversation.findIndex((e) => e['uuid'] === options.upToMessageId)
    if (idx >= 0) {
      truncated = mainConversation.slice(0, idx + 1)
    }
  }

  const forkSessionId = randomUUID()
  const forkFilePath = resolved.filePath.replace(
    `${sessionId}.jsonl`,
    `${forkSessionId}.jsonl`,
  )

  // Build forked entries: rewrite sessionId, remap parentUuid chain, add forkedFrom
  let parentUuid: string | null = null
  const lines: string[] = []

  for (const entry of truncated) {
    const forked = {
      ...entry,
      sessionId: forkSessionId,
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId,
        messageUuid: entry['uuid'],
      },
    }
    lines.push(JSON.stringify(forked))
    if (entry['type'] !== 'progress' && typeof entry['uuid'] === 'string') {
      parentUuid = entry['uuid']
    }
  }

  // Optional title
  if (options?.title) {
    lines.push(
      JSON.stringify({
        type: 'custom-title',
        customTitle: options.title,
        sessionId: forkSessionId,
      }),
    )
  }

  await mkdir(dirname(forkFilePath), { recursive: true, mode: 0o700 })
  await writeFile(forkFilePath, lines.join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })

  return { sessionId: forkSessionId }
}
