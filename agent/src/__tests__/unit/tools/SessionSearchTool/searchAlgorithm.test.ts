/**
 * Unit/integration tests for searchAlgorithm.ts (Step 1b orchestrator).
 *
 * Real fs (temp dirs) for end-to-end pipeline coverage. No LLM.
 * Pins the contract that SessionSearchTool surface (Step 2) will call.
 */
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { runSearch } from '../../../../tools/SessionSearchTool/searchAlgorithm.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'axiomate-searchAlg-test-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const SESSION_C = '33333333-3333-4333-8333-333333333333'
const NOW = new Date('2026-04-24T12:00:00Z').getTime()

function userEntry(text: string, sessionId: string, uuid = 'a'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid.padEnd(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    parentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    userType: 'human',
    sessionId,
    timestamp: '2026-04-24T12:00:00.000Z',
    version: 'test',
  })
}

function assistantEntry(text: string, sessionId: string, uuid = 'b'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    uuid: uuid.padEnd(8, '0') + '-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    userType: 'agent',
    sessionId,
    timestamp: '2026-04-24T12:00:01.000Z',
    version: 'test',
  })
}

function tagEntry(sessionId: string, tag: string): string {
  return JSON.stringify({ type: 'tag', sessionId, tag })
}

function customTitleEntry(sessionId: string, customTitle: string): string {
  return JSON.stringify({ type: 'custom-title', sessionId, customTitle })
}

async function writeSession(
  sessionId: string,
  entries: string[],
  opts?: { mtime?: Date },
): Promise<string> {
  const fp = join(tempDir, `${sessionId}.jsonl`)
  await writeFile(fp, entries.join('\n') + '\n', 'utf8')
  if (opts?.mtime) {
    await utimes(fp, opts.mtime, opts.mtime)
  }
  return fp
}

// ---------------------------------------------------------------------------
// Empty / no-match cases
// ---------------------------------------------------------------------------

