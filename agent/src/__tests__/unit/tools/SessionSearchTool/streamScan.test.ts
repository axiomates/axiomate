/**
 * Unit tests for streamScan.ts (Step 1b).
 *
 * Real fs (temp dirs) for live-write and chunked-read scenarios. No LLM.
 * Tests cover Stage 3 of the SessionSearchTool algorithm.
 */
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { extractMessageText, scanSessionForQuery } from '../../../../tools/SessionSearchTool/streamScan.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'axiomate-streamScan-test-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

const SESSION = '11111111-1111-4111-8111-111111111111'

function userEntry(text: string, uuid = 'a'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid.padEnd(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    parentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    userType: 'human',
    sessionId: SESSION,
    timestamp: '2026-04-24T12:00:00.000Z',
    version: 'test',
  })
}

function assistantEntry(text: string, uuid = 'b'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    uuid: uuid.padEnd(8, '0') + '-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    parentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    userType: 'agent',
    sessionId: SESSION,
    timestamp: '2026-04-24T12:00:01.000Z',
    version: 'test',
  })
}

function toolEntry(text: string, uuid = 'c'): string {
  return JSON.stringify({
    type: 'tool',
    message: {
      role: 'tool',
      content: text,
    },
    uuid: uuid.padEnd(8, '0') + '-cccc-4ccc-8ccc-cccccccccccc',
    parentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    userType: 'tool',
    sessionId: SESSION,
    timestamp: '2026-04-24T12:00:02.000Z',
    version: 'test',
  })
}

async function writeFixture(entries: string[]): Promise<string> {
  const filePath = join(tempDir, `${SESSION}.jsonl`)
  await writeFile(filePath, entries.join('\n') + '\n', 'utf8')
  return filePath
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) out.push(v)
  return out
}

// ---------------------------------------------------------------------------
// extractMessageText (helper)
// ---------------------------------------------------------------------------

