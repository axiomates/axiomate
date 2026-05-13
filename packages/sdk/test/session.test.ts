import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  tagSession,
} from '../src/session.js'
import { getProjectDir, sanitizePath } from '../src/sessionStorage.js'

let tmpRoot: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'axiomate-sdk-test-'))
  originalConfigDir = process.env['AXIOMATE_CONFIG_DIR']
  process.env['AXIOMATE_CONFIG_DIR'] = tmpRoot
})

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env['AXIOMATE_CONFIG_DIR']
  } else {
    process.env['AXIOMATE_CONFIG_DIR'] = originalConfigDir
  }
  await rm(tmpRoot, { recursive: true, force: true })
})

type EntryArg =
  | { type: 'user'; text: string; uuid?: string; parentUuid?: string | null; timestamp?: string }
  | { type: 'assistant'; text: string; uuid?: string; parentUuid?: string; timestamp?: string }
  | { type: 'custom-title'; customTitle: string }
  | { type: 'tag'; tag: string }
  | Record<string, unknown>

function buildEntry(arg: EntryArg): Record<string, unknown> {
  if (arg.type === 'user') {
    const a = arg as { type: 'user'; text: string; uuid?: string; parentUuid?: string | null; timestamp?: string }
    return {
      type: 'user',
      uuid: a.uuid ?? randomUUID(),
      parentUuid: a.parentUuid ?? null,
      timestamp: a.timestamp ?? new Date().toISOString(),
      message: { role: 'user', content: a.text },
    }
  }
  if (arg.type === 'assistant') {
    const a = arg as { type: 'assistant'; text: string; uuid?: string; parentUuid?: string; timestamp?: string }
    return {
      type: 'assistant',
      uuid: a.uuid ?? randomUUID(),
      parentUuid: a.parentUuid,
      timestamp: a.timestamp ?? new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: a.text }] },
    }
  }
  return arg as Record<string, unknown>
}

async function writeSessionFile(
  projectPath: string,
  sessionId: string,
  entries: EntryArg[],
): Promise<string> {
  const projectDir = getProjectDir(projectPath)
  await mkdir(projectDir, { recursive: true, mode: 0o700 })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  // Place `type` first to match the on-disk format the agent writes —
  // listSessions tag detection relies on `findLast(l => l.startsWith('{"type":"tag"'))`.
  const sessionEntries = entries.map((e) => {
    const base = buildEntry(e)
    return { ...base, sessionId }
  })
  const content = sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 })
  return filePath
}

describe('listSessions', () => {
  it('returns empty array when projects dir does not exist', async () => {
    const result = await listSessions()
    expect(result).toEqual([])
  })

  it('returns sessions across all projects when no dir filter', async () => {
    const id1 = randomUUID()
    const id2 = randomUUID()
    await writeSessionFile('/project-a', id1, [{ type: 'user', text: 'hello' }])
    await writeSessionFile('/project-b', id2, [{ type: 'user', text: 'world' }])

    const result = await listSessions()
    const ids = result.map((s) => s.id).sort()
    expect(ids).toEqual([id1, id2].sort())
  })

  it('filters by dir', async () => {
    const targetId = randomUUID()
    const otherId = randomUUID()
    await writeSessionFile('/project-a', targetId, [{ type: 'user', text: 'in target' }])
    await writeSessionFile('/project-b', otherId, [{ type: 'user', text: 'in other' }])

    const result = await listSessions({ dir: '/project-a' })
    expect(result.map((s) => s.id)).toEqual([targetId])
  })

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await writeSessionFile('/p', randomUUID(), [{ type: 'user', text: `msg ${i}` }])
    }
    const result = await listSessions({ limit: 3 })
    expect(result).toHaveLength(3)
  })

  it('exposes customTitle as session title', async () => {
    const id = randomUUID()
    await writeSessionFile('/p', id, [
      { type: 'user', text: 'first prompt' },
      { type: 'custom-title', customTitle: 'My Renamed Session' },
    ])
    const result = await listSessions({ dir: '/p' })
    expect(result[0]!.title).toBe('My Renamed Session')
  })

  it('exposes tag in listing', async () => {
    const id = randomUUID()
    await writeSessionFile('/p', id, [
      { type: 'user', text: 'hi' },
      { type: 'tag', tag: 'wip' },
    ])
    const result = await listSessions({ dir: '/p' })
    expect(result[0]!.tag).toBe('wip')
  })

  it('skips sidechain sessions', async () => {
    const id = randomUUID()
    await writeSessionFile('/p', id, [
      { type: 'user', text: 'hi', uuid: 'u1' } as any,
      { type: 'tag', tag: 'sidechain-marker' },
    ])
    // Manually rewrite the first line with isSidechain: true
    const projectDir = getProjectDir('/p')
    const filePath = join(projectDir, `${id}.jsonl`)
    const content = await readFile(filePath, 'utf8')
    const lines = content.split('\n')
    const first = JSON.parse(lines[0]!) as Record<string, unknown>
    first['isSidechain'] = true
    lines[0] = JSON.stringify(first)
    await writeFile(filePath, lines.join('\n'), 'utf8')

    const result = await listSessions({ dir: '/p' })
    expect(result).toHaveLength(0)
  })
})