describe('runSearch — empty / no-match', () => {
  test('empty query → []', async () => {
    await writeSession(SESSION_A, [userEntry('docker', SESSION_A)])
    const result = await runSearch(
      { query: '' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toEqual([])
  })

  test('whitespace query → []', async () => {
    await writeSession(SESSION_A, [userEntry('docker', SESSION_A)])
    const result = await runSearch(
      { query: '   ' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toEqual([])
  })

  test('empty project → []', async () => {
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toEqual([])
  })

  test('non-existent project → []', async () => {
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: join(tempDir, 'no-such'), now: NOW },
    )
    expect(result).toEqual([])
  })

  test('no session matches the query → []', async () => {
    await writeSession(SESSION_A, [userEntry('cooking recipes', SESSION_A)])
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Body match
// ---------------------------------------------------------------------------

describe('runSearch — body matches', () => {
  test('single session with body match → 1 result with matchCount > 0', async () => {
    await writeSession(SESSION_A, [
      userEntry('how to debug docker container', SESSION_A),
      assistantEntry('use docker logs', SESSION_A, 'b'),
    ])
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.sessionId).toBe(SESSION_A)
    expect(result[0]!.matchCount).toBeGreaterThan(0)
    expect(result[0]!.snippet).toContain('docker')
  })

  test('role_filter excludes non-matching role messages', async () => {
    await writeSession(SESSION_A, [
      userEntry('docker user message', SESSION_A, 'u'),
    ])
    await writeSession(SESSION_B, [
      assistantEntry('docker assistant message', SESSION_B, 'a'),
    ])
    const result = await runSearch(
      { query: 'docker', role_filter: 'assistant' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.sessionId).toBe(SESSION_B)
  })
})

// ---------------------------------------------------------------------------
// Metadata match
// ---------------------------------------------------------------------------

describe('runSearch — metadata matches', () => {
  test('metadata-only hit (tag) returns result with metadataMatches set', async () => {
    await writeSession(SESSION_A, [
      userEntry('cooking recipes', SESSION_A),
      tagEntry(SESSION_A, 'docker-debug'),
    ])
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.metadataMatches).toContain('tag')
    expect(result[0]!.matchCount).toBe(0)
    expect(result[0]!.snippet).toContain('docker-debug')
  })

  test('combined body + metadata hit → metadataMatches AND matchCount populated', async () => {
    await writeSession(SESSION_A, [
      userEntry('docker container question', SESSION_A),
      tagEntry(SESSION_A, 'devops'),
      customTitleEntry(SESSION_A, 'Docker investigation notes'),
    ])
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.matchCount).toBeGreaterThan(0)
    expect(result[0]!.metadataMatches).toContain('customTitle')
  })
})

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe('runSearch — ranking', () => {
  test('tag-hit session ranks above body-only session (same recency)', async () => {
    await writeSession(SESSION_A, [
      userEntry('docker once', SESSION_A),
    ])
    await writeSession(SESSION_B, [
      userEntry('routine talk', SESSION_B),
      tagEntry(SESSION_B, 'docker'),
    ])
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toHaveLength(2)
    // SESSION_B (tag-hit) should rank first
    expect(result[0]!.sessionId).toBe(SESSION_B)
    expect(result[1]!.sessionId).toBe(SESSION_A)
  })

  test('newer session beats older session at same metadata strength', async () => {
    // Both within 30-day default window so Stage 1 doesn't filter either out
    const older = new Date('2026-04-01T00:00:00Z') // 23 days before NOW
    const newer = new Date('2026-04-22T00:00:00Z') // 2 days before NOW
    await writeSession(
      SESSION_A,
      [userEntry('q', SESSION_A), tagEntry(SESSION_A, 'docker')],
      { mtime: older },
    )
    await writeSession(
      SESSION_B,
      [userEntry('q', SESSION_B), tagEntry(SESSION_B, 'docker')],
      { mtime: newer },
    )
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toHaveLength(2)
    expect(result[0]!.sessionId).toBe(SESSION_B)
  })
})

// ---------------------------------------------------------------------------
// Limit / exclusion
// ---------------------------------------------------------------------------

describe('runSearch — limit and exclusion', () => {
  test('limit clamped to [1, 5]; default 3', async () => {
    for (const sid of [SESSION_A, SESSION_B, SESSION_C]) {
      await writeSession(sid, [userEntry('docker', sid)])
    }
    const def = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    expect(def.length).toBeLessThanOrEqual(3)

    const lim1 = await runSearch(
      { query: 'docker', limit: 1 },
      { projectDir: tempDir, now: NOW },
    )
    expect(lim1).toHaveLength(1)

    const lim999 = await runSearch(
      { query: 'docker', limit: 999 },
      { projectDir: tempDir, now: NOW },
    )
    // Clamped to 5; only 3 sessions exist so result is 3
    expect(lim999.length).toBeLessThanOrEqual(5)

    const lim0 = await runSearch(
      { query: 'docker', limit: 0 },
      { projectDir: tempDir, now: NOW },
    )
    // Clamped to MIN_LIMIT=1
    expect(lim0).toHaveLength(1)
  })

  test('excludeSessionId filters out current session', async () => {
    await writeSession(SESSION_A, [userEntry('docker A', SESSION_A)])
    await writeSession(SESSION_B, [userEntry('docker B', SESSION_B)])
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW, excludeSessionId: SESSION_A },
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.sessionId).toBe(SESSION_B)
  })

  test('current session INCLUDED by default (axiomate-specific divergence from hermes)', async () => {
    await writeSession(SESSION_A, [userEntry('docker', SESSION_A)])
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    // No excludeSessionId → SESSION_A appears
    expect(result.some(r => r.sessionId === SESSION_A)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Recency window
// ---------------------------------------------------------------------------

describe('runSearch — recency_days filter', () => {
  test('default recent_days=30 excludes older sessions', async () => {
    const ancient = new Date('2025-01-01T00:00:00Z')
    const recent = new Date('2026-04-20T00:00:00Z')
    await writeSession(SESSION_A, [userEntry('docker old', SESSION_A)], {
      mtime: ancient,
    })
    await writeSession(SESSION_B, [userEntry('docker new', SESSION_B)], {
      mtime: recent,
    })
    const result = await runSearch(
      { query: 'docker' },
      { projectDir: tempDir, now: NOW },
    )
    // SESSION_A (>1 year old) excluded; SESSION_B (4 days) kept
    expect(result.length).toBe(1)
    expect(result[0]!.sessionId).toBe(SESSION_B)
  })

  test('recent_days=0 disables filter (returns all matches)', async () => {
    const ancient = new Date('2025-01-01T00:00:00Z')
    const recent = new Date('2026-04-20T00:00:00Z')
    await writeSession(SESSION_A, [userEntry('docker old', SESSION_A)], {
      mtime: ancient,
    })
    await writeSession(SESSION_B, [userEntry('docker new', SESSION_B)], {
      mtime: recent,
    })
    const result = await runSearch(
      { query: 'docker', recent_days: 0 },
      { projectDir: tempDir, now: NOW },
    )
    expect(result.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Snippet truncation markers
// ---------------------------------------------------------------------------

describe('runSearch — snippet markers', () => {
  test('large body with match in middle → snippet has truncation markers', async () => {
    // Build a session with a single huge user message
    const filler = 'x'.repeat(50_000)
    const text = filler + ' DOCKER_NEEDLE ' + filler
    await writeSession(SESSION_A, [userEntry(text, SESSION_A)])
    const result = await runSearch(
      { query: 'DOCKER_NEEDLE', limit: 1 },
      { projectDir: tempDir, now: NOW },
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.snippet).toContain('DOCKER_NEEDLE')
    // Either earlier or later truncation marker should appear (text > 100k chars)
    const hasMarker =
      result[0]!.snippet.includes('[earlier conversation truncated]') ||
      result[0]!.snippet.includes('[later conversation truncated]')
    expect(hasMarker).toBe(true)
  })
})
