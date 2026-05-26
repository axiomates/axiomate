/**
 * Unit tests for SessionSearchTool's preFilter (Step 1a).
 *
 * Stage 1: filterByMtime — mtime-based session enumeration
 * Stage 2: scanMetadata  — tail-window metadata field match
 *
 * Real fs (temp dirs). No LLM. Fully automated.
 */
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { filterByMtime, scanMetadata } from '../../../../tools/SessionSearchTool/preFilter.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'axiomate-preFilter-test-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

// -------- Fixture helpers ------------------------------------------------

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const SESSION_C = '33333333-3333-4333-8333-333333333333'

async function writeSession(
  sessionId: string,
  entries: object[],
  opts?: { mtime?: Date },
): Promise<string> {
  const filePath = join(tempDir, `${sessionId}.jsonl`)
  await writeFile(
    filePath,
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  )
  if (opts?.mtime) {
    await utimes(filePath, opts.mtime, opts.mtime)
  }
  return filePath
}

function userMsg(text: string, sessionId: string) {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    parentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    userType: 'human',
    sessionId,
    timestamp: '2026-04-24T12:00:00.000Z',
    version: 'test',
  }
}

// ---------------------------------------------------------------------------
// filterByMtime
// ---------------------------------------------------------------------------

describe('filterByMtime — Stage 1 mtime pre-filter', () => {
  test('returns [] for empty / non-existent dir', async () => {
    const result = await filterByMtime(tempDir, 30)
    expect(result).toEqual([])
    const ghost = await filterByMtime(join(tempDir, 'no-such-dir'), 30)
    expect(ghost).toEqual([])
  })

  test('returns all when recent_days <= 0 (no time filter)', async () => {
    await writeSession(SESSION_A, [userMsg('a', SESSION_A)], {
      mtime: new Date('2025-01-01'),
    })
    await writeSession(SESSION_B, [userMsg('b', SESSION_B)], {
      mtime: new Date('2026-04-24'),
    })
    const zero = await filterByMtime(tempDir, 0)
    expect(zero.length).toBe(2)
    const negative = await filterByMtime(tempDir, -1)
    expect(negative.length).toBe(2)
  })

  test('filters out sessions whose mtime is older than recent_days', async () => {
    const now = new Date('2026-04-24T00:00:00Z').getTime()
    await writeSession(SESSION_A, [userMsg('old', SESSION_A)], {
      mtime: new Date('2026-01-01T00:00:00Z'), // ~113 days ago
    })
    await writeSession(SESSION_B, [userMsg('recent', SESSION_B)], {
      mtime: new Date('2026-04-20T00:00:00Z'), // 4 days ago
    })

    const result30 = await filterByMtime(tempDir, 30, now)
    expect(result30.length).toBe(1)
    expect(result30[0]!.sessionId).toBe(SESSION_B)

    const result365 = await filterByMtime(tempDir, 365, now)
    expect(result365.length).toBe(2)
  })

  test('returns sessions sorted descending by mtime (newest first)', async () => {
    await writeSession(SESSION_A, [userMsg('mid', SESSION_A)], {
      mtime: new Date('2026-04-15'),
    })
    await writeSession(SESSION_B, [userMsg('newest', SESSION_B)], {
      mtime: new Date('2026-04-24'),
    })
    await writeSession(SESSION_C, [userMsg('oldest', SESSION_C)], {
      mtime: new Date('2026-04-01'),
    })
    const result = await filterByMtime(tempDir, 365)
    expect(result.map(s => s.sessionId)).toEqual([
      SESSION_B,
      SESSION_A,
      SESSION_C,
    ])
  })

  test('populates filePath / mtime / ctime / size for each entry', async () => {
    const fp = await writeSession(SESSION_A, [userMsg('hello', SESSION_A)])
    const result = await filterByMtime(tempDir, 0)
    expect(result.length).toBe(1)
    const entry = result[0]!
    expect(entry.sessionId).toBe(SESSION_A)
    expect(entry.filePath).toBe(fp)
    expect(entry.mtime).toBeGreaterThan(0)
    expect(entry.ctime).toBeGreaterThan(0)
    expect(entry.size).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// scanMetadata
// ---------------------------------------------------------------------------

describe('scanMetadata — Stage 2 metadata tail scan', () => {
  test('returns null for empty / whitespace query', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('hi', SESSION_A),
      { type: 'tag', sessionId: SESSION_A, tag: 'devops' },
    ])
    expect(await scanMetadata(fp, '')).toBeNull()
    expect(await scanMetadata(fp, '   ')).toBeNull()
  })

  test('returns null for non-existent file', async () => {
    const ghost = join(tempDir, `${SESSION_A}.jsonl`)
    expect(await scanMetadata(ghost, 'anything')).toBeNull()
  })

  test('matches by custom-title field (case insensitive)', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('hi', SESSION_A),
      {
        type: 'custom-title',
        sessionId: SESSION_A,
        customTitle: 'My Deploy Workflow',
      },
    ])
    const result = await scanMetadata(fp, 'deploy')
    expect(result).not.toBeNull()
    expect(result!.fields).toEqual(['customTitle'])
    expect(result!.matchedValues.customTitle).toBe('My Deploy Workflow')
  })

  test('matches by tag entry', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('q', SESSION_A),
      { type: 'tag', sessionId: SESSION_A, tag: 'kubernetes' },
    ])
    const result = await scanMetadata(fp, 'kuber')
    expect(result).not.toBeNull()
    expect(result!.fields).toContain('tag')
    expect(result!.matchedValues.tag).toBe('kubernetes')
  })

  test('matches by summary entry', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('q', SESSION_A),
      {
        type: 'summary',
        leafUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        summary: 'Discussed Postgres migration strategy',
      },
    ])
    const result = await scanMetadata(fp, 'postgres')
    expect(result).not.toBeNull()
    expect(result!.fields).toContain('summary')
    expect(result!.matchedValues.summary).toBe(
      'Discussed Postgres migration strategy',
    )
  })

  test('matches by ai-title (mapped to "title" field name)', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('q', SESSION_A),
      {
        type: 'ai-title',
        sessionId: SESSION_A,
        aiTitle: 'Refactoring auth middleware',
      },
    ])
    const result = await scanMetadata(fp, 'refactor')
    expect(result).not.toBeNull()
    expect(result!.fields).toContain('title')
    expect(result!.matchedValues.title).toBe('Refactoring auth middleware')
  })

  test('multi-field hit returns all matches', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('q', SESSION_A),
      { type: 'tag', sessionId: SESSION_A, tag: 'docker-debug' },
      {
        type: 'custom-title',
        sessionId: SESSION_A,
        customTitle: 'Docker investigation',
      },
    ])
    const result = await scanMetadata(fp, 'docker')
    expect(result).not.toBeNull()
    expect(result!.fields.sort()).toEqual(['customTitle', 'tag'])
  })

  test('returns null when no metadata field contains query', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('q', SESSION_A),
      { type: 'tag', sessionId: SESSION_A, tag: 'frontend' },
      {
        type: 'custom-title',
        sessionId: SESSION_A,
        customTitle: 'React work',
      },
    ])
    const result = await scanMetadata(fp, 'kubernetes')
    expect(result).toBeNull()
  })

  test('skips malformed JSON lines silently', async () => {
    const fp = join(tempDir, `${SESSION_A}.jsonl`)
    const content = [
      JSON.stringify(userMsg('q', SESSION_A)),
      'not valid json {{{',
      JSON.stringify({
        type: 'tag',
        sessionId: SESSION_A,
        tag: 'survives-malformed',
      }),
    ].join('\n') + '\n'
    await writeFile(fp, content, 'utf8')

    const result = await scanMetadata(fp, 'survives')
    expect(result).not.toBeNull()
    expect(result!.fields).toContain('tag')
  })

  test('respects fields filter — only scans requested types', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('q', SESSION_A),
      { type: 'tag', sessionId: SESSION_A, tag: 'find-me' },
      {
        type: 'custom-title',
        sessionId: SESSION_A,
        customTitle: 'find-me too',
      },
    ])
    // Only allow 'tag' field — customTitle hit should be ignored
    const result = await scanMetadata(fp, 'find-me', ['tag'])
    expect(result).not.toBeNull()
    expect(result!.fields).toEqual(['tag'])
    expect(result!.matchedValues.customTitle).toBeUndefined()
  })

  test('handles small files (< 64KB tail = head equality) correctly', async () => {
    // File is well under 64KB; readSessionLite returns tail === head
    const fp = await writeSession(SESSION_A, [
      userMsg('hi', SESSION_A),
      { type: 'tag', sessionId: SESSION_A, tag: 'tiny-file' },
    ])
    const result = await scanMetadata(fp, 'tiny')
    expect(result).not.toBeNull()
    expect(result!.fields).toEqual(['tag'])
  })

  test('case insensitive query against mixed-case metadata', async () => {
    const fp = await writeSession(SESSION_A, [
      userMsg('q', SESSION_A),
      { type: 'tag', sessionId: SESSION_A, tag: 'CamelCaseTag' },
    ])
    expect(await scanMetadata(fp, 'camelcase')).not.toBeNull()
    expect(await scanMetadata(fp, 'CAMEL')).not.toBeNull()
    expect(await scanMetadata(fp, 'Camel')).not.toBeNull()
  })
})
