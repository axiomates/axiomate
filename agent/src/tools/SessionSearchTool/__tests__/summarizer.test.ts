/**
 * Unit tests for summarizer.ts (Step 2).
 *
 * Mock sideQuery + provider resolution; verify LLM call shape, bounded
 * concurrency, and graceful failure semantics.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../../services/api/capabilities/sideQuery.js', () => ({
  sideQuery: vi.fn(),
}))

vi.mock('../../../services/api/providerRegistry.js', () => ({
  getProviderForModel: vi.fn(() => ({ name: 'openai' })),
}))

vi.mock('../../../utils/model/model.js', () => ({
  getFastModel: vi.fn(() => 'fake/fast-model'),
}))

vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))

import { sideQuery } from '../../../services/api/capabilities/sideQuery.js'
import { getProviderForModel } from '../../../services/api/providerRegistry.js'
import { summarizeAll, summarizeHit } from '../summarizer.js'
import type { SessionSearchHit } from '../types.js'

const mockSideQuery = vi.mocked(sideQuery)
const mockGetProvider = vi.mocked(getProviderForModel)

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProvider.mockReturnValue({ name: 'openai' } as any)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeHit(overrides: Partial<SessionSearchHit> = {}): SessionSearchHit {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    filePath: '/tmp/session.jsonl',
    mtime: Date.now(),
    snippet: 'Some excerpt about docker debugging',
    score: 1.0,
    matchCount: 1,
    ...overrides,
  }
}

function mockLLMText(text: string) {
  mockSideQuery.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
  } as any)
}

// ---------------------------------------------------------------------------
// summarizeHit
// ---------------------------------------------------------------------------

describe('summarizeHit', () => {
  test('populates `summary` field on success', async () => {
    mockLLMText('User asked about docker. Resolved by checking logs.')
    const hit = makeHit()
    const out = await summarizeHit(hit, { query: 'docker' })
    expect(out.summary).toBe('User asked about docker. Resolved by checking logs.')
    // Original snippet preserved
    expect(out.snippet).toBe(hit.snippet)
  })

  test('passes query into system prompt + user message', async () => {
    mockLLMText('summary text')
    await summarizeHit(makeHit(), { query: 'docker debug' })
    const args = mockSideQuery.mock.calls[0]![1] as any
    expect(args.system).toContain('docker debug')
    expect(args.messages[0].content).toContain('docker debug')
  })

  test('uses fastModel by default; modelOverride wins when set', async () => {
    mockLLMText('s')
    await summarizeHit(makeHit(), { query: 'q' })
    expect(mockSideQuery.mock.calls[0]![1]).toMatchObject({
      model: 'fake/fast-model',
    })

    mockSideQuery.mockClear()
    mockLLMText('s')
    await summarizeHit(makeHit(), { query: 'q', modelOverride: 'custom/model' })
    expect(mockSideQuery.mock.calls[0]![1]).toMatchObject({ model: 'custom/model' })
  })

  test('skips LLM when snippet is empty (no work to do)', async () => {
    const hit = makeHit({ snippet: undefined })
    const out = await summarizeHit(hit, { query: 'docker' })
    expect(out).toBe(hit)
    expect(mockSideQuery).not.toHaveBeenCalled()
  })

  test('LLM throw → returns hit unchanged (graceful)', async () => {
    mockSideQuery.mockRejectedValueOnce(new Error('rate limit'))
    const hit = makeHit()
    const out = await summarizeHit(hit, { query: 'docker' })
    expect(out.summary).toBeUndefined()
    expect(out.snippet).toBe(hit.snippet)
  })

  test('empty LLM response → returns hit unchanged', async () => {
    mockLLMText('   ')
    const hit = makeHit()
    const out = await summarizeHit(hit, { query: 'docker' })
    expect(out.summary).toBeUndefined()
  })

  test('no text content block in response → returns hit unchanged', async () => {
    mockSideQuery.mockResolvedValueOnce({ content: [] } as any)
    const hit = makeHit()
    const out = await summarizeHit(hit, { query: 'docker' })
    expect(out.summary).toBeUndefined()
  })

  test('provider resolution failure → returns hit unchanged, no LLM call', async () => {
    mockGetProvider.mockImplementationOnce(() => {
      throw new Error('no such model')
    })
    const hit = makeHit()
    const out = await summarizeHit(hit, { query: 'docker' })
    expect(out.summary).toBeUndefined()
    expect(mockSideQuery).not.toHaveBeenCalled()
  })

  test('AbortSignal forwarded to sideQuery', async () => {
    const ctrl = new AbortController()
    mockLLMText('s')
    await summarizeHit(makeHit(), { query: 'q', signal: ctrl.signal })
    expect((mockSideQuery.mock.calls[0]![1] as any).signal).toBe(ctrl.signal)
  })

  test('querySource is set to "session_search"', async () => {
    mockLLMText('s')
    await summarizeHit(makeHit(), { query: 'q' })
    expect((mockSideQuery.mock.calls[0]![1] as any).querySource).toBe(
      'session_search',
    )
  })
})

// ---------------------------------------------------------------------------
// summarizeAll
// ---------------------------------------------------------------------------

describe('summarizeAll', () => {
  test('empty input array → empty output, no LLM calls', async () => {
    const out = await summarizeAll([], { query: 'q' })
    expect(out).toEqual([])
    expect(mockSideQuery).not.toHaveBeenCalled()
  })

  test('preserves input order regardless of LLM completion order', async () => {
    // Resolve in REVERSE order to stress order preservation
    let resolveCount = 0
    mockSideQuery.mockImplementation(async () => {
      resolveCount++
      // Earlier calls take longer
      const myCount = resolveCount
      await new Promise(r => setTimeout(r, 30 - myCount * 10))
      return { content: [{ type: 'text', text: `summary-${myCount}` }] } as any
    })

    const hits = [makeHit({ sessionId: 'a' }), makeHit({ sessionId: 'b' }), makeHit({ sessionId: 'c' })]
    const out = await summarizeAll(hits, { query: 'q' })
    expect(out.map(h => h.sessionId)).toEqual(['a', 'b', 'c'])
  })

  test('respects concurrency cap — never more than N in flight at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    mockSideQuery.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 20))
      inFlight--
      return { content: [{ type: 'text', text: 's' }] } as any
    })

    const hits = Array.from({ length: 10 }, (_, i) =>
      makeHit({ sessionId: String(i) }),
    )
    await summarizeAll(hits, { query: 'q', concurrency: 2 })
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  test('default concurrency = 3 (matches hermes default)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    mockSideQuery.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 20))
      inFlight--
      return { content: [{ type: 'text', text: 's' }] } as any
    })
    const hits = Array.from({ length: 6 }, (_, i) =>
      makeHit({ sessionId: String(i) }),
    )
    await summarizeAll(hits, { query: 'q' })
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  test('one failure does not abort siblings', async () => {
    let call = 0
    mockSideQuery.mockImplementation(async () => {
      call++
      if (call === 2) throw new Error('rate limit')
      return { content: [{ type: 'text', text: `summary-${call}` }] } as any
    })
    const hits = [
      makeHit({ sessionId: 'a' }),
      makeHit({ sessionId: 'b' }),
      makeHit({ sessionId: 'c' }),
    ]
    const out = await summarizeAll(hits, { query: 'q', concurrency: 1 })
    // a and c get summaries; b's failure leaves snippet only
    expect(out[0]!.summary).toBeDefined()
    expect(out[1]!.summary).toBeUndefined()
    expect(out[2]!.summary).toBeDefined()
  })

  test('concurrency is clamped to >= 1 even if 0/negative passed', async () => {
    mockLLMText('s')
    const out = await summarizeAll([makeHit()], {
      query: 'q',
      concurrency: 0,
    })
    expect(out).toHaveLength(1)
  })
})