describe('extractMessageText', () => {
  test('null/undefined → empty string', () => {
    expect(extractMessageText(null)).toBe('')
    expect(extractMessageText(undefined)).toBe('')
  })

  test('plain string → returned as-is', () => {
    expect(extractMessageText('hello')).toBe('hello')
  })

  test('structured array of text blocks → joined with spaces', () => {
    const blocks = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    expect(extractMessageText(blocks)).toBe('first second')
  })

  test('mixed array (text + image block) → only text blocks extracted', () => {
    const blocks = [
      { type: 'text', text: 'caption' },
      { type: 'image', source: { data: 'base64...' } },
    ]
    expect(extractMessageText(blocks)).toBe('caption')
  })

  test('non-array non-string content → empty', () => {
    expect(extractMessageText(42 as any)).toBe('')
    expect(extractMessageText({} as any)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// scanSessionForQuery
// ---------------------------------------------------------------------------

describe('scanSessionForQuery — basic matching', () => {
  test('empty / whitespace query yields nothing', async () => {
    const fp = await writeFixture([userEntry('docker stuff')])
    expect(await collect(scanSessionForQuery(fp, { query: '' }))).toEqual([])
    expect(await collect(scanSessionForQuery(fp, { query: '   ' }))).toEqual([])
  })

  test('non-existent file → no hits, no throw', async () => {
    const ghost = join(tempDir, `${SESSION}.jsonl`)
    const hits = await collect(scanSessionForQuery(ghost, { query: 'x' }))
    expect(hits).toEqual([])
  })

  test('single user message match (string content)', async () => {
    const fp = await writeFixture([userEntry('docker debug session')])
    const hits = await collect(scanSessionForQuery(fp, { query: 'docker' }))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.role).toBe('user')
    expect(hits[0]!.text).toBe('docker debug session')
    expect(hits[0]!.matchPositions).toEqual([0])
    expect(hits[0]!.lineNumber).toBe(1)
  })

  test('multi-line file with multiple matches → one hit per matching message', async () => {
    const fp = await writeFixture([
      userEntry('first docker thing', '1'),
      assistantEntry('unrelated reply', '2'),
      userEntry('another docker mention', '3'),
    ])
    const hits = await collect(scanSessionForQuery(fp, { query: 'docker' }))
    expect(hits).toHaveLength(2)
    expect(hits[0]!.lineNumber).toBe(1)
    expect(hits[1]!.lineNumber).toBe(3)
  })

  test('case-insensitive substring match', async () => {
    const fp = await writeFixture([userEntry('Docker DEBUG')])
    const hits = await collect(scanSessionForQuery(fp, { query: 'docker' }))
    expect(hits).toHaveLength(1)
    const hits2 = await collect(scanSessionForQuery(fp, { query: 'debug' }))
    expect(hits2).toHaveLength(1)
  })

  test('multiple matches in same message → multiple matchPositions', async () => {
    const fp = await writeFixture([userEntry('docker docker docker')])
    const hits = await collect(scanSessionForQuery(fp, { query: 'docker' }))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.matchPositions).toHaveLength(3)
    expect(hits[0]!.matchPositions).toEqual([0, 7, 14])
  })

  test('structured assistant content array — text blocks scanned', async () => {
    const fp = await writeFixture([assistantEntry('docker plan goes here')])
    const hits = await collect(scanSessionForQuery(fp, { query: 'docker' }))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.role).toBe('assistant')
    expect(hits[0]!.text).toContain('docker plan')
  })
})

describe('scanSessionForQuery — role_filter', () => {
  test('role_filter="assistant" excludes user/tool messages', async () => {
    const fp = await writeFixture([
      userEntry('docker user', '1'),
      assistantEntry('docker assistant', '2'),
      toolEntry('docker tool', '3'),
    ])
    const hits = await collect(
      scanSessionForQuery(fp, { query: 'docker', roleFilter: 'assistant' }),
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.role).toBe('assistant')
  })

  test('role_filter="user" includes only user role', async () => {
    const fp = await writeFixture([
      userEntry('docker user', '1'),
      assistantEntry('docker assistant', '2'),
    ])
    const hits = await collect(
      scanSessionForQuery(fp, { query: 'docker', roleFilter: 'user' }),
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.role).toBe('user')
  })

  test('role_filter="tool" includes tool messages', async () => {
    const fp = await writeFixture([
      userEntry('docker user', '1'),
      toolEntry('docker tool output', '2'),
    ])
    const hits = await collect(
      scanSessionForQuery(fp, { query: 'docker', roleFilter: 'tool' }),
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.role).toBe('tool')
  })
})

describe('scanSessionForQuery — robustness', () => {
  test('malformed JSON lines skipped silently', async () => {
    const filePath = join(tempDir, `${SESSION}.jsonl`)
    const content =
      [
        userEntry('docker valid', '1'),
        '{ this is not json',
        userEntry('docker also valid', '2'),
      ].join('\n') + '\n'
    await writeFile(filePath, content, 'utf8')

    const hits = await collect(
      scanSessionForQuery(filePath, { query: 'docker' }),
    )
    expect(hits).toHaveLength(2)
  })

  test('non-message types (summary / tag / custom-title) ignored', async () => {
    const fp = await writeFixture([
      JSON.stringify({ type: 'summary', leafUuid: 'x', summary: 'docker' }),
      JSON.stringify({ type: 'tag', sessionId: SESSION, tag: 'docker' }),
      JSON.stringify({
        type: 'custom-title',
        sessionId: SESSION,
        customTitle: 'docker',
      }),
      userEntry('docker user message', 'u'),
    ])
    const hits = await collect(scanSessionForQuery(fp, { query: 'docker' }))
    // Only the user message should be a hit; metadata-type entries excluded
    expect(hits).toHaveLength(1)
    expect(hits[0]!.role).toBe('user')
  })

  test('live-write safety: trailing partial line dropped (no JSON.parse error)', async () => {
    const filePath = join(tempDir, `${SESSION}.jsonl`)
    // No trailing newline → last line is partial
    const content =
      userEntry('docker complete', '1') + '\n' +
      '{"type":"user","message":{"role":"user","content":"docker incomplete' // truncated
    await writeFile(filePath, content, 'utf8')

    const hits = await collect(
      scanSessionForQuery(filePath, { query: 'docker' }),
    )
    // Only the complete first line should yield a hit
    expect(hits).toHaveLength(1)
    expect(hits[0]!.text).toBe('docker complete')
  })

  test('empty content message → no hit (no false positive)', async () => {
    const fp = await writeFixture([
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '' },
        uuid: '11111111-1111-4111-8111-111111111111',
        parentUuid: null,
        isSidechain: false,
        cwd: '/tmp',
        userType: 'human',
        sessionId: SESSION,
        timestamp: 't',
        version: 'v',
      }),
    ])
    const hits = await collect(scanSessionForQuery(fp, { query: 'docker' }))
    expect(hits).toEqual([])
  })
})

describe('scanSessionForQuery — large file streaming', () => {
  test(
    'scans large file (>5MB) without buffering whole file',
    async () => {
      // Build a JSONL with 30K small messages — well above any single chunk.
      // Most messages don't match; place 3 matching messages at start, middle, end
      // to verify streaming reaches them all.
      const filePath = join(tempDir, `${SESSION}.jsonl`)
      const lines: string[] = []
      const TOTAL = 30_000
      for (let i = 0; i < TOTAL; i++) {
        const text =
          i === 0 || i === Math.floor(TOTAL / 2) || i === TOTAL - 1
            ? `MARKER docker line ${i}`
            : `routine message ${i} with filler content `
        // Pad uuid hex to 8 chars
        const hex = i.toString(16).padStart(8, '0')
        lines.push(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: text },
            uuid: `${hex}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
            parentUuid: null,
            isSidechain: false,
            cwd: '/tmp',
            userType: 'human',
            sessionId: SESSION,
            timestamp: 't',
            version: 'v',
          }),
        )
      }
      await writeFile(filePath, lines.join('\n') + '\n', 'utf8')

      const hits = await collect(
        scanSessionForQuery(filePath, { query: 'docker' }),
      )
      expect(hits).toHaveLength(3)
      expect(hits[0]!.lineNumber).toBe(1)
      expect(hits[1]!.lineNumber).toBe(Math.floor(TOTAL / 2) + 1)
      expect(hits[2]!.lineNumber).toBe(TOTAL)
    },
    30_000, // 30s timeout for large fixture build + scan
  )
})
