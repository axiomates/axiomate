import { describe, expect, it } from 'vitest'
import {
  debugMaxOutputSource,
  fuzzyMatchMaxOutputTokens,
  tieredMaxOutputTokens,
} from '../../../../utils/model/maxOutputTokensFuzzy.js'

// ---------------------------------------------------------------------------
// fuzzyMatchMaxOutputTokens — name → max output tokens via TABLE
// ---------------------------------------------------------------------------

describe('fuzzyMatchMaxOutputTokens', () => {
  it.each([
    // Hosted API models with official max-output documentation.
    ['gpt-5.5',                         128_000, 'openai-gpt-5.5+'],
    ['gpt-5.5-pro',                     128_000, 'openai-gpt-5.5+'],
    ['gpt-5.6',                         128_000, 'openai-gpt-5.5+'],
    ['claude-opus-4.6',                 128_000, 'claude-opus-4.6+'],
    ['claude-opus-4-7-20260219',        128_000, 'claude-opus-4.6+'],
    ['claude-opus-4.8',                 128_000, 'claude-opus-4.6+'],
    ['claude-mythos-preview',           128_000, 'claude-mythos-preview'],
  ])('Hosted API: %s → %i (%s)', (name, expectedTokens, expectedSource) => {
    expect(fuzzyMatchMaxOutputTokens(name)).toBe(expectedTokens)
    expect(debugMaxOutputSource(name)).toBe(expectedSource)
  })

  it.each([
    // Qwen
    ['qwen3.6-plus',                      65_536, 'qwen-plus'],
    ['Qwen/Qwen3.6-Plus',                 65_536, 'qwen-plus'],
    ['qwen3-coder-30b-a3b-instruct',      65_536, 'qwen3-coder'],
    ['Qwen/Qwen3-Coder-Plus',             65_536, 'qwen-plus'], // plus wins (specific-first, listed before coder)
    // Qwen3.5+ Max / Flash tiers — DashScope 64K output cap.
    ['qwen3.7-max',                       65_536, 'qwen3.5+-max'],
    ['qwen3.6-flash',                     65_536, 'qwen3.5+-flash'],
    ['qwen3.5-max',                       65_536, 'qwen3.5+-max'],
    // Predates 3.5 → max/flash fall through to qwen3-base (32K).
    ['qwen3.4-max',                       32_768, 'qwen3-base'],
    ['qwen3-flash',                       32_768, 'qwen3-base'],
    ['qwen2.5-7b-instruct-1m',            32_768, 'qwen-1m-build'],
    ['Qwen/Qwen3-8B',                     32_768, 'qwen3-base'],
    ['Qwen/Qwen3.5-9B',                   32_768, 'qwen3-base'],
    ['qwen2.5-7b-instruct',                8_192, 'qwen2-base'],
    ['qwen-vl-7b',                         8_192, 'qwen-fallback'], // no version → fallback
  ])('Qwen: %s → %i (%s)', (name, expectedTokens, expectedSource) => {
    expect(fuzzyMatchMaxOutputTokens(name)).toBe(expectedTokens)
    expect(debugMaxOutputSource(name)).toBe(expectedSource)
  })

  it.each([
    // DeepSeek
    ['deepseek-v4-pro',                   384_000, 'deepseek-v4-pro'],
    ['deepseek-v5',                       384_000, 'deepseek-v4-pro'],
    ['deepseek-r1',                        32_768, 'deepseek-r1'],
    ['deepseek-r1-distill-qwen-32b',       32_768, 'deepseek-r1'],
    ['deepseek-coder-v2-instruct',          8_192, 'deepseek-coder-v2'],
    ['deepseek-v3',                         8_192, 'deepseek-v3'],
    ['deepseek-v2',                         8_192, 'deepseek-v3'],
  ])('DeepSeek: %s → %i (%s)', (name, expectedTokens, expectedSource) => {
    expect(fuzzyMatchMaxOutputTokens(name)).toBe(expectedTokens)
    expect(debugMaxOutputSource(name)).toBe(expectedSource)
  })

  it.each([
    // Kimi
    ['kimi-k2-instruct',                   16_384, 'kimi-k2'],
    ['kimi-k2.5',                          16_384, 'kimi-k2'],
    ['kimi-k2.6',                          32_768, 'kimi-k2.6+'],
    ['kimi-k2.7-code',                     32_768, 'kimi-k2.6+'],
    ['kimi-k2.7-code-highspeed',           32_768, 'kimi-k2.6+'],
    ['Pro/moonshotai/Kimi-K2.6',           32_768, 'kimi-k2.6+'],
    ['moonshot-v1-32k',                    16_384, 'kimi-fallback'], // no k-version match
  ])('Kimi: %s → %i (%s)', (name, expectedTokens, expectedSource) => {
    expect(fuzzyMatchMaxOutputTokens(name)).toBe(expectedTokens)
    expect(debugMaxOutputSource(name)).toBe(expectedSource)
  })

  it.each([
    // MiniMax
    ['Pro/MiniMaxAI/MiniMax-M2.5',         65_536, 'minimax-m2'],
    ['minimax-m1-80k',                     32_768, 'minimax-m1'],
    ['minimax-text-01',                    32_768, 'minimax-m1'],
    ['abab6.5s-chat',                       8_192, 'minimax-abab'],
    ['abab6-chat',                          8_192, 'minimax-abab'],
  ])('MiniMax: %s → %i (%s)', (name, expectedTokens, expectedSource) => {
    expect(fuzzyMatchMaxOutputTokens(name)).toBe(expectedTokens)
    expect(debugMaxOutputSource(name)).toBe(expectedSource)
  })

  it.each([
    // GLM
    ['Pro/zai-org/GLM-5.1',               128_000, 'glm-4.6+'],
    ['glm-5.2',                           128_000, 'glm-4.6+'],
    ['glm-4.7',                           128_000, 'glm-4.6+'],
    ['glm-4.6',                           128_000, 'glm-4.6+'],
    ['glm-4.5-air',                        96_000, 'glm-4'],
    ['glm-4-9b-chat',                      96_000, 'glm-4'],
    ['chatglm3-6b',                         8_192, 'glm-fallback'],
  ])('GLM: %s → %i (%s)', (name, expectedTokens, expectedSource) => {
    expect(fuzzyMatchMaxOutputTokens(name)).toBe(expectedTokens)
    expect(debugMaxOutputSource(name)).toBe(expectedSource)
  })

  it.each([
    // Llama
    ['llama4-scout',                       32_768, 'llama4'],
    ['llama-3.3-70b',                       8_192, 'llama3.1+'],
    ['llama-3.1-8b-instruct',               8_192, 'llama3.1+'],
    ['llama-3-8b',                          4_096, 'llama-base'],
    ['llama-2-7b',                          4_096, 'llama-base'],
  ])('Llama: %s → %i (%s)', (name, expectedTokens, expectedSource) => {
    expect(fuzzyMatchMaxOutputTokens(name)).toBe(expectedTokens)
    expect(debugMaxOutputSource(name)).toBe(expectedSource)
  })

  it.each([
    // Mistral / Phi / Gemma / Yi
    ['mistral-nemo',                       32_768, 'mistral-nemo/large'],
    ['mistral-large',                      32_768, 'mistral-nemo/large'],
    ['mistral-7b-instruct',                 8_192, 'mistral-fallback'],
    ['phi-4',                              16_384, 'phi-4'],
    ['phi-3-mini-128k-instruct',            4_096, 'phi-3'],
    ['gemma-3-27b',                         8_192, 'gemma3'],
    ['gemma-2-9b',                          4_096, 'gemma-fallback'],
    ['yi-1.5-34b',                          4_096, 'yi-1.5+'],
    // Note: parser treats "yi-6b" as version="6" (ahead of size), so it hits
    // yi-1.5+ rather than the family fallback. Both happen to return 4K, so
    // user-facing behavior is identical. Mirrors contextWindowFuzzy parser.
    ['yi-6b',                               4_096, 'yi-1.5+'],
  ])('Mixed: %s → %i (%s)', (name, expectedTokens, expectedSource) => {
    expect(fuzzyMatchMaxOutputTokens(name)).toBe(expectedTokens)
    expect(debugMaxOutputSource(name)).toBe(expectedSource)
  })

  it('returns undefined for unrecognized models', () => {
    expect(fuzzyMatchMaxOutputTokens('totally-unknown-model')).toBeUndefined()
    expect(fuzzyMatchMaxOutputTokens('')).toBeUndefined()
    expect(debugMaxOutputSource('totally-unknown-model')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// tieredMaxOutputTokens — bucket by contextWindow size
// ---------------------------------------------------------------------------

describe('tieredMaxOutputTokens', () => {
  it.each([
    [4_096,    2_048],   // very small context → 2K
    [8_192,    2_048],   // boundary inclusive
    [16_384,   4_096],   // 16K context
    [32_768,   4_096],   // boundary inclusive
    [40_960,   8_192],   // QwQ etc.
    [65_536,   8_192],   // boundary inclusive
    [100_000,  16_384],  // mid
    [131_072,  16_384],  // 128K boundary inclusive
    [200_000,  32_768],  // 200K
    [262_144,  32_768],  // 256K boundary inclusive
    [500_000,  32_768],  // > 256K capped at 32K
    [1_000_000, 32_768],
    [10_240_000, 32_768],
  ])('contextWindow=%i → maxOutput=%i', (ctxWindow, expectedMaxOut) => {
    expect(tieredMaxOutputTokens(ctxWindow)).toBe(expectedMaxOut)
  })
})