describe('getSessionInfo', () => {
  it('returns undefined for missing session', async () => {
    const info = await getSessionInfo(randomUUID())
    expect(info).toBeUndefined()
  })

  it('returns session metadata when present', async () => {
    const id = randomUUID()
    await writeSessionFile('/p', id, [
      { type: 'user', text: 'find me' },
      { type: 'custom-title', customTitle: 'titled' },
    ])
    const info = await getSessionInfo(id, { dir: '/p' })
    expect(info).toBeDefined()
    expect(info!.id).toBe(id)
    expect(info!.title).toBe('titled')
  })
})

describe('getSessionMessages', () => {
  it('returns empty array for missing session', async () => {
    const msgs = await getSessionMessages(randomUUID())
    expect(msgs).toEqual([])
  })

  it('returns user+assistant messages in order', async () => {
    const id = randomUUID()
    await writeSessionFile('/p', id, [
      { type: 'user', text: 'hello', uuid: 'u1', parentUuid: null },
      { type: 'assistant', text: 'hi back', uuid: 'a1', parentUuid: 'u1' },
      { type: 'user', text: 'goodbye', uuid: 'u2', parentUuid: 'a1' },
    ])
    const msgs = await getSessionMessages(id, { dir: '/p' })
    expect(msgs).toHaveLength(3)
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant', 'user'])
    expect(msgs.map((m) => m.uuid)).toEqual(['u1', 'a1', 'u2'])
  })

  it('respects limit and offset', async () => {
    const id = randomUUID()
    await writeSessionFile('/p', id, [
      { type: 'user', text: 'a', uuid: 'u1' },
      { type: 'user', text: 'b', uuid: 'u2' },
      { type: 'user', text: 'c', uuid: 'u3' },
      { type: 'user', text: 'd', uuid: 'u4' },
    ])
    const msgs = await getSessionMessages(id, { dir: '/p', offset: 1, limit: 2 })
    expect(msgs.map((m) => m.uuid)).toEqual(['u2', 'u3'])
  })

  it('excludes system messages by default', async () => {
    const id = randomUUID()
    await writeSessionFile('/p', id, [
      { type: 'user', text: 'hi', uuid: 'u1' },
      { type: 'system', uuid: 's1' } as any,
      { type: 'assistant', text: 'yo', uuid: 'a1' },
    ])
    const withoutSystem = await getSessionMessages(id, { dir: '/p' })
    expect(withoutSystem.map((m) => m.type)).toEqual(['user', 'assistant'])

    const withSystem = await getSessionMessages(id, { dir: '/p', includeSystemMessages: true })
    expect(withSystem.map((m) => m.type)).toEqual(['user', 'system', 'assistant'])
  })
})

describe('renameSession', () => {
  it('appends a custom-title entry to the JSONL', async () => {
    const id = randomUUID()
    const filePath = await writeSessionFile('/p', id, [{ type: 'user', text: 'hi' }])
    await renameSession(id, 'New Title', { dir: '/p' })

    const content = await readFile(filePath, 'utf8')
    const lines = content.trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(last['type']).toBe('custom-title')
    expect(last['customTitle']).toBe('New Title')
    expect(last['sessionId']).toBe(id)
  })

  it('throws when session does not exist', async () => {
    await expect(renameSession(randomUUID(), 'x')).rejects.toThrow(/Session not found/)
  })
})

describe('tagSession', () => {
  it('appends a tag entry to the JSONL', async () => {
    const id = randomUUID()
    const filePath = await writeSessionFile('/p', id, [{ type: 'user', text: 'hi' }])
    await tagSession(id, 'important', { dir: '/p' })

    const content = await readFile(filePath, 'utf8')
    const lines = content.trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(last['type']).toBe('tag')
    expect(last['tag']).toBe('important')
  })

  it('clears the tag when null is passed', async () => {
    const id = randomUUID()
    const filePath = await writeSessionFile('/p', id, [
      { type: 'user', text: 'hi' },
      { type: 'tag', tag: 'wip' },
    ])
    await tagSession(id, null, { dir: '/p' })

    const content = await readFile(filePath, 'utf8')
    const lines = content.trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(last['type']).toBe('tag')
    expect(last['tag']).toBe('')
  })
})

