/**
 * Fuzzy match a model name → max output tokens.
 *
 * Mirrors contextWindowFuzzy.ts: same parser (reuse parseModelName), same
 * lookup-table shape, same explicit/specific/fallback resolution semantics.
 *
 * Cascade in caller (getModelMaxOutputTokens):
 *   1. explicit `~/.axiomate.json` config
 *   2. fuzzyMatchMaxOutputTokens — this file's table (HF generation_config /
 *      vendor docs derived; offline)
 *   3. tieredMaxOutputTokens — by contextWindow size
 *   4. final 32K hard default (handled inside tieredMaxOutputTokens for
 *      contextWindow ≥ 256K and as the floor for unknown sizes)
 *
 * Table values come from vendor API docs and HF model-card
 * `generation_config.json` (max_new_tokens / max_tokens). Where vendor
 * documents the cap as "max output", we use that. Where only context is
 * documented, we pick a conservative value tracking similar models in the
 * family.
 */

import { parseModelName } from './contextWindowFuzzy.js'
import type { ParsedModel } from './contextWindowFuzzy.js'

// ---------------------------------------------------------------------------
// Lookup table (specific → general; first match wins; fallbacks last)
// ---------------------------------------------------------------------------

interface TableEntry {
  match: (p: ParsedModel) => boolean
  out: number
  source: string
  fallback?: boolean
}

