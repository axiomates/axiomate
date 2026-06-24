/**
 * Integration tests for sessionStorage primitives that SessionSearchTool
 * will directly depend on (Step 0a-B).
 *
 * Scope: pin behavior of `getSessionFilesWithMtime` and `loadTranscriptFile`
 * against real filesystem operations using temp dirs. Higher-level functions
 * (`searchSessionsByCustomTitle`, `getLastSessionLog`) depend on bootstrap
 * state (originalCwd, worktree paths) and are not covered here — they're
 * out of SessionSearchTool's direct contract surface.
 *
 * Plan: see C:\Users\kiro\.claude\plans\ai-agent-harness-enginneering-hermes-ag-lucky-cloud.md
 */
import { mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  getSessionFilesWithMtime,
  loadTranscriptFile,
} from '../../../utils/sessionStorage.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'axiomate-sessionStorage-test-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function makeUserEntry(opts: {
  uuid: string
  parentUuid?: string | null
  text: string
  sessionId: string
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: opts.text },
    uuid: opts.uuid,
    parentUuid: opts.parentUuid ?? null,
    logicalParentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    userType: 'human',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? '2026-04-24T12:00:00.000Z',
    version: 'test',
  })
}

function makeAssistantEntry(opts: {
  uuid: string
  parentUuid: string
  text: string
  sessionId: string
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: opts.text }],
    },
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    logicalParentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    userType: 'agent',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? '2026-04-24T12:00:01.000Z',
    version: 'test',
  })
}

function makeSummaryEntry(opts: { leafUuid: string; summary: string }): string {
  return JSON.stringify({
    type: 'summary',
    leafUuid: opts.leafUuid,
    summary: opts.summary,
  })
}

function makeCustomTitleEntry(opts: {
  sessionId: string
  customTitle: string
}): string {
  return JSON.stringify({
    type: 'custom-title',
    sessionId: opts.sessionId,
    customTitle: opts.customTitle,
  })
}

function makeTagEntry(opts: { sessionId: string; tag: string }): string {
  return JSON.stringify({
    type: 'tag',
    sessionId: opts.sessionId,
    tag: opts.tag,
  })
}

function makeGoalStateEntry(opts: {
  sessionId: string
  goal: string
  status?: 'active' | 'paused' | 'done' | 'cleared'
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'goal-state',
    uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? '2026-04-24T12:00:02.000Z',
    goal: opts.goal,
    status: opts.status ?? 'active',
    turnsUsed: 3,
    maxTurns: 20,
    createdAt: 1_776_000_000_000,
    lastTurnAt: 1_776_000_010_000,
    lastVerdict: 'continue',
    lastReason: 'still working',
    pausedReason: opts.status === 'paused' ? 'turn budget exhausted' : undefined,
    consecutiveParseFailures: 0,
    subgoals: ['keep state across compact'],
  })
}

function makeCompactBoundaryEntry(opts: {
  uuid: string
  sessionId: string
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    uuid: opts.uuid,
    timestamp: opts.timestamp ?? '2026-04-24T12:00:03.000Z',
    level: 'info',
    compactMetadata: {
      trigger: 'auto',
      preTokens: 100_000,
      messagesSummarized: 1,
    },
    cwd: '/tmp',
    userType: 'agent',
    sessionId: opts.sessionId,
    version: 'test',
  })
}

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const UUID_USER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UUID_ASSISTANT_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function writeSessionFile(
  sessionId: string,
  entries: string[],
  opts?: { mtime?: Date },
): Promise<string> {
  const filePath = join(tempDir, `${sessionId}.jsonl`)
  await writeFile(filePath, entries.join('\n') + '\n', 'utf8')
  if (opts?.mtime) {
    await utimes(filePath, opts.mtime, opts.mtime)
  }
  return filePath
}

// ---------------------------------------------------------------------------
// getSessionFilesWithMtime tests
// ---------------------------------------------------------------------------

