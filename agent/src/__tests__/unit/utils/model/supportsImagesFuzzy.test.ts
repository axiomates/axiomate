import { describe, expect, it } from 'vitest'
import {
  debugSupportsImagesSource,
  fuzzyMatchSupportsImages,
  resolveSupportsImages,
} from '../../../../utils/model/supportsImagesFuzzy.js'

describe('fuzzyMatchSupportsImages', () => {
  it.each([
    // ───── OpenAI ─────
    // GPT-5.x is documented multimodal across the line.
    ['gpt-5',                              true,  'openai-gpt-5+'],
    ['gpt-5.5',                            true,  'openai-gpt-5+'],
    ['gpt-5.5-pro',                        true,  'openai-gpt-5+'],
    ['gpt-5.6',                            true,  'openai-gpt-5+'],
    // GPT-4o family — raw substring distinguishes from plain gpt-4.
    ['gpt-4o',                             true,  'openai-gpt-4o'],
    ['gpt-4o-mini',                        true,  'openai-gpt-4o'],
    ['gpt-4o-nano',                        true,  'openai-gpt-4o'],
    // GPT-4.1 family.
    ['gpt-4.1',                            true,  'openai-gpt-4.1'],
    ['gpt-4.1-mini',                       true,  'openai-gpt-4.1'],
    // o-series caps to text-only by default. o[1-9] anchored to a separator
    // so it doesn't match gpt-4o (the preceding 'gpt-4' is not a separator+o
    // pattern).
    ['o1',                                 false, 'openai-oseries'],
    ['o1-mini',                            false, 'openai-oseries'],
    ['o3-mini',                            false, 'openai-oseries'],
    ['o4-mini',                            false, 'openai-oseries'],
    ['openai/o4-mini',                     false, 'openai-oseries'],
    // Plain GPT-3.5 / GPT-4 (no '4o' / '4.1' suffix) → text-only.
    ['gpt-3.5-turbo',                      false, 'openai-gpt-pre-4o'],
    ['gpt-4',                              false, 'openai-gpt-pre-4o'],
    // OpenAI fallback — unknown name on the openai family → bias true
    // (modern lineup is mostly multimodal). The user can flip via On/Off.
    ['gpt-future',                         true,  'openai-fallback'],

    // ───── Anthropic / Claude ─────
    // Claude 3+ all multimodal.
    ['claude-3-haiku',                     true,  'claude-3+'],
    ['claude-3.5-sonnet',                  true,  'claude-3+'],
    ['claude-opus-4',                      true,  'claude-3+'],
    ['claude-opus-4.5',                    true,  'claude-3+'],
    ['claude-opus-4-7-20260219',           true,  'claude-3+'],
    // Codenames (mythos / fiber): treat as multimodal.
    ['claude-mythos-preview',              true,  'claude-mythos'],
    ['claude-fiber-preview',               true,  'claude-fiber'],
    // Claude 2.x → text-only.
    ['claude-2',                           false, 'claude-pre-3'],
    ['claude-2.1',                         false, 'claude-pre-3'],

    // ───── Qwen ─────
    ['qwen2-vl-7b',                        true,  'qwen-vl'],
    ['qwen2.5-vl-72b',                     true,  'qwen-vl'],
    ['qwen3-vl-30b',                       true,  'qwen-vl'],
    // Plain Qwen → text-only.
    ['qwen3-235b',                         false, 'qwen-text'],
    ['qwen2.5-coder-32b',                  false, 'qwen-text'],
    ['qwen-plus',                          false, 'qwen-text'],

    // ───── DeepSeek (all text-only on the chat API) ─────
    ['deepseek-v3',                        false, 'deepseek-text'],
    ['deepseek-v4-pro',                    false, 'deepseek-text'],
    ['deepseek-r1',                        false, 'deepseek-text'],
    ['deepseek-coder-v2',                  false, 'deepseek-text'],

    // ───── Kimi / Moonshot (all text-only on chat API) ─────
    ['kimi-k2',                            false, 'kimi-text'],
    ['kimi-k2.5',                          false, 'kimi-text'],
    ['kimi-k2.6',                          false, 'kimi-text'],
    ['kimi-k2.7-code',                     false, 'kimi-text'],
    ['kimi-k2.7-code-highspeed',           false, 'kimi-text'],
    ['moonshot-v1-32k',                    false, 'kimi-text'],

    // ───── GLM (all text-only on the BigModel chat API) ─────
    ['glm-4.5',                            false, 'glm-text'],
    ['glm-5.2',                            false, 'glm-text'],
    ['glm-4.6-flash',                      false, 'glm-text'],

    // ───── Mistral / Pixtral ─────
    ['pixtral-12b',                        true,  'pixtral'],
    ['mistral-nemo',                       false, 'mistral-text'],
    ['mistral-large',                      false, 'mistral-text'],

    // ───── Llama ─────
    ['llama-3.2-vision',                   true,  'llama-vision'],
    ['llama-4-scout',                      true,  'llama-vision'],
    ['llama-4-maverick',                   true,  'llama-vision'],
    ['llama-3.1-70b',                      false, 'llama-text'],
    ['llama-3-8b',                         false, 'llama-text'],

    // ───── Misc text-only families ─────
    ['gemma-3-27b',                        false, 'gemma-text'],
    ['phi-4',                              false, 'phi-text'],
    ['yi-1.5-34b',                         false, 'yi-text'],
    ['minimax-m2',                         false, 'minimax-text'],
    // MiniMax-M3 is multimodal per official docs (text/image/video → text);
    // M2.x and below are text-only.
    ['MiniMax-M3',                         true,  'minimax-m3-multimodal'],
    ['minimax-m3',                         true,  'minimax-m3-multimodal'],
    ['MiniMax-M2.7',                       false, 'minimax-text'],
    ['MiniMax-M2.7-highspeed',             false, 'minimax-text'],
    ['MiniMax-M2.5',                       false, 'minimax-text'],
    ['MiniMax-M2',                         false, 'minimax-text'],

    // ───── MiMo (Xiaomi) ─────
    // mimo-v2.5: multimodal (text/image/video/audio in → text out)
    ['mimo-v2.5',                          true,  'mimo-v2.5-multimodal'],
    // mimo-v2.5-pro: text-only (per Xiaomi model card)
    ['mimo-v2.5-pro',                      false, 'mimo-text'],
    // Older MiMo lines fall back to text-only
    ['mimo-v2-pro',                        false, 'mimo-text'],

    // ───── Unknown — falls through ─────
    // No family marker → returns undefined; caller defaults to false.
  ])('%s → %s (%s)', (name, expected, expectedSource) => {
    expect(fuzzyMatchSupportsImages(name)).toBe(expected)
    expect(debugSupportsImagesSource(name)).toBe(expectedSource)
  })

  it('returns undefined for unrecognised model names', () => {
    expect(fuzzyMatchSupportsImages('totally-novel-model-99')).toBeUndefined()
    expect(fuzzyMatchSupportsImages('')).toBeUndefined()
  })
})

describe('resolveSupportsImages — explicit > fuzzy > false default', () => {
  it('explicit true wins over a "no" fuzzy match', () => {
    // Force-on a model the table marks text-only.
    expect(
      resolveSupportsImages({ model: 'kimi-k2.7-code', supportsImages: true }),
    ).toBe(true)
  })

  it('explicit false wins over a "yes" fuzzy match', () => {
    // Force-off a model the table marks multimodal.
    expect(
      resolveSupportsImages({ model: 'gpt-5.5', supportsImages: false }),
    ).toBe(false)
  })

  it('falls through to fuzzy when supportsImages is undefined', () => {
    expect(resolveSupportsImages({ model: 'gpt-5.5' })).toBe(true)
    expect(resolveSupportsImages({ model: 'kimi-k2.6' })).toBe(false)
  })

  it('defaults to false when both explicit and fuzzy are absent', () => {
    expect(resolveSupportsImages({ model: 'totally-unknown-99' })).toBe(false)
    expect(resolveSupportsImages({})).toBe(false)
    expect(resolveSupportsImages(undefined)).toBe(false)
  })
})
