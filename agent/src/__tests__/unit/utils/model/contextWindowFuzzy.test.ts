import { describe, expect, it } from 'vitest'
import {
  debugLookupSource,
  fuzzyMatchContextWindow,
  parseModelName,
} from '../../../../utils/model/contextWindowFuzzy.js'

// ---------------------------------------------------------------------------
// parseModelName — 4-tuple extraction
// ---------------------------------------------------------------------------

describe('parseModelName', () => {
  it.each([
    ['gpt-5.5',                        { family: 'openai', version: '5.5' }],
    ['openai/gpt-5.5-pro',             { family: 'openai', version: '5.5', variant: 'pro' }],
    ['claude-opus-4.8',                { family: 'claude', version: '4.8', variant: 'opus' }],
    ['claude-opus-4-7-20260219',       { family: 'claude', version: '4.7', variant: 'opus' }],
    ['claude-mythos-preview',          { family: 'claude', variant: 'mythos-preview' }],
  ])('Hosted API models: %s', (name, expected) => {
    expect(parseModelName(name)).toMatchObject(expected)
  })

  it.each([
    ['qwen3:8b',                      { family: 'qwen', version: '3', sizeB: 8 }],
    ['qwen3.5-8b',                    { family: 'qwen', version: '3.5', sizeB: 8 }],
    ['qwen3.6-plus',                  { family: 'qwen', version: '3.6', variant: 'plus' }],
    ['qwen3.7-max',                   { family: 'qwen', version: '3.7', variant: 'max' }],
    ['qwen3.6-flash',                 { family: 'qwen', version: '3.6', variant: 'flash' }],
    ['qwen2.5-24b-int4',              { family: 'qwen', version: '2.5', sizeB: 24, quant: 'int4' }],
    ['qwen3-coder-30b-a3b-instruct-q4_K_M', { family: 'qwen', version: '3', sizeB: 30, variant: 'coder', quant: 'q4_k_m' }],
    ['qwen3-coder-plus',              { family: 'qwen', version: '3', variant: 'coder-plus' }],
    ['qwen2.5-7b-instruct-1m',        { family: 'qwen', version: '2.5', sizeB: 7, variant: '1m' }],
    ['qwen2-vl-72b-instruct',         { family: 'qwen', version: '2', sizeB: 72, variant: 'vl' }],
    ['qwq-32b',                       { family: 'qwen', sizeB: 32, variant: 'qwq' }],
  ])('Qwen: %s', (name, expected) => {
    expect(parseModelName(name)).toMatchObject(expected)
  })

  it.each([
    ['deepseek-v3',                    { family: 'deepseek', version: 'v3' }],
    ['deepseek-v3.2-exp',              { family: 'deepseek', version: 'v3.2' }],
    ['deepseek-r1',                    { family: 'deepseek', version: 'r1' }],
    ['deepseek-r1-distill-qwen-32b',   { family: 'deepseek', sizeB: 32, variant: expect.stringContaining('distill-qwen') }],
    ['deepseek-coder-v2-instruct',     { family: 'deepseek', variant: 'coder' }],
    ['deepseek-coder-33b-instruct',    { family: 'deepseek', sizeB: 33, variant: 'coder' }],
    ['deepseek-math-7b-instruct',      { family: 'deepseek', sizeB: 7, variant: 'math' }],
  ])('DeepSeek: %s', (name, expected) => {
    expect(parseModelName(name)).toMatchObject(expected)
  })

  it.each([
    ['kimi-k2-instruct',               { family: 'kimi', version: '2' }],
    ['kimi-k2.5',                      { family: 'kimi', version: '2.5' }],
    ['kimi-k2.7-code-highspeed',       { family: 'kimi', version: '2.7' }],
    ['kimi-vl-a3b-instruct',           { family: 'kimi', variant: 'vl' }],
    ['moonshot-v1-32k',                { family: 'kimi', version: '1' }],
    ['moonshot-v1-128k',               { family: 'kimi', version: '1' }],
  ])('Kimi: %s', (name, expected) => {
    expect(parseModelName(name)).toMatchObject(expected)
  })

  it.each([
    ['minimax-m1-80k',                 { family: 'minimax', version: 'm1' }],
    ['minimax-m2',                     { family: 'minimax', version: 'm2' }],
    ['minimax-text-01',                { family: 'minimax', variant: 'text-01' }],
    ['abab6',                          { family: 'minimax', version: 'abab6' }],
    ['abab6.5',                        { family: 'minimax', version: 'abab6.5' }],
  ])('MiniMax: %s', (name, expected) => {
    expect(parseModelName(name)).toMatchObject(expected)
  })

  it.each([
    ['gemma-2-9b-it',                  { family: 'gemma', version: '2', sizeB: 9 }],
    ['gemma-3-1b-it',                  { family: 'gemma', version: '3', sizeB: 1 }],
    ['gemma-3-27b-it',                 { family: 'gemma', version: '3', sizeB: 27 }],
    ['codegemma-7b-it',                { family: 'gemma', version: '7', variant: 'code' }],
  ])('Gemma: %s', (name, expected) => {
    expect(parseModelName(name)).toMatchObject(expected)
  })

  it.each([
    ['chatglm3-6b',                    { family: 'glm', version: '3', sizeB: 6 }],
    ['glm-4-9b-chat',                  { family: 'glm', version: '4', sizeB: 9 }],
    ['glm-4-9b-chat-1m',               { family: 'glm', version: '4', sizeB: 9, variant: '1m' }],
    ['glm-4.5',                        { family: 'glm', version: '4.5' }],
    ['glm-4.6',                        { family: 'glm', version: '4.6' }],
  ])('GLM: %s', (name, expected) => {
    expect(parseModelName(name)).toMatchObject(expected)
  })

  it('strips local server prefix', () => {
    expect(parseModelName('local:qwen3:8b').family).toBe('qwen')
    expect(parseModelName('ollama:llama-3.1-70b').family).toBe('llama')
    expect(parseModelName('vllm:deepseek-v3').family).toBe('deepseek')
  })

  it('strips quant suffixes from name parsing (q5_K_M, awq, gptq, fp16, int4, mlx)', () => {
    expect(parseModelName('qwen3-8b-q5_K_M').quant).toBe('q5_k_m')
    expect(parseModelName('qwen3-8b-awq').quant).toBe('awq')
    expect(parseModelName('qwen3-8b-gptq').quant).toBe('gptq')
    expect(parseModelName('qwen3-8b-fp16').quant).toBe('fp16')
    expect(parseModelName('qwen3-8b-int4').quant).toBe('int4')
    expect(parseModelName('qwen3-8b-mlx').quant).toBe('mlx')
    // Quant is captured but family/version still parses correctly
    const p = parseModelName('qwen3-8b-q5_K_M')
    expect(p.family).toBe('qwen')
    expect(p.version).toBe('3')
    expect(p.sizeB).toBe(8)
  })

  it('detects explicit Nk / Nm context in name (publisher-encoded)', () => {
    expect(parseModelName('phi-3-mini-128k-instruct').explicitContextTokens).toBe(128 * 1024)
    expect(parseModelName('moonshot-v1-32k').explicitContextTokens).toBe(32 * 1024)
    expect(parseModelName('moonshot-v1-128k').explicitContextTokens).toBe(128 * 1024)
    expect(parseModelName('qwen2.5-7b-1m').explicitContextTokens).toBe(1_000_000)
  })

  it('returns empty object for unrecognized names', () => {
    expect(parseModelName('totally-made-up-model-99x').family).toBeUndefined()
    expect(parseModelName('').family).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// fuzzyMatchContextWindow — end-to-end correctness against HF data
// ---------------------------------------------------------------------------

describe('fuzzyMatchContextWindow — Qwen', () => {
  it.each([
    ['qwen3:8b',                       40_960],   // Qwen3 base 40K
    ['qwen3-32b',                      40_960],
    ['qwen3.5-8b',                     40_960],   // forward-version → still ≥3 → 40K
    ['qwen2.5-72b-instruct',           32_768],   // base 32K (model card 128K is YARN)
    ['qwen2.5-coder-32b-instruct',     32_768],
    ['qwen2.5-7b-instruct-1m',         1_010_000], // dedicated 1M build, exact HF value
    ['qwen2.5-14b-instruct-1m',        1_010_000],
    ['qwen3-coder-480b-a35b-instruct', 262_144],   // Qwen3-Coder native 256K
    ['qwen3-coder-plus',               1_000_000], // coder + plus → 1M
    // Qwen3.5+ commercial tiers — DashScope 1M context.
    ['qwen3.6-plus',                   1_000_000],
    ['qwen3.7-plus',                   1_000_000],
    ['qwen3.7-max',                    1_000_000],
    ['qwen3.6-flash',                  1_000_000],
    // Predates 3.5 → fall through to qwen3-base (40K) since the 1M expansion
    // didn't apply at that generation.
    ['qwen3-plus',                     40_960],
    ['qwen3.4-max',                    40_960],
    ['qwen2-vl-72b-instruct',          32_768],
    ['qwen1.5-72b-chat',               32_768],
    ['qwq-32b',                        40_960],
  ])('%s → %d', (name, expected) => {
    expect(fuzzyMatchContextWindow(name)).toBe(expected)
  })
})

describe('fuzzyMatchContextWindow — DeepSeek', () => {
  it.each([
    ['deepseek-v2-chat',               163_840],
    ['deepseek-v2.5',                  163_840],
    ['deepseek-v3',                    163_840],
    ['deepseek-v3.1',                  163_840],
    ['deepseek-v3.2-exp',              163_840],
    ['deepseek-v4-pro',                1_000_000],  // V4+ → 1M
    ['deepseek-v4-flash',              1_000_000],
    ['deepseek-v5',                    1_000_000],
    ['deepseek-r1',                    163_840],
    ['deepseek-r1-distill-qwen-32b',   131_072],   // distill inherits Qwen2.5 backbone (128K)
    ['deepseek-coder-v2-instruct',     163_840],
    ['deepseek-coder-33b-instruct',    16_384],    // legacy 16K (linear scaling)
    ['deepseek-math-7b-instruct',      4_096],     // legacy 4K
  ])('%s → %d', (name, expected) => {
    expect(fuzzyMatchContextWindow(name)).toBe(expected)
  })
})

describe('fuzzyMatchContextWindow — Kimi', () => {
  it.each([
    ['kimi-k2-instruct',               262_144],
    ['kimi-k2.5',                      262_144],
    ['kimi-k2.6',                      262_144],
    ['kimi-k2.7-code',                 262_144],
    ['kimi-k2.7-code-highspeed',       262_144],
    ['Pro/moonshotai/Kimi-K2.6',       262_144],
    ['kimi-vl-a3b-instruct',           131_072],
    ['moonshot-v1-8k',                 8 * 1024],
    ['moonshot-v1-32k',                32 * 1024],
    ['moonshot-v1-128k',               128 * 1024],
  ])('%s → %d', (name, expected) => {
    expect(fuzzyMatchContextWindow(name)).toBe(expected)
  })
})

describe('fuzzyMatchContextWindow — MiniMax', () => {
  it.each([
    ['minimax-text-01',                10_240_000],
    ['minimax-m1-80k',                 10_240_000], // M1 still 10.24M; "80k" in name = output limit
    ['minimax-m2',                     196_608],
    ['abab6',                          32_768],
    ['abab6.5',                        200_000],
    ['abab6.5s',                       200_000],
  ])('%s → %d', (name, expected) => {
    expect(fuzzyMatchContextWindow(name)).toBe(expected)
  })
})

describe('fuzzyMatchContextWindow — Gemma', () => {
  it.each([
    ['gemma-2b-it',                    8_192],
    ['gemma-7b-it',                    8_192],
    ['gemma-2-2b-it',                  8_192],
    ['gemma-2-9b-it',                  8_192],
    ['gemma-2-27b-it',                 8_192],
    ['gemma-3-1b-it',                  32_768],   // 1B is the special small case
    ['gemma-3-4b-it',                  131_072],
    ['gemma-3-12b-it',                 131_072],
    ['gemma-3-27b-it',                 131_072],
    ['codegemma-7b-it',                8_192],
  ])('%s → %d', (name, expected) => {
    expect(fuzzyMatchContextWindow(name)).toBe(expected)
  })
})

describe('fuzzyMatchContextWindow — GLM', () => {
  it.each([
    ['chatglm3-6b',                    8_192],
    ['glm-4-9b-chat',                  131_072],
    ['glm-4-9b-chat-1m',               1_048_576],
    ['glm-4.5',                        131_072],
    ['glm-4.6',                        202_752],
    ['glm-4.7',                        202_752],   // 4.7 also ≥4.6
    ['glm-4.7-flashx',                 202_752],
    ['glm-5',                          202_752],
    ['glm-5.1',                        202_752],
    ['glm-5-turbo',                    202_752],
    ['glm-5.2',                        1_000_000], // 5.2 → 1M
  ])('%s → %d', (name, expected) => {
    expect(fuzzyMatchContextWindow(name)).toBe(expected)
  })
})

describe('fuzzyMatchContextWindow — bonus families (Llama / Mistral / Phi / Yi)', () => {
  it.each([
    ['llama-3.1-70b-instruct',         131_072],
    ['llama-3.2-3b',                   131_072],
    ['llama-3-8b',                     8_192],
    ['llama-2-13b-chat',               4_096],
    ['mistral-nemo-12b',               131_072],
    ['mistral-large-2',                131_072],
    ['mixtral-8x7b',                   32_768],
    ['phi-4',                          16_384],
    ['phi-3-mini-4k-instruct',         4 * 1024],     // explicit 4k beats family
    ['phi-3-mini-128k-instruct',       128 * 1024],   // explicit 128k beats family
    ['yi-1.5-34b',                     32_768],
  ])('%s → %d', (name, expected) => {
    expect(fuzzyMatchContextWindow(name)).toBe(expected)
  })
})

describe('fuzzyMatchContextWindow — hosted API models', () => {
  it.each([
    ['gpt-5.5',                        1_050_000],
    ['gpt-5.5-pro',                    1_050_000],
    ['gpt-5.6',                        1_050_000],
    ['claude-opus-4.6',                1_000_000],
    ['claude-opus-4-7-20260219',       1_000_000],
    ['claude-opus-4.8',                1_000_000],
    ['claude-mythos-preview',          1_000_000],
  ])('%s → %s', (name, expected) => {
    expect(fuzzyMatchContextWindow(name)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Quantization is parsed but does NOT change context window
// ---------------------------------------------------------------------------

describe('Quantization is informational only', () => {
  const baseCtx = 40_960 // Qwen3 base
  it.each([
    'qwen3-8b',
    'qwen3-8b-q4_K_M',
    'qwen3-8b-q5_0',
    'qwen3-8b-q8_0',
    'qwen3-8b-int4',
    'qwen3-8b-fp16',
    'qwen3-8b-bf16',
    'qwen3-8b-awq',
    'qwen3-8b-gptq',
    'qwen3-8b-mlx',
  ])('%s → 40_960 (quantization ignored for context)', name => {
    expect(fuzzyMatchContextWindow(name)).toBe(baseCtx)
  })
})

// ---------------------------------------------------------------------------
// Partial info still resolves (per spec step 3)
// ---------------------------------------------------------------------------

describe('Partial info → reasonable family fallback', () => {
  it('size missing → still gets family+version default', () => {
    // qwen2.5 with no size → 32K (Qwen 2.5 base)
    expect(fuzzyMatchContextWindow('qwen2.5')).toBe(32_768)
  })

  it('version missing → family fallback', () => {
    // bare "qwen" → Qwen family fallback (32K)
    expect(fuzzyMatchContextWindow('qwen')).toBe(32_768)
    // bare "deepseek" → DeepSeek family fallback (160K, modern era)
    expect(fuzzyMatchContextWindow('deepseek')).toBe(163_840)
  })

  it('made-up future version assumed ≥ latest known', () => {
    // qwen99 doesn't exist; matches qwen3-base entry (version ≥ 3 → 40K).
    // Reasonable: a future Qwen N is at least as capable as Qwen 3.
    expect(fuzzyMatchContextWindow('qwen99-7b')).toBe(40_960)
  })
})

// ---------------------------------------------------------------------------
// Step 4: nothing matches → undefined (caller uses 64K default)
// ---------------------------------------------------------------------------

describe('Unrecognized model → undefined', () => {
  it.each([
    'totally-unknown-model',
    'mystery-99b-q8',
    'foo-bar-baz',
    '',
  ])('%s → undefined', name => {
    expect(fuzzyMatchContextWindow(name)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// debugLookupSource — for tests + log diagnosis
// ---------------------------------------------------------------------------

describe('debugLookupSource', () => {
  it('reports which entry matched (for diagnosis)', () => {
    expect(debugLookupSource('qwen3-8b')).toBe('qwen3-base')
    expect(debugLookupSource('deepseek-v3')).toBe('deepseek-moe')
    expect(debugLookupSource('phi-3-mini-128k-instruct')).toBe('explicit-name-suffix')
    expect(debugLookupSource('mystery-model')).toBeUndefined()
  })
})
