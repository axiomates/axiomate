/**
 * Characterization tests for agenticSessionSearch (Step 0a-A).
 *
 * Anchors current /resume search behavior so adding SessionSearchTool
 * cannot silently regress this code path. See plan file for context.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LogOption, SerializedMessage } from '../../../types/logs.js'

// Mock heavy externals BEFORE importing the unit under test.
vi.mock('../../../utils/sessionStorage.js', () => ({
  isLiteLog: vi.fn((log: LogOption) => Boolean(log.isLite)),
  loadFullLog: vi.fn(async (log: LogOption) => log), // identity by default
}))

vi.mock('../../../utils/model/model.js', () => ({
  getFastModel: vi.fn(() => 'fake/fast-model'),
}))

vi.mock('../../../services/api/providerRegistry.js', () => ({
  getProviderForModel: vi.fn(() => ({ name: 'fake' })),
}))

vi.mock('../../../services/api/capabilities/sideQuery.js', () => ({
  sideQuery: vi.fn(),
}))

vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))

vi.mock('../../../utils/log.js', () => ({
  // Predictable: returns customTitle || firstPrompt || '' so we can drive
  // pre-filter behavior deterministically from fixtures.
  getLogDisplayTitle: vi.fn(
    (log: LogOption) => log.customTitle || log.firstPrompt || '',
  ),
  logError: vi.fn(),
}))

import { agenticSessionSearch } from '../../../utils/agenticSessionSearch.js'
import { sideQuery } from '../../../services/api/capabilities/sideQuery.js'
import { isLiteLog, loadFullLog } from '../../../utils/sessionStorage.js'

const mockSideQuery = vi.mocked(sideQuery)
const mockIsLiteLog = vi.mocked(isLiteLog)
const mockLoadFullLog = vi.mocked(loadFullLog)

beforeEach(() => {
  vi.clearAllMocks()
  // Default: isLiteLog reads .isLite flag from fixture
  mockIsLiteLog.mockImplementation((log: LogOption) => Boolean(log.isLite))
  // Default: loadFullLog returns identity (don't enrich)
  mockLoadFullLog.mockImplementation(async (log: LogOption) => log)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// -------- Fixture helpers ------------------------------------------------

function makeLog(overrides: Partial<LogOption> = {}): LogOption {
  return {
    date: '2026-04-24',
    messages: [],
    value: 0,
    created: new Date('2026-04-24T00:00:00Z'),
    modified: new Date('2026-04-24T00:00:00Z'),
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    ...overrides,
  }
}

function makeUserMessage(text: string): SerializedMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    cwd: '/tmp',
    userType: 'human',
    sessionId: 'test-session',
    timestamp: '2026-04-24T00:00:00Z',
    version: 'test',
    uuid: '00000000-0000-0000-0000-000000000001',
    parentUuid: null,
    isSidechain: false,
  } as unknown as SerializedMessage
}

function mockLLMResponse(indices: number[] | null, raw?: string) {
  const text =
    raw ?? (indices == null ? 'no json here' : JSON.stringify({ relevant_indices: indices }))
  mockSideQuery.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
  } as any)
}

// -------- Tests ----------------------------------------------------------

describe('agenticSessionSearch — empty / no-op cases', () => {
  test('returns [] for empty query string', async () => {
    const result = await agenticSessionSearch('', [makeLog({ firstPrompt: 'hi' })])
    expect(result).toEqual([])
    expect(mockSideQuery).not.toHaveBeenCalled()
  })

  test('returns [] for whitespace-only query', async () => {
    const result = await agenticSessionSearch('   \n\t  ', [
      makeLog({ firstPrompt: 'hi' }),
    ])
    expect(result).toEqual([])
    expect(mockSideQuery).not.toHaveBeenCalled()
  })

  test('returns [] for empty logs array', async () => {
    const result = await agenticSessionSearch('docker', [])
    expect(result).toEqual([])
    expect(mockSideQuery).not.toHaveBeenCalled()
  })
})

describe('agenticSessionSearch — pre-filter (logContainsQuery) field matching', () => {
  test('matches by firstPrompt (display title fallback) — case insensitive', async () => {
    const logs = [
      makeLog({ firstPrompt: 'Debug Docker container' }),
      makeLog({ firstPrompt: 'unrelated topic' }),
    ]
    mockLLMResponse([0])
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toHaveLength(1)
    expect(result[0]!.firstPrompt).toBe('Debug Docker container')
  })

  test('matches by customTitle', async () => {
    const logs = [
      makeLog({ firstPrompt: 'foo', customTitle: 'My Kubernetes notes' }),
      makeLog({ firstPrompt: 'bar' }),
    ]
    mockLLMResponse([0])
    const result = await agenticSessionSearch('kubernetes', logs)
    expect(result).toHaveLength(1)
    expect(result[0]!.customTitle).toBe('My Kubernetes notes')
  })

  test('matches by tag', async () => {
    const logs = [
      makeLog({ firstPrompt: 'foo', tag: 'devops' }),
      makeLog({ firstPrompt: 'bar' }),
    ]
    mockLLMResponse([0])
    const result = await agenticSessionSearch('devops', logs)
    expect(result).toHaveLength(1)
    expect(result[0]!.tag).toBe('devops')
  })

  test('matches by gitBranch', async () => {
    const logs = [
      makeLog({ firstPrompt: 'foo', gitBranch: 'feature/auth-refactor' }),
      makeLog({ firstPrompt: 'bar' }),
    ]
    mockLLMResponse([0])
    const result = await agenticSessionSearch('auth', logs)
    expect(result).toHaveLength(1)
    expect(result[0]!.gitBranch).toBe('feature/auth-refactor')
  })

  test('matches by summary', async () => {
    const logs = [
      makeLog({ firstPrompt: 'foo', summary: 'Worked on database migration' }),
      makeLog({ firstPrompt: 'bar' }),
    ]
    mockLLMResponse([0])
    const result = await agenticSessionSearch('database', logs)
    expect(result).toHaveLength(1)
  })

  test('matches by transcript content (extractMessageText path)', async () => {
    const logs = [
      makeLog({
        firstPrompt: 'unrelated',
        messages: [makeUserMessage('Setting up Redis cluster')],
      }),
      makeLog({ firstPrompt: 'bar' }),
    ]
    mockLLMResponse([0])
    const result = await agenticSessionSearch('redis', logs)
    expect(result).toHaveLength(1)
  })

  test('returns empty match list to LLM with full corpus when no field matches', async () => {
    const logs = [
      makeLog({ firstPrompt: 'completely unrelated 1' }),
      makeLog({ firstPrompt: 'completely unrelated 2' }),
    ]
    // LLM returns nothing relevant
    mockLLMResponse([])
    const result = await agenticSessionSearch('xyz_no_match_zzz', logs)
    expect(result).toEqual([])
    // Important: still goes to LLM (fills with non-matching as context)
    expect(mockSideQuery).toHaveBeenCalledTimes(1)
  })
})

describe('agenticSessionSearch — sort / limit logic (MAX_SESSIONS_TO_SEARCH=100)', () => {
  test('passes all matching logs when count <= 100', async () => {
    const logs = Array.from({ length: 50 }, (_, i) =>
      makeLog({ firstPrompt: `docker session ${i}` }),
    )
    mockLLMResponse([0, 1, 2])
    await agenticSessionSearch('docker', logs)
    expect(mockSideQuery).toHaveBeenCalledTimes(1)
  })

  test('caps to 100 when matching logs exceed MAX_SESSIONS_TO_SEARCH', async () => {
    const logs = Array.from({ length: 150 }, (_, i) =>
      makeLog({ firstPrompt: `docker session ${i}` }),
    )
    // LLM should see indices 0-99 only; pick last in window
    mockLLMResponse([99])
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toHaveLength(1)
    expect(result[0]!.firstPrompt).toBe('docker session 99')
  })

  test('fills remaining slots with non-matching logs as context', async () => {
    const matching = [makeLog({ firstPrompt: 'docker thing' })]
    const nonMatching = Array.from({ length: 5 }, (_, i) =>
      makeLog({ firstPrompt: `unrelated ${i}` }),
    )
    const logs = [...matching, ...nonMatching]
    // LLM picks index 0 (the matching one)
    mockLLMResponse([0])
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toHaveLength(1)
    expect(result[0]!.firstPrompt).toBe('docker thing')
    // Verify all 6 logs were sent to LLM (matching + non-matching as context)
    const promptCall = mockSideQuery.mock.calls[0]![1] as any
    const userContent = promptCall.messages[0].content as string
    // Sessions are numbered 0-5 in the prompt
    expect(userContent).toContain('0:')
    expect(userContent).toContain('5:')
  })
})

describe('agenticSessionSearch — lite log loading', () => {
  test('calls loadFullLog for lite logs to enrich transcript', async () => {
    const liteLog = makeLog({
      firstPrompt: 'docker thing',
      isLite: true,
      sessionId: 'lite-1',
    })
    const enriched = makeLog({
      firstPrompt: 'docker thing',
      isLite: false,
      sessionId: 'lite-1',
      messages: [makeUserMessage('full content here')],
    })
    mockLoadFullLog.mockResolvedValueOnce(enriched)
    mockLLMResponse([0])

    await agenticSessionSearch('docker', [liteLog])
    expect(mockLoadFullLog).toHaveBeenCalledWith(liteLog)
  })

  test('falls back to lite log when loadFullLog throws', async () => {
    const liteLog = makeLog({
      firstPrompt: 'docker thing',
      isLite: true,
      sessionId: 'lite-1',
    })
    mockLoadFullLog.mockRejectedValueOnce(new Error('disk error'))
    mockLLMResponse([0])

    const result = await agenticSessionSearch('docker', [liteLog])
    // Should not throw; should still return result based on lite log
    expect(result).toHaveLength(1)
    expect(result[0]!.firstPrompt).toBe('docker thing')
  })

  test('does not call loadFullLog for non-lite logs', async () => {
    const fullLog = makeLog({
      firstPrompt: 'docker thing',
      isLite: false,
      messages: [makeUserMessage('content')],
    })
    mockLLMResponse([0])
    await agenticSessionSearch('docker', [fullLog])
    expect(mockLoadFullLog).not.toHaveBeenCalled()
  })
})

describe('agenticSessionSearch — LLM response parsing', () => {
  test('parses valid JSON response and returns matching logs', async () => {
    const logs = [
      makeLog({ firstPrompt: 'docker A' }),
      makeLog({ firstPrompt: 'docker B' }),
      makeLog({ firstPrompt: 'docker C' }),
    ]
    mockLLMResponse([2, 0])
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toHaveLength(2)
    expect(result[0]!.firstPrompt).toBe('docker C') // index 2 first
    expect(result[1]!.firstPrompt).toBe('docker A')
  })

  test('extracts JSON from markdown-wrapped LLM response', async () => {
    const logs = [makeLog({ firstPrompt: 'docker A' })]
    mockSideQuery.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: 'Here are the relevant sessions:\n```json\n{"relevant_indices": [0]}\n```\nLet me know if you need more.',
        },
      ],
    } as any)
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toHaveLength(1)
  })

  test('returns [] when LLM response has no JSON', async () => {
    const logs = [makeLog({ firstPrompt: 'docker A' })]
    mockLLMResponse(null, 'I am sorry, I cannot help with that.')
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toEqual([])
  })

  test('returns [] when LLM response has no text content block', async () => {
    const logs = [makeLog({ firstPrompt: 'docker A' })]
    mockSideQuery.mockResolvedValueOnce({ content: [] } as any)
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toEqual([])
  })

  test('filters out-of-bounds indices from LLM response', async () => {
    const logs = [makeLog({ firstPrompt: 'docker A' })]
    // LLM hallucinates indices that don't exist
    mockLLMResponse([0, 5, 99, -1])
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toHaveLength(1)
    expect(result[0]!.firstPrompt).toBe('docker A')
  })

  test('handles missing relevant_indices field gracefully', async () => {
    const logs = [makeLog({ firstPrompt: 'docker A' })]
    mockSideQuery.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"some_other_field": [0]}' }],
    } as any)
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toEqual([])
  })

  test('returns [] when LLM throws (graceful degradation)', async () => {
    const logs = [makeLog({ firstPrompt: 'docker A' })]
    mockSideQuery.mockRejectedValueOnce(new Error('LLM unavailable'))
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toEqual([])
  })
})

describe('agenticSessionSearch — transcript extraction edge cases', () => {
  test('handles message with structured content blocks (text array)', async () => {
    const logs = [
      makeLog({
        firstPrompt: 'unrelated',
        messages: [
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'docker debug session' },
                { type: 'image', source: { data: 'base64...' } },
              ],
            },
            cwd: '/tmp',
            userType: 'human',
            sessionId: 's',
            timestamp: 't',
            version: 'v',
            uuid: 'u',
            parentUuid: null,
            isSidechain: false,
          } as unknown as SerializedMessage,
        ],
      }),
    ]
    mockLLMResponse([0])
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toHaveLength(1)
  })

  test('handles message with empty content gracefully (no match)', async () => {
    const logs = [
      makeLog({
        firstPrompt: 'unrelated',
        messages: [
          {
            type: 'user',
            message: { role: 'user', content: '' },
            cwd: '/tmp',
            userType: 'human',
            sessionId: 's',
            timestamp: 't',
            version: 'v',
            uuid: 'u',
            parentUuid: null,
            isSidechain: false,
          } as unknown as SerializedMessage,
        ],
      }),
    ]
    mockLLMResponse([])
    const result = await agenticSessionSearch('docker', logs)
    expect(result).toEqual([])
  })

  test('respects MAX_TRANSCRIPT_CHARS truncation in prompt (huge content)', async () => {
    const huge = 'x'.repeat(10000)
    const logs = [
      makeLog({
        firstPrompt: 'docker thing',
        messages: [makeUserMessage(huge + ' DOCKER_NEEDLE ' + huge)],
      }),
    ]
    mockLLMResponse([0])
    await agenticSessionSearch('docker', logs)
    const userContent = (mockSideQuery.mock.calls[0]![1] as any).messages[0]
      .content as string
    // Transcript section should exist but be truncated
    expect(userContent).toContain('Transcript:')
    // Original content was huge*2 + ~14 = 20014 chars; transcript capped at 2000+'…'
    const transcriptLine = userContent
      .split('\n')
      .find(l => l.includes('Transcript:'))!
    expect(transcriptLine.length).toBeLessThan(2200)
  })
})

describe('agenticSessionSearch — abort signal', () => {
  test('passes signal through to sideQuery for cancellation support', async () => {
    const logs = [makeLog({ firstPrompt: 'docker A' })]
    const controller = new AbortController()
    mockLLMResponse([0])
    await agenticSessionSearch('docker', logs, controller.signal)
    const callArgs = mockSideQuery.mock.calls[0]![1] as any
    expect(callArgs.signal).toBe(controller.signal)
  })
})