describe('getSessionFilesWithMtime — directory enumeration', () => {
  test('returns empty Map for non-existent directory', async () => {
    const ghost = join(tempDir, 'does-not-exist')
    const result = await getSessionFilesWithMtime(ghost)
    expect(result.size).toBe(0)
    expect(result).toBeInstanceOf(Map)
  })

  test('returns empty Map for empty directory', async () => {
    const result = await getSessionFilesWithMtime(tempDir)
    expect(result.size).toBe(0)
  })

  test('enumerates valid UUID-named .jsonl files', async () => {
    await writeSessionFile(SESSION_A, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'hello',
        sessionId: SESSION_A,
      }),
    ])
    await writeSessionFile(SESSION_B, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'world',
        sessionId: SESSION_B,
      }),
    ])

    const result = await getSessionFilesWithMtime(tempDir)
    expect(result.size).toBe(2)
    expect(result.has(SESSION_A)).toBe(true)
    expect(result.has(SESSION_B)).toBe(true)
  })

  test('skips files that are not valid UUIDs', async () => {
    await writeSessionFile(SESSION_A, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'hello',
        sessionId: SESSION_A,
      }),
    ])
    // Non-UUID name
    await writeFile(join(tempDir, 'not-a-uuid.jsonl'), 'garbage', 'utf8')
    // Non-jsonl extension
    await writeFile(
      join(tempDir, `${SESSION_B}.txt`),
      'also garbage',
      'utf8',
    )

    const result = await getSessionFilesWithMtime(tempDir)
    expect(result.size).toBe(1)
    expect(result.has(SESSION_A)).toBe(true)
    expect(result.has(SESSION_B)).toBe(false)
  })

  test('skips subdirectories with .jsonl-like names', async () => {
    const fakeDir = join(tempDir, `${SESSION_A}.jsonl`)
    await writeFile(join(tempDir, `${SESSION_B}.jsonl`), 'real-but-empty\n')
    // Create a directory that looks like a session file
    const { mkdir } = await import('node:fs/promises')
    await mkdir(fakeDir)

    const result = await getSessionFilesWithMtime(tempDir)
    // Only the real file should match, not the directory
    expect(result.has(SESSION_B)).toBe(true)
    expect(result.has(SESSION_A)).toBe(false)
  })

  test('returns accurate mtime, ctime, and size for each file', async () => {
    const entry = makeUserEntry({
      uuid: UUID_USER_1,
      text: 'sized content',
      sessionId: SESSION_A,
    })
    const filePath = await writeSessionFile(SESSION_A, [entry])
    const fileStat = await stat(filePath)

    const result = await getSessionFilesWithMtime(tempDir)
    const entry_data = result.get(SESSION_A)!
    expect(entry_data).toBeDefined()
    expect(entry_data.path).toBe(filePath)
    expect(entry_data.size).toBe(fileStat.size)
    expect(entry_data.mtime).toBe(fileStat.mtime.getTime())
    // ctime field is birthtime (ctime in API; on FS it's stat.birthtime)
    expect(entry_data.ctime).toBe(fileStat.birthtime.getTime())
    expect(entry_data.size).toBeGreaterThan(0)
  })

  test('mtime ordering reflects actual file mtimes after explicit utime', async () => {
    const oldDate = new Date('2026-01-01T00:00:00Z')
    const newDate = new Date('2026-04-24T00:00:00Z')

    await writeSessionFile(
      SESSION_A,
      [makeUserEntry({ uuid: UUID_USER_1, text: 'old', sessionId: SESSION_A })],
      { mtime: oldDate },
    )
    await writeSessionFile(
      SESSION_B,
      [makeUserEntry({ uuid: UUID_USER_1, text: 'new', sessionId: SESSION_B })],
      { mtime: newDate },
    )

    const result = await getSessionFilesWithMtime(tempDir)
    expect(result.get(SESSION_A)!.mtime).toBe(oldDate.getTime())
    expect(result.get(SESSION_B)!.mtime).toBe(newDate.getTime())
  })
})

// ---------------------------------------------------------------------------
// loadTranscriptFile tests
// ---------------------------------------------------------------------------

