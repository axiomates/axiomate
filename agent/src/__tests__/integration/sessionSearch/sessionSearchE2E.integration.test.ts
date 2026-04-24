/**
 * E2E integration test: SessionSearchTool full pipeline with real Qwen3 8B
 * for the include_summary=true path.
 *
 * Verifies:
 *   1. Default path (no include_summary) returns snippet, NEVER calls LLM —
 *      end-to-end through real fs + Tool surface
 *   2. include_summary=true triggers real fastModel call (Qwen3 8B via
 *      SiliconFlow), summary contains expected fixture keywords
 *
 * Mock boundary:
 *   - getConfigHomeDir → temp dir (real fs project layout)
 *   - bootstrap state → controlled cwd + sessionId
 *   - getGlobalConfig → injects Qwen3 8B as currentModel + fastModel for
 *     real provider resolution
 *
 * Plan: see C:\Users\kiro\.claude\plans\ai-agent-harness-enginneering-hermes-ag-lucky-cloud.md (Step 4)
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { sanitizePath } from '../../../utils/sessionStoragePortable.js'

// ---------------------------------------------------------------------------
// vi.hoisted state shared between mocks and beforeEach
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  tempDir: '',
  cwd: '',
  testCounter: 0,
}))

// ---------------------------------------------------------------------------
// Mocks (factories run before imports). Inject test model config through
// getGlobalConfig so getFastModel + getProviderForModel resolve to a real
// Qwen3 8B endpoint via local.json credentials.
// ---------------------------------------------------------------------------

vi.mock('../../../utils/envUtils.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../utils/envUtils.js')>()
  return {
    ...actual,
    getConfigHomeDir: () => state.tempDir,
  }
})

vi.mock('../../../bootstrap/state.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../bootstrap/state.js')>()
  return {
    ...actual,
    getOriginalCwd: () => state.cwd,
    getSessionId: () => 'current-session-uuid',
  }
})

vi.mock('../../../utils/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../utils/config.js')>()
  const { getIntegrationModelConfig } = await import(
    '../config/loadIntegrationEnv.js'
  )
  const { TEST_MODELS } = await import('../config/testModels.js')
  const modelName = TEST_MODELS.summarization
  const modelCfg = getIntegrationModelConfig(modelName)

  const testGlobalConfig = {
    ...actual.getGlobalConfig(),
    models: {
      [modelName]: {
        model: modelName,
        protocol: modelCfg.protocol,
        baseUrl: modelCfg.baseUrl,
        apiKey: modelCfg.apiKey,
      },
    },
    currentModel: modelName,
    fastModel: modelName,
  }

  return {
    ...actual,
    getGlobalConfig: () => testGlobalConfig,
  }
})

// Imports AFTER mocks
import { SessionSearchTool } from '../../../tools/SessionSearchTool/SessionSearchTool.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

function userEntry(text: string, sessionId: string, uuid = 'a'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid.padEnd(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    parentUuid: null,
    isSidechain: false,
    cwd: state.cwd,
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
    cwd: state.cwd,
    userType: 'agent',
    sessionId,
    timestamp: '2026-04-24T12:00:01.000Z',
    version: 'test',
  })
}

async function writeRealSession(
  sessionId: string,
  entries: string[],
): Promise<string> {
  const projectDir = join(state.tempDir, 'projects', sanitizePath(state.cwd))
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(filePath, entries.join('\n') + '\n', 'utf8')
  return filePath
}

const noopCanUseTool = (() => Promise.resolve({ behavior: 'allow' as const })) as any

beforeEach(async () => {
  state.testCounter++
  state.tempDir = await mkdtemp(join(tmpdir(), 'axiomate-sst-e2e-'))
  state.cwd = `/tmp/axiomate-sst-e2e-cwd-${state.testCounter}`
})

afterEach(async () => {
  if (state.tempDir) {
    await rm(state.tempDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionSearchTool E2E — default path (no LLM)', () => {
  test('returns snippet, never invokes Qwen3 8B', async () => {
    await writeRealSession(SESSION_A, [
      userEntry('how to debug a docker container', SESSION_A),
      assistantEntry(
        'Try `docker logs nginx-prod --tail 100` to see recent output.',
        SESSION_A,
      ),
    ])

    const start = Date.now()
    const result = await SessionSearchTool.call(
      { query: 'docker' } as any,
      {} as any,
      noopCanUseTool,
      {} as any,
    )
    const elapsed = Date.now() - start

    expect(result.data.success).toBe(true)
    const data = result.data as any
    expect(data.mode).toBe('search')
    expect(data.results).toHaveLength(1)
    expect(data.results[0].snippet).toContain('docker')
    expect(data.results[0].summary).toBeUndefined()
    // No LLM call → should complete in well under a second
    expect(elapsed).toBeLessThan(1500)
  })
})

describe('SessionSearchTool E2E — include_summary=true (real Qwen3 8B)', () => {
  test('returns snippet AND LLM-generated summary mentioning fixture keywords', async () => {
    // Distinctive fixture content. Pick keywords that should survive into
    // any reasonable summary (commands, error names, file names).
    await writeRealSession(SESSION_A, [
      userEntry(
        'I need to debug nginx-prod failing to start. What logs should I check?',
        SESSION_A,
      ),
      assistantEntry(
        'Run `docker logs nginx-prod --tail 100 | grep ERROR` to find the failure. ' +
          'Common causes: missing DATABASE_URL env var in startup script.',
        SESSION_A,
      ),
      userEntry('Found it — DATABASE_URL was missing from .env', SESSION_A),
      assistantEntry(
        'Add DATABASE_URL to .env and restart. The fix: `docker compose up -d nginx-prod`.',
        SESSION_A,
      ),
    ])

    const result = await SessionSearchTool.call(
      { query: 'docker', include_summary: true, limit: 1 } as any,
      {} as any,
      noopCanUseTool,
      {} as any,
    )

    expect(result.data.success).toBe(true)
    const data = result.data as any
    expect(data.results).toHaveLength(1)

    const entry = data.results[0]
    // Snippet always present
    expect(entry.snippet).toBeTruthy()
    expect(entry.snippet.toLowerCase()).toContain('docker')

    // Summary present (real LLM was invoked) — loose assertion: at least
    // one of the distinctive fixture tokens survived into the recap. We
    // don't assert exact phrasing because Qwen3 8B paraphrases freely.
    expect(entry.summary).toBeTruthy()
    expect(typeof entry.summary).toBe('string')
    expect(entry.summary.length).toBeGreaterThan(50)
    const summaryLower = entry.summary.toLowerCase()
    const distinctiveTokens = ['docker', 'nginx', 'database_url', 'log']
    const hits = distinctiveTokens.filter(t => summaryLower.includes(t))
    // Empirical baseline (2026-04-24): 7/7 runs of Qwen3 8B against this
    // fixture hit 4/4 tokens. Floor set to ≥3/4 — tightened from initial
    // ≥2/4 after measured stability — so a one-token paraphrase is OK
    // but two-token miss is a real signal (model regression / prompt
    // drift / aux endpoint misconfig). 'log' is the weakest token
    // (matches 'blog'/'dialog' as false positive) so the floor relies
    // on stronger ones (docker/nginx/database_url) for real signal.
    expect(hits.length).toBeGreaterThanOrEqual(3)
  }, 60_000) // 60s timeout — accommodates LLM latency + occasional retries
})

describe('SessionSearchTool E2E — recent mode (no query, no LLM)', () => {
  test('lists recent sessions metadata in well under 1 second', async () => {
    await writeRealSession(SESSION_A, [userEntry('first', SESSION_A)])
    await writeRealSession(SESSION_B, [userEntry('second', SESSION_B)])

    const start = Date.now()
    const result = await SessionSearchTool.call(
      {} as any,
      {} as any,
      noopCanUseTool,
      {} as any,
    )
    const elapsed = Date.now() - start

    expect(result.data.success).toBe(true)
    const data = result.data as any
    expect(data.mode).toBe('recent')
    expect(data.results).toHaveLength(2)
    expect(data.results[0].session_id).toBeTruthy()
    expect(data.results[0].mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(elapsed).toBeLessThan(1500)
  })
})