describe('forkSession', () => {
  it('creates a new session file with remapped UUIDs', async () => {
    const sourceId = randomUUID()
    await writeSessionFile('/p', sourceId, [
      { type: 'user', text: 'hello', uuid: 'u1', parentUuid: null },
      { type: 'assistant', text: 'hi', uuid: 'a1', parentUuid: 'u1' },
      { type: 'user', text: 'bye', uuid: 'u2', parentUuid: 'a1' },
    ])

    const result = await forkSession(sourceId, { dir: '/p' })
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.sessionId).not.toBe(sourceId)

    const forkPath = join(getProjectDir('/p'), `${result.sessionId}.jsonl`)
    const content = await readFile(forkPath, 'utf8')
    const lines = content.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)

    expect(lines).toHaveLength(3)
    // Every entry should carry the new sessionId
    for (const entry of lines) {
      expect(entry['sessionId']).toBe(result.sessionId)
      expect((entry['forkedFrom'] as any).sessionId).toBe(sourceId)
    }
    // First entry parentUuid should still be null
    expect(lines[0]!['parentUuid']).toBeNull()
    // Chain should be preserved with original UUIDs (the implementation
    // preserves original uuids as parent references and adds forkedFrom)
    expect(lines[1]!['parentUuid']).toBe(lines[0]!['uuid'])
    expect(lines[2]!['parentUuid']).toBe(lines[1]!['uuid'])
  })

  it('truncates at upToMessageId (inclusive)', async () => {
    const sourceId = randomUUID()
    await writeSessionFile('/p', sourceId, [
      { type: 'user', text: 'a', uuid: 'u1' },
      { type: 'assistant', text: 'b', uuid: 'a1', parentUuid: 'u1' },
      { type: 'user', text: 'c', uuid: 'u2', parentUuid: 'a1' },
      { type: 'assistant', text: 'd', uuid: 'a2', parentUuid: 'u2' },
    ])

    const result = await forkSession(sourceId, { dir: '/p', upToMessageId: 'a1' })
    const forkPath = join(getProjectDir('/p'), `${result.sessionId}.jsonl`)
    const lines = (await readFile(forkPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    expect(lines).toHaveLength(2)
    expect((lines[0]!['forkedFrom'] as any).messageUuid).toBe('u1')
    expect((lines[1]!['forkedFrom'] as any).messageUuid).toBe('a1')
  })

  it('appends a custom title when provided', async () => {
    const sourceId = randomUUID()
    await writeSessionFile('/p', sourceId, [{ type: 'user', text: 'hi', uuid: 'u1' }])

    const result = await forkSession(sourceId, { dir: '/p', title: 'My Fork' })
    const forkPath = join(getProjectDir('/p'), `${result.sessionId}.jsonl`)
    const lines = (await readFile(forkPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    const titleEntry = lines.find((l) => l['type'] === 'custom-title')
    expect(titleEntry).toBeDefined()
    expect(titleEntry!['customTitle']).toBe('My Fork')
  })

  it('excludes sidechain entries', async () => {
    const sourceId = randomUUID()
    const projectDir = getProjectDir('/p')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, `${sourceId}.jsonl`)
    const entries = [
      { sessionId: sourceId, type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'main' } },
      { sessionId: sourceId, type: 'user', uuid: 'u2', parentUuid: 'u1', isSidechain: true, message: { content: 'side' } },
      { sessionId: sourceId, type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: 'reply' }] } },
    ]
    await writeFile(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')

    const result = await forkSession(sourceId, { dir: '/p' })
    const forkPath = join(projectDir, `${result.sessionId}.jsonl`)
    const lines = (await readFile(forkPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    expect(lines).toHaveLength(2)
    expect(lines.map((l) => (l['forkedFrom'] as any).messageUuid)).toEqual(['u1', 'a1'])
  })

  it('throws when source session does not exist', async () => {
    await expect(forkSession(randomUUID())).rejects.toThrow(/Session not found/)
  })
})

describe('sanitizePath', () => {
  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizePath('/Users/foo/my-project')).toBe('-Users-foo-my-project')
    expect(sanitizePath('plugin:name:server')).toBe('plugin-name-server')
  })
})
