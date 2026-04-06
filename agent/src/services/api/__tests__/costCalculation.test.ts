import { describe, it, expect } from 'vitest'
import { neutralUsageToDeltaUsage, updateUsage } from '../usageUtils.js'
import type { Usage } from '../streamTypes.js'

describe('neutralUsageToDeltaUsage', () => {
  it('maps inputTokens → input_tokens and outputTokens → output_tokens', () => {
    const usage: Usage = { inputTokens: 100, outputTokens: 50 }
    const delta = neutralUsageToDeltaUsage(usage)
    expect(delta.input_tokens).toBe(100)
    expect(delta.output_tokens).toBe(50)
  })

  it('maps cacheReadTokens → cache_read_input_tokens (undefined → 0)', () => {
    const usage: Usage = { inputTokens: 100, outputTokens: 50 }
    const delta = neutralUsageToDeltaUsage(usage)
    expect(delta.cache_read_input_tokens).toBe(0)

    const usageWithCache: Usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 80 }
    const delta2 = neutralUsageToDeltaUsage(usageWithCache)
    expect(delta2.cache_read_input_tokens).toBe(80)
  })

  it('maps cacheWriteTokens → cache_creation_input_tokens (undefined → 0)', () => {
    const usage: Usage = { inputTokens: 100, outputTokens: 50 }
    const delta = neutralUsageToDeltaUsage(usage)
    expect(delta.cache_creation_input_tokens).toBe(0)

    const usageWithCache: Usage = { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 20 }
    const delta2 = neutralUsageToDeltaUsage(usageWithCache)
    expect(delta2.cache_creation_input_tokens).toBe(20)
  })

  it('round-trip: neutral → delta → updateUsage preserves values', () => {
    const neutral: Usage = {
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
    }
    const delta = neutralUsageToDeltaUsage(neutral)

    const emptyUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: undefined,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: undefined,
      iterations: undefined,
      speed: undefined,
    } as any

    const result = updateUsage(emptyUsage, delta)
    expect(result.input_tokens).toBe(500)
    expect(result.output_tokens).toBe(200)
    expect(result.cache_read_input_tokens).toBe(100)
    expect(result.cache_creation_input_tokens).toBe(50)
  })
})