describe('loadTranscriptFile — small file path (< 5MB)', () => {
  test('parses single user message', async () => {
    const filePath = await writeSessionFile(SESSION_A, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'hello world',
        sessionId: SESSION_A,
      }),
    ])
    const result = await loadTranscriptFile(filePath)
    expect(result.messages.size).toBe(1)
    const msg = result.messages.get(UUID_USER_1 as any)
    expect(msg).toBeDefined()
    expect(msg!.type).toBe('user')
  })

  test('parses user + assistant chain via parentUuid', async () => {
    const filePath = await writeSessionFile(SESSION_A, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'question',
        sessionId: SESSION_A,
      }),
      makeAssistantEntry({
        uuid: UUID_ASSISTANT_1,
        parentUuid: UUID_USER_1,
        text: 'answer',
        sessionId: SESSION_A,
      }),
    ])
    const result = await loadTranscriptFile(filePath)
    expect(result.messages.size).toBe(2)
    expect(result.messages.has(UUID_USER_1 as any)).toBe(true)
    expect(result.messages.has(UUID_ASSISTANT_1 as any)).toBe(true)
    const assistant = result.messages.get(UUID_ASSISTANT_1 as any)!
    expect(assistant.parentUuid).toBe(UUID_USER_1)
  })

  test('extracts metadata: summaries map', async () => {
    const filePath = await writeSessionFile(SESSION_A, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'q',
        sessionId: SESSION_A,
      }),
      makeAssistantEntry({
        uuid: UUID_ASSISTANT_1,
        parentUuid: UUID_USER_1,
        text: 'a',
        sessionId: SESSION_A,
      }),
      makeSummaryEntry({
        leafUuid: UUID_ASSISTANT_1,
        summary: 'Q&A about something',
      }),
    ])
    const result = await loadTranscriptFile(filePath)
    expect(result.summaries.get(UUID_ASSISTANT_1 as any)).toBe(
      'Q&A about something',
    )
  })

  test('extracts metadata: customTitles map', async () => {
    const filePath = await writeSessionFile(SESSION_A, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'q',
        sessionId: SESSION_A,
      }),
      makeCustomTitleEntry({
        sessionId: SESSION_A,
        customTitle: 'My deploy script',
      }),
    ])
    const result = await loadTranscriptFile(filePath)
    expect(result.customTitles.get(SESSION_A as any)).toBe('My deploy script')
  })

  test('extracts metadata: tags map', async () => {
    const filePath = await writeSessionFile(SESSION_A, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'q',
        sessionId: SESSION_A,
      }),
      makeTagEntry({ sessionId: SESSION_A, tag: 'devops' }),
    ])
    const result = await loadTranscriptFile(filePath)
    expect(result.tags.get(SESSION_A as any)).toBe('devops')
  })

  test('returns empty maps for non-existent file (graceful)', async () => {
    const ghost = join(tempDir, `${SESSION_A}.jsonl`)
    const result = await loadTranscriptFile(ghost)
    expect(result.messages.size).toBe(0)
    expect(result.summaries.size).toBe(0)
    expect(result.tags.size).toBe(0)
  })

  test('skips malformed JSON lines without crashing', async () => {
    const filePath = join(tempDir, `${SESSION_A}.jsonl`)
    const content = [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'valid',
        sessionId: SESSION_A,
      }),
      '{ this is not valid json',
      makeAssistantEntry({
        uuid: UUID_ASSISTANT_1,
        parentUuid: UUID_USER_1,
        text: 'also valid',
        sessionId: SESSION_A,
      }),
    ].join('\n') + '\n'
    await writeFile(filePath, content, 'utf8')

    const result = await loadTranscriptFile(filePath)
    // Both valid messages should be parsed; malformed line skipped silently
    expect(result.messages.size).toBe(2)
  })

  test('handles trailing partial line (no final newline)', async () => {
    const filePath = join(tempDir, `${SESSION_A}.jsonl`)
    // No trailing newline — last line might be partial in live-write scenarios
    const content =
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'complete',
        sessionId: SESSION_A,
      }) + '\n' + '{"type":"user","message"' // truncated
    await writeFile(filePath, content, 'utf8')

    const result = await loadTranscriptFile(filePath)
    // Complete first line should parse; partial second should be skipped
    expect(result.messages.size).toBe(1)
  })

  test('leafUuids set contains terminal messages', async () => {
    const filePath = await writeSessionFile(SESSION_A, [
      makeUserEntry({
        uuid: UUID_USER_1,
        text: 'q',
        sessionId: SESSION_A,
      }),
      makeAssistantEntry({
        uuid: UUID_ASSISTANT_1,
        parentUuid: UUID_USER_1,
        text: 'a',
        sessionId: SESSION_A,
      }),
    ])
    const result = await loadTranscriptFile(filePath)
    // Last message in chain is the leaf
    expect(result.leafUuids.has(UUID_ASSISTANT_1 as any)).toBe(true)
    // Earlier message is parent, not leaf
    expect(result.leafUuids.has(UUID_USER_1 as any)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// loadTranscriptFile — large file (chunked stream path > 5MB threshold)
// ---------------------------------------------------------------------------

describe('loadTranscriptFile — large file streaming path', () => {
  test('handles file larger than SKIP_PRECOMPACT_THRESHOLD via chunked read', async () => {
    // SKIP_PRECOMPACT_THRESHOLD typically ~5MB. Build a >6MB JSONL with
    // many small messages — exercises readTranscriptForLoad chunked path.
    const filePath = join(tempDir, `${SESSION_A}.jsonl`)
    const lines: string[] = []
    // ~200 bytes per message × 35,000 messages ≈ 7MB
    for (let i = 0; i < 35_000; i++) {
      const uuid =
        `${i.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
      const parentUuid =
        i === 0
          ? null
          : `${(i - 1).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
      lines.push(
        makeUserEntry({
          uuid,
          parentUuid,
          text: `message-${i}`,
          sessionId: SESSION_A,
        }),
      )
    }
    await writeFile(filePath, lines.join('\n') + '\n', 'utf8')

    const fileStat = await stat(filePath)
    expect(fileStat.size).toBeGreaterThan(5 * 1024 * 1024) // sanity: >5MB

    const result = await loadTranscriptFile(filePath)
    // All messages should be loaded; chunked stream must reassemble correctly
    expect(result.messages.size).toBe(35_000)
  }, 30_000) // 30s timeout — large file parsing

  test('recovers goal-state metadata written before a compact boundary', async () => {
    const filePath = join(tempDir, `${SESSION_A}.jsonl`)
    const lines: string[] = [
      makeGoalStateEntry({
        sessionId: SESSION_A,
        goal: 'finish the compact audit',
        status: 'paused',
      }),
    ]

    // Make the pre-boundary segment large enough to force the optimized
    // readTranscriptForLoad path, which truncates pre-compact bytes and then
    // separately scans session-scoped metadata from that region.
    for (let i = 0; i < 35_000; i++) {
      const uuid =
        `${i.toString(16).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`
      const parentUuid =
        i === 0
          ? null
          : `${(i - 1).toString(16).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`
      lines.push(
        makeUserEntry({
          uuid,
          parentUuid,
          text: `pre-compact-message-${i}`,
          sessionId: SESSION_A,
        }),
      )
    }

    lines.push(
      makeCompactBoundaryEntry({
        uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        sessionId: SESSION_A,
      }),
      makeUserEntry({
        uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        parentUuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        text: 'post compact prompt',
        sessionId: SESSION_A,
      }),
    )
    await writeFile(filePath, lines.join('\n') + '\n', 'utf8')

    const fileStat = await stat(filePath)
    expect(fileStat.size).toBeGreaterThan(5 * 1024 * 1024)

    const result = await loadTranscriptFile(filePath)
    const goal = result.goalStates.get(SESSION_A as any)
    expect(goal).toBeDefined()
    expect(goal!.goal).toBe('finish the compact audit')
    expect(goal!.status).toBe('paused')
    expect(goal!.subgoals).toEqual(['keep state across compact'])
  }, 30_000)

  // Regression: scanPreBoundaryMetadata's resolveMetadataBuf used a stale
  // hardcoded bound (METADATA_PREFIX_BOUND = 25) that was correct until the
  // 26-byte `"type":"partial-assistant"` marker was added (commit c2464dbb,
  // 2026-06-11) without bumping the bound. When a `{`-leading line fragment of
  // length 25 or 26 lands on a read-stream chunk seam inside the pre-boundary
  // region, `carry.compare(marker, 0, 26, 1, 27)` reads past carry.length and
  // throws RangeError. loadTranscriptFile's outer catch swallows it and returns
  // empty maps — the session becomes unresumable with the misleading
  // "No conversation found". This reproduces the exact byte alignment.
  //
  // The fs read stream's default highWaterMark is 65536, so the first chunk is
  // bytes [0, 65536). We position the LAST newline before that seam at offset
  // 65509 and start a long (no-newline-yet) JSON line right after, so the
  // trailing carry is exactly bytes [65510, 65536) = 26 bytes beginning with
  // `{` — the adversarial input. Pre-fix this throws; post-fix it loads.
  test('survives 26-byte {-leading carry on a chunk seam in pre-boundary scan', async () => {
    const CHUNK = 65536 // fs.createReadStream default highWaterMark
    const SEAM_CARRY = 26 // longest marker `"type":"partial-assistant"` length
    // We want the final newline within [0, CHUNK) at offset (CHUNK-SEAM_CARRY-1)
    // = 65509, so the next line begins at 65510 and its first 26 bytes
    // [65510, 65536) form the carry. The first line therefore needs its newline
    // at offset 65509 → 65509 bytes of content before it.
    const FIRST_NEWLINE_OFFSET = CHUNK - SEAM_CARRY - 1 // 65509

    const filePath = join(tempDir, `${SESSION_A}.jsonl`)

    // Build line 1 (a valid user entry) padded to EXACTLY FIRST_NEWLINE_OFFSET
    // bytes so its trailing '\n' sits at that offset.
    const baseFirst = makeUserEntry({
      uuid: '00000000-0000-4000-8000-000000000000',
      parentUuid: null,
      text: 'X', // placeholder, replaced below
      sessionId: SESSION_A,
    })
    // Pad the text field so the serialized line hits the target length. The
    // overhead is everything except the text payload, so payload length =
    // target - (baseLength - 1) where the -1 accounts for the single 'X'.
    const overhead = Buffer.byteLength(baseFirst) - 1
    const padLen = FIRST_NEWLINE_OFFSET - overhead
    expect(padLen).toBeGreaterThan(0) // sanity: target is reachable
    const firstLine = makeUserEntry({
      uuid: '00000000-0000-4000-8000-000000000000',
      parentUuid: null,
      text: 'X'.repeat(padLen),
      sessionId: SESSION_A,
    })
    expect(Buffer.byteLength(firstLine)).toBe(FIRST_NEWLINE_OFFSET)

    // Line 2: a long JSON line (starts with `{`) with no newline until well
    // past the chunk seam, so [65510, 65536) is its prefix — the 26-byte carry.
    const longLine = makeUserEntry({
      uuid: '00000001-0000-4000-8000-000000000000',
      parentUuid: '00000000-0000-4000-8000-000000000000',
      text: 'Y'.repeat(200_000), // >> CHUNK so the line spans many chunks
      sessionId: SESSION_A,
    })

    const lines: string[] = [firstLine, longLine]

    // Pad past the 5MB SKIP_PRECOMPACT_THRESHOLD so the streaming path + the
    // separate pre-boundary metadata scan both run.
    for (let i = 2; i < 35_000; i++) {
      const uuid = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
      const parentUuid = `${(i - 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
      lines.push(
        makeUserEntry({
          uuid,
          parentUuid,
          text: `pre-compact-${i}`,
          sessionId: SESSION_A,
        }),
      )
    }

    // Non-preservedSegment compact boundary → boundaryStartOffset > 0 → the
    // pre-boundary metadata scan (the buggy code path) actually runs.
    const lastPreUuid = `${(35_000 - 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
    const boundaryUuid = 'eeeeeeee-0000-4eee-8eee-eeeeeeeeeeee'
    const postUuid = 'ffffffff-0000-4fff-8fff-ffffffffffff'
    lines.push(
      makeUserEntry({
        uuid: lastPreUuid, // ensure boundary's logical parent exists
        parentUuid: `${(35_000 - 2).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        text: 'last pre-compact message',
        sessionId: SESSION_A,
      }),
      makeCompactBoundaryEntry({ uuid: boundaryUuid, sessionId: SESSION_A }),
      makeUserEntry({
        uuid: postUuid,
        parentUuid: boundaryUuid,
        text: 'post compact prompt',
        sessionId: SESSION_A,
      }),
    )

    await writeFile(filePath, lines.join('\n') + '\n', 'utf8')
    const fileStat = await stat(filePath)
    expect(fileStat.size).toBeGreaterThan(5 * 1024 * 1024)

    // Pre-fix: resolveMetadataBuf throws RangeError → caught → empty maps.
    // Post-fix: loads normally and the post-boundary message survives.
    const result = await loadTranscriptFile(filePath)
    expect(result.messages.size).toBeGreaterThan(0)
    expect(result.messages.has(postUuid as any)).toBe(true)
  }, 30_000)
})
