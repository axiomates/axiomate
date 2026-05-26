import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock config + context resolvers BEFORE importing the module under test so
// the inline imports pick up the mocked symbols.
vi.mock('../../../../utils/config.js', () => ({
  getGlobalConfig: vi.fn(() => ({ models: {} })),
}))
vi.mock('../../../../utils/context.js', () => ({
  getContextWindowForModel: vi.fn(() => 32_000),
}))

import { getGlobalConfig } from '../../../../utils/config.js'
import { getContextWindowForModel } from '../../../../utils/context.js'
import {
  computeStallThreshold,
  estimateInputTokens,
  isObviouslyLocalHostname,
} from '../../../../services/api/middleware/stallThreshold.js'

const mockGlobal = vi.mocked(getGlobalConfig)
const mockCtx = vi.mocked(getContextWindowForModel)

beforeEach(() => {
  mockGlobal.mockReset()
  mockGlobal.mockReturnValue({ models: {} } as any)
  mockCtx.mockReset()
  mockCtx.mockReturnValue(32_000)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// isObviouslyLocalHostname
// ---------------------------------------------------------------------------

describe('isObviouslyLocalHostname', () => {
  it.each([
    ['http://localhost:8080/v1', true],
    ['http://localhost/v1', true],
    ['http://127.0.0.1:11434', true],
    ['http://127.5.6.7/api', true], // entire 127.0.0.0/8
    ['http://0.0.0.0:8000', true],
    ['http://[::1]:8080', true],
    ['http://[::]/v1', true],
    ['https://host.docker.internal:5000', true],
  ])('treats %s as obviously local', (url, expected) => {
    expect(isObviouslyLocalHostname(url)).toBe(expected)
  })

  it.each([
    'https://api.openai.com/v1',
    'https://api.siliconflow.cn/v1',
    'https://my-llm.corp.cloud/v1',
    'http://192.168.1.10:8080', // RFC1918 — could be VPN/k8s
    'http://10.0.0.5/v1',
    'http://172.16.5.10/v1',
    'http://printer.local/v1', // mDNS — too ambiguous
    'http://anyserver.tailscale.io/v1',
  ])('does NOT treat %s as local', url => {
    expect(isObviouslyLocalHostname(url)).toBe(false)
  })

  it('returns false for malformed URLs', () => {
    expect(isObviouslyLocalHostname('not a url')).toBe(false)
    expect(isObviouslyLocalHostname('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// estimateInputTokens
// ---------------------------------------------------------------------------

describe('estimateInputTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateInputTokens([])).toBe(0)
  })

  it('handles plain string content', () => {
    // 4 chars per token rough rule
    const msg = { content: 'abcdefgh' } // 8 chars → 2 tokens
    expect(estimateInputTokens([msg])).toBe(2)
  })

  it('handles nested content blocks (axiomate Message shape)', () => {
    const msg = {
      message: {
        content: [
          { type: 'text', text: 'hello world' },
          { type: 'image', source: { data: 'BASE64DATA' } },
        ],
      },
    }
    const tokens = estimateInputTokens([msg])
    // JSON.stringify produces some envelope chars beyond the raw content;
    // we just verify it's nontrivial and proportional.
    expect(tokens).toBeGreaterThan(10)
    expect(tokens).toBeLessThan(50)
  })

  it('sums across messages', () => {
    const small = { content: 'x'.repeat(40) } // 10 tokens
    const big = { content: 'y'.repeat(400) } // 100 tokens
    expect(estimateInputTokens([small, big])).toBe(110)
  })

  it('skips messages without content', () => {
    const blank = { metadata: 'whatever' } as any
    const real = { content: 'abcd' }
    expect(estimateInputTokens([blank, real])).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// computeStallThreshold — priority chain
// ---------------------------------------------------------------------------

describe('computeStallThreshold — priority chain', () => {
  it('per-model stallTimeoutMs override beats heuristic and adaptive', () => {
    mockGlobal.mockReturnValue({
      models: {
        'm': { baseUrl: 'https://api.openai.com', stallTimeoutMs: 45_000 },
      },
    } as any)
    expect(
      computeStallThreshold({
        baseUrl: 'https://api.openai.com',
        model: 'm',
        estimatedInputTokens: 200_000, // would otherwise pick 600_000
      }),
    ).toBe(45_000)
  })

  it('per-model stallTimeoutMs = 0 disables (Infinity) — DNS-rewrite escape', () => {
    mockGlobal.mockReturnValue({
      models: {
        'm': {
          baseUrl: 'https://gpu.corp.cloud/v1', // looks cloud, actually local via /etc/hosts
          stallTimeoutMs: 0,
        },
      },
    } as any)
    expect(
      computeStallThreshold({
        baseUrl: 'https://gpu.corp.cloud/v1',
        model: 'm',
        estimatedInputTokens: 5_000,
      }),
    ).toBe(Number.POSITIVE_INFINITY)
  })

  it('local-hostname heuristic returns Infinity when no override', () => {
    expect(
      computeStallThreshold({
        baseUrl: 'http://localhost:11434/v1',
        model: 'ollama-qwen',
        estimatedInputTokens: 200_000,
      }),
    ).toBe(Number.POSITIVE_INFINITY)
  })
})

// ---------------------------------------------------------------------------
// computeStallThreshold — adaptive bucket boundaries
// ---------------------------------------------------------------------------

describe('computeStallThreshold — adaptive buckets', () => {
  function defaultArgs(estimatedInputTokens: number) {
    return {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt',
      estimatedInputTokens,
    }
  }

  it('default 30s for small inputs (< 20K, ratio < 0.5)', () => {
    mockCtx.mockReturnValue(200_000) // big window so ratio stays small
    expect(computeStallThreshold(defaultArgs(5_000))).toBe(30_000)
    expect(computeStallThreshold(defaultArgs(20_000))).toBe(30_000) // boundary
  })

  it('absolute bucket: > 20K → 120s', () => {
    mockCtx.mockReturnValue(1_000_000) // ratio negligible
    expect(computeStallThreshold(defaultArgs(20_001))).toBe(120_000)
    expect(computeStallThreshold(defaultArgs(50_000))).toBe(120_000)
  })

  it('absolute bucket: > 50K → 300s', () => {
    mockCtx.mockReturnValue(1_000_000)
    expect(computeStallThreshold(defaultArgs(50_001))).toBe(300_000)
    expect(computeStallThreshold(defaultArgs(100_000))).toBe(300_000)
  })

  it('absolute bucket: > 100K → 600s', () => {
    mockCtx.mockReturnValue(1_000_000)
    expect(computeStallThreshold(defaultArgs(100_001))).toBe(600_000)
    expect(computeStallThreshold(defaultArgs(500_000))).toBe(600_000)
  })

  it('ratio bucket: > 0.5 → at least 180s (small-window protection)', () => {
    mockCtx.mockReturnValue(20_000) // small window, 12k tokens = 60% ratio, abs in 30s bucket
    expect(computeStallThreshold(defaultArgs(12_000))).toBe(180_000)
  })

  it('ratio bucket: > 0.8 → at least 300s', () => {
    mockCtx.mockReturnValue(20_000) // 17k = 85% ratio
    expect(computeStallThreshold(defaultArgs(17_000))).toBe(300_000)
  })

  it('takes the larger of absolute vs ratio buckets', () => {
    // 80k tokens in 100k window: abs bucket → 300s, ratio 80% → 300s.
    // Either way 300s.
    mockCtx.mockReturnValue(100_000)
    expect(computeStallThreshold(defaultArgs(80_000))).toBe(300_000)

    // 120k tokens in 1M window: abs bucket → 600s, ratio 12% → 0 contribution.
    // Result: 600s wins.
    mockCtx.mockReturnValue(1_000_000)
    expect(computeStallThreshold(defaultArgs(120_000))).toBe(600_000)
  })

  it('handles zero context window safely (no division-by-zero)', () => {
    mockCtx.mockReturnValue(0)
    expect(computeStallThreshold(defaultArgs(40_000))).toBe(120_000)
  })

  it('no baseUrl → still adaptive (heuristic skipped)', () => {
    mockCtx.mockReturnValue(200_000)
    expect(
      computeStallThreshold({
        model: 'gpt',
        estimatedInputTokens: 5_000,
      }),
    ).toBe(30_000)
  })
})