const TABLE: ReadonlyArray<TableEntry> = [
  // ---------- OpenAI ----------
  // GPT-5.5 (official OpenAI model docs). GPT-5.6 is carried forward from
  // GPT-5.5 until a distinct official cap is published.
  { source: 'openai-gpt-5.5+', out: 128_000,
    match: p => p.family === 'openai' &&
      ['5.5', '5.6'].includes(p.version ?? '') },

  // ---------- Claude / Anthropic ----------
  // Claude Mythos Preview (AWS Bedrock model card)
  { source: 'claude-mythos-preview', out: 128_000,
    match: p => p.family === 'claude' && /mythos/.test(p.variant ?? '') },
  // Claude Opus 4.6/4.7/4.8 (Anthropic model docs)
  { source: 'claude-opus-4.6+', out: 128_000,
    match: p => p.family === 'claude' &&
      /opus/.test(p.variant ?? '') &&
      ['4.6', '4.7', '4.8'].includes(p.version ?? '') },

  // ---------- Qwen ----------
  // Plus (Qwen3.x-Plus thinking-mode max — DashScope docs)
  { source: 'qwen-plus', out: 65_536,
    match: p => p.family === 'qwen' && /plus/.test(p.variant ?? '') },
  // Qwen3.5+ Max / Flash thinking-mode max — DashScope docs.
  // version >= 3.5 covers the 3.6 / 3.7 generation; older max/flash lines
  // had smaller caps and fall through to qwen3-base / qwen2-base below.
  { source: 'qwen3.5+-max', out: 65_536,
    match: p => p.family === 'qwen' && /max/.test(p.variant ?? '') && parseFloat(p.version ?? '0') >= 3.5 },
  { source: 'qwen3.5+-flash', out: 65_536,
    match: p => p.family === 'qwen' && /flash/.test(p.variant ?? '') && parseFloat(p.version ?? '0') >= 3.5 },
  // Coder ≥ 3 (Qwen3-Coder docs)
  { source: 'qwen3-coder', out: 65_536,
    match: p => p.family === 'qwen' && /coder/.test(p.variant ?? '') && parseFloat(p.version ?? '0') >= 3 },
  // 1M dedicated build → 32K output (recommended)
  { source: 'qwen-1m-build', out: 32_768,
    match: p => p.family === 'qwen' && /1m/.test(p.variant ?? '') },
  // Qwen3 base (generation_config max_new_tokens)
  { source: 'qwen3-base', out: 32_768,
    match: p => p.family === 'qwen' && parseFloat(p.version ?? '0') >= 3 },
  // Qwen2.x / 1.5
  { source: 'qwen2-base', out: 8_192,
    match: p => p.family === 'qwen' && parseFloat(p.version ?? '0') >= 1.5 },
  // Qwen family fallback
  { source: 'qwen-fallback', out: 8_192, fallback: true,
    match: p => p.family === 'qwen' },

  // ---------- DeepSeek ----------
  // V4+ Pro — vendor advertises 384K output (verified against DeepSeek docs)
  { source: 'deepseek-v4-pro', out: 384_000,
    match: p => p.family === 'deepseek' && /^v?[4-9]/.test(p.version ?? '') },
  // R1 / R1-distill — long CoT
  { source: 'deepseek-r1', out: 32_768,
    match: p => p.family === 'deepseek' &&
      (/r\d+/.test(p.version ?? '') || /distill/.test(p.variant ?? '')) },
  // Coder V2/V3
  { source: 'deepseek-coder-v2', out: 8_192,
    match: p => p.family === 'deepseek' && /coder/.test(p.variant ?? '') },
  // V2 / V3 modern MoE
  { source: 'deepseek-v3', out: 8_192,
    match: p => p.family === 'deepseek' && /v?[23]/.test(p.version ?? '') },
  // DeepSeek family fallback
  { source: 'deepseek-fallback', out: 8_192, fallback: true,
    match: p => p.family === 'deepseek' },

  // ---------- Kimi (Moonshot) ----------
  // K2.6 / K2.7[-code] → 32K output (Moonshot official platform docs).
  { source: 'kimi-k2.6+', out: 32_768,
    match: p => p.family === 'kimi' && parseFloat(p.version ?? '0') >= 2.6 },
  // K2 / K2.5 + K1.5 → 16K (K2.5 AWS Bedrock model card).
  { source: 'kimi-k2', out: 16_384,
    match: p => p.family === 'kimi' &&
      (/^2/.test(p.version ?? '') || /^1\.5/.test(p.version ?? '')) },
  // Kimi family fallback
  { source: 'kimi-fallback', out: 16_384, fallback: true,
    match: p => p.family === 'kimi' },

  // ---------- MiniMax ----------
  // M3 → 128K (vendor docs: "MiniMax-M3 推荐值为 131072（128K）"). Specific
  // before family fallback so 'm3' doesn't catch the M2 entry below.
  { source: 'minimax-m3', out: 131_072,
    match: p => p.family === 'minimax' && /m3/.test(p.version ?? '') },
  // M2 (post-reset)
  { source: 'minimax-m2', out: 65_536,
    match: p => p.family === 'minimax' && /m2/.test(p.version ?? '') },
  // M1 / Text-01 (lightning attention)
  { source: 'minimax-m1', out: 32_768,
    match: p => p.family === 'minimax' &&
      (/m1/.test(p.version ?? '') || /text-01/.test(p.variant ?? '')) },
  // abab series
  { source: 'minimax-abab', out: 8_192,
    match: p => p.family === 'minimax' && /abab/.test(p.version ?? '') },
  // MiniMax family fallback
  { source: 'minimax-fallback', out: 65_536, fallback: true,
    match: p => p.family === 'minimax' },

  // ---------- GLM ----------
  // GLM 4.6 / 4.7 / 5 / 5.1 / 5.2 / Turbo → 128K output (Z.ai / BigModel docs)
  { source: 'glm-4.6+', out: 128_000,
    match: p => p.family === 'glm' && parseFloat(p.version ?? '0') >= 4.6 },
  // GLM 4 / 4.5 (Air/AirX/Flash) → 96K
  { source: 'glm-4', out: 96_000,
    match: p => p.family === 'glm' && parseFloat(p.version ?? '0') >= 4 },
  // GLM family fallback
  { source: 'glm-fallback', out: 8_192, fallback: true,
    match: p => p.family === 'glm' },

  // ---------- Llama ----------
  // Llama 4 (Scout/Maverick)
  { source: 'llama4', out: 32_768,
    match: p => p.family === 'llama' && parseFloat(p.version ?? '0') >= 4 },
  // Llama 3.1+
  { source: 'llama3.1+', out: 8_192,
    match: p => p.family === 'llama' && parseFloat(p.version ?? '0') >= 3.1 },
  // Llama 2 / 3 base
  { source: 'llama-base', out: 4_096,
    match: p => p.family === 'llama' && parseFloat(p.version ?? '0') >= 2 },
  // Llama family fallback
  { source: 'llama-fallback', out: 4_096, fallback: true,
    match: p => p.family === 'llama' },

  // ---------- Mistral ----------
  { source: 'mistral-nemo/large', out: 32_768,
    match: p => p.family === 'mistral' &&
      (/nemo/.test(p.variant ?? '') || /(small|medium|large)/.test(p.variant ?? '')) },
  { source: 'mistral-fallback', out: 8_192, fallback: true,
    match: p => p.family === 'mistral' },

  // ---------- Phi ----------
  { source: 'phi-4', out: 16_384,
    match: p => p.family === 'phi' && parseFloat(p.version ?? '0') >= 4 },
  { source: 'phi-3', out: 4_096,
    match: p => p.family === 'phi' && parseFloat(p.version ?? '0') >= 3 },
  { source: 'phi-fallback', out: 4_096, fallback: true,
    match: p => p.family === 'phi' },

  // ---------- Gemma ----------
  { source: 'gemma3', out: 8_192,
    match: p => p.family === 'gemma' && /^3/.test(p.version ?? '') },
  { source: 'gemma-fallback', out: 4_096, fallback: true,
    match: p => p.family === 'gemma' },

  // ---------- Yi ----------
  { source: 'yi-1.5+', out: 4_096,
    match: p => p.family === 'yi' && parseFloat(p.version ?? '0') >= 1.5 },
  { source: 'yi-fallback', out: 4_096, fallback: true,
    match: p => p.family === 'yi' },

  // ---------- MiMo (Xiaomi) ----------
  // mimo-v2.5 and mimo-v2.5-pro both advertise 128K max output (Xiaomi MiMo
  // model detail pages).
  { source: 'mimo-v2.5+', out: 131_072,
    match: p => p.family === 'mimo' && parseFloat(p.version ?? '0') >= 2.5 },
  // MiMo family fallback — older v2-pro / v2-omni / v2-flash predate the
  // 128K output tier; conservative 32K matches their docs.
  { source: 'mimo-fallback', out: 32_768, fallback: true,
    match: p => p.family === 'mimo' },

  // ---------- Doubao (Volcengine Ark) ----------
  // doubao-seed-2.x / evolving all cap output at 32K (Volcengine Ark docs,
  // streaming examples show max_output_tokens 32768). Uniform across the line.
  { source: 'doubao-fallback', out: 32_768, fallback: true,
    match: p => p.family === 'doubao' },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function lookupMaxOutputTokens(p: ParsedModel): number | undefined {
  // Specific entries first; family fallbacks only if nothing more specific matches.
  // Unlike contextWindow, the model name's "Nk/Nm" suffix never indicates output
  // capacity, so we don't honor explicitContextTokens here.
  for (const entry of TABLE) {
    if (!entry.fallback && entry.match(p)) return entry.out
  }
  for (const entry of TABLE) {
    if (entry.fallback && entry.match(p)) return entry.out
  }
  return undefined
}

export function fuzzyMatchMaxOutputTokens(modelName: string): number | undefined {
  return lookupMaxOutputTokens(parseModelName(modelName))
}

/**
 * Tier 3 fallback — pick a sane max output by contextWindow size when no
 * fuzzy table entry matches. Values are conservative lower bounds across
 * the industry (small context → small output; very large context → 32K cap
 * because most vendors don't advertise more than that as a default).
 */
export function tieredMaxOutputTokens(contextWindow: number): number {
  if (contextWindow <= 8_192)    return 2_048
  if (contextWindow <= 32_768)   return 4_096
  if (contextWindow <= 65_536)   return 8_192
  if (contextWindow <= 131_072)  return 16_384
  if (contextWindow <= 262_144)  return 32_768
  return 32_768
}

/**
 * Diagnostic helper — returns the source label that decided the fuzzy match,
 * or undefined if no match. Mirrors contextWindowFuzzy.debugLookupSource.
 */
export function debugMaxOutputSource(modelName: string): string | undefined {
  const p = parseModelName(modelName)
  for (const entry of TABLE) {
    if (!entry.fallback && entry.match(p)) return entry.source
  }
  for (const entry of TABLE) {
    if (entry.fallback && entry.match(p)) return entry.source
  }
  return undefined
}
