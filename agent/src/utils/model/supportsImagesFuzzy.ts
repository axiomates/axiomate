/**
 * Fuzzy match a model name → does it accept image input?
 *
 * Mirrors contextWindowFuzzy.ts / maxOutputTokensFuzzy.ts: same parser
 * (reuse parseModelName), same lookup-table shape, specific entries before
 * family fallbacks.
 *
 * Cascade in caller (provider.applyThinkingParams' image gate):
 *   1. explicit `~/.axiomate.json` `models[id].supportsImages`
 *   2. fuzzyMatchSupportsImages — this file's table
 *   3. final default: false (text-only is safe — sending images to a
 *      text-only endpoint usually 400s; sending text to a multimodal
 *      endpoint always works)
 *
 * Why this is a separate fuzzy table rather than a vendor- or model-template
 * field: image support is per-MODEL, not per-gateway. api.openai.com hosts
 * both gpt-5 (yes) and o1-mini (no); api.anthropic.com hosts both
 * claude-opus-4 (yes) and claude-haiku-3 (no). A vendor template can't
 * express that split; a fuzzy table on the model name can.
 *
 * Some entries depend on substrings the parser intentionally normalises away
 * (e.g. `gpt-4o` and `gpt-4` both parse to version='4' — the trailing 'o'
 * marker is dropped). Those entries inspect `raw` (lowercased) directly.
 */

import { parseModelName } from './contextWindowFuzzy.js'
import type { ParsedModel } from './contextWindowFuzzy.js'

interface TableEntry {
  match: (p: ParsedModel, raw: string) => boolean
  out: boolean
  source: string
  fallback?: boolean
}

const TABLE: ReadonlyArray<TableEntry> = [
  // ─────────────── OpenAI ───────────────
  // GPT-5+ (gpt-5, gpt-5.5, gpt-5.6, ...): all multimodal per OpenAI docs.
  { source: 'openai-gpt-5+', out: true,
    match: p => p.family === 'openai' && parseFloat(p.version ?? '0') >= 5 },
  // GPT-4o family (raw substring check — the trailing 'o' is dropped by
  // parseModelName so we can't tell '4o' from plain '4' from version alone).
  { source: 'openai-gpt-4o', out: true,
    match: (p, raw) => p.family === 'openai' && /(?:^|[-_/])gpt-?4o(?:[-_/]|$|-mini|-nano)/.test(raw) },
  // GPT-4.1 family (multimodal — version captures '4.1' cleanly).
  { source: 'openai-gpt-4.1', out: true,
    match: p => p.family === 'openai' && p.version === '4.1' },
  // o-series (o1, o3, o4 + their -mini / -nano variants): treat as text-only
  // by default. o1 had limited vision in some endpoints but o1-mini and
  // o3-mini explicitly do not; conservative blanket false avoids 400s.
  { source: 'openai-oseries', out: false,
    match: (_p, raw) => /(?:^|[-_/:\s])o[1-9](?:[-_]|$)/.test(raw) },
  // GPT-3.5 / plain GPT-4 (no '4o' / '4.1' suffix): text-only.
  { source: 'openai-gpt-pre-4o', out: false,
    match: (p, raw) => p.family === 'openai' &&
      (p.version === '3.5' || (p.version === '4' && !/4o|4\.1/.test(raw))) },
  // OpenAI family fallback — assume modern multimodal default. Intentional
  // bias toward true because modern OpenAI lineup is mostly multimodal; an
  // unknown OpenAI-flavored name is more likely a recent model than an
  // ancient one.
  { source: 'openai-fallback', out: true, fallback: true,
    match: p => p.family === 'openai' },

  // ─────────────── Anthropic / Claude ───────────────
  // Mythos preview (per the maxOutput table — Bedrock model card listing).
  { source: 'claude-mythos', out: true,
    match: p => p.family === 'claude' && /mythos/.test(p.variant ?? '') },
  // Fiber (Anthropic codename, multimodal per public previews).
  { source: 'claude-fiber', out: true,
    match: p => p.family === 'claude' && /fiber/.test(p.variant ?? '') },
  // Claude 3+ (sonnet/opus/haiku): all multimodal. Includes opus-4, opus-4.5,
  // opus-4.6+ etc. Claude 2.x and earlier are text-only.
  { source: 'claude-3+', out: true,
    match: p => p.family === 'claude' && parseFloat(p.version ?? '0') >= 3 },
  // Claude 2.x / older: text-only.
  { source: 'claude-pre-3', out: false,
    match: p => p.family === 'claude' && parseFloat(p.version ?? '99') < 3 },
  // Claude family fallback — bias to true (modern lineup).
  { source: 'claude-fallback', out: true, fallback: true,
    match: p => p.family === 'claude' },

  // ─────────────── Qwen ───────────────
  // VL variants (Qwen2-VL, Qwen2.5-VL, Qwen3-VL): multimodal.
  { source: 'qwen-vl', out: true,
    match: p => p.family === 'qwen' && /vl/.test(p.variant ?? '') },
  // Plain Qwen (no -vl): text-only.
  { source: 'qwen-text', out: false,
    match: p => p.family === 'qwen' },

  // ─────────────── DeepSeek ───────────────
  // All DeepSeek public chat/reasoning APIs are text-only (V2/V3/V4/R1 etc).
  // VL line existed historically as research models but is not on the hosted
  // API surface axiomate users typically configure.
  { source: 'deepseek-text', out: false,
    match: p => p.family === 'deepseek' },

  // ─────────────── Kimi (Moonshot) ───────────────
  // K2 family + moonshot-v1-* are all text-only on the official API.
  // Moonshot's vision models historically lived on a separate Kimi-VL
  // surface that isn't typically reached via the standard chat endpoint.
  { source: 'kimi-text', out: false,
    match: p => p.family === 'kimi' },

  // ─────────────── GLM ───────────────
  // GLM thinking family (4/4.5/5/5.1/5.2/Turbo/4.7) on the BigModel
  // OpenAI-compatible chat endpoint is text-only. GLM-4V exists on a
  // separate path; users wanting it would set supportsImages: true
  // explicitly.
  { source: 'glm-text', out: false,
    match: p => p.family === 'glm' },

  // ─────────────── Mistral ───────────────
  // Pixtral (Mistral's vision line) is multimodal.
  { source: 'pixtral', out: true,
    match: (_p, raw) => /pixtral/.test(raw) },
  // Plain Mistral / Mixtral / Magistral / Ministral: text-only.
  { source: 'mistral-text', out: false,
    match: p => p.family === 'mistral' },

  // ─────────────── Llama ───────────────
  // Llama 3.2 vision variants and Llama 4 Scout/Maverick are multimodal.
  // Detect via raw substring since the parser doesn't extract vision tags
  // for the llama family.
  { source: 'llama-vision', out: true,
    match: (p, raw) =>
      p.family === 'llama' && (/vision|scout|maverick/.test(raw) ||
        // Llama 3.2 vision is the only 3.2 multimodal subline; bare 3.2 is
        // text. Conservative: require 'vision' marker.
        false) },
  // Plain Llama: text-only.
  { source: 'llama-text', out: false,
    match: p => p.family === 'llama' },

  // ─────────────── Gemma / Phi / Yi / MiniMax ───────────────
  // Mostly text-only on the surfaces axiomate sees. Gemma 3 is technically
  // multimodal but the hosted surfaces vary; default off and let users opt
  // in. Same for MiniMax — abab/M1/M2 series treat as text by default.
  { source: 'gemma-text', out: false,
    match: p => p.family === 'gemma' },
  { source: 'phi-text', out: false,
    match: p => p.family === 'phi' },
  { source: 'yi-text', out: false,
    match: p => p.family === 'yi' },
  // MiniMax-M3: native multimodal (text/image/video → text per official
  // docs). M2.x and below remain text-only. Specific before family
  // fallback so M3 wins.
  { source: 'minimax-m3-multimodal', out: true,
    match: p => p.family === 'minimax' && /m3/.test(p.version ?? '') },
  { source: 'minimax-text', out: false,
    match: p => p.family === 'minimax' },

  // ─────────────── MiMo (Xiaomi) ───────────────
  // Plain mimo-v2.5 is multimodal (text/image/video/audio in → text out per
  // the Xiaomi MiMo-V2.5 model card); mimo-v2.5-pro is text-only. The variant
  // gate splits the two — pro carries the 'pro' variant, plain v2.5 doesn't.
  // Older mimo-v2-omni was also multimodal but is slated for 2026.6.30
  // deprecation; we don't carry an entry for it (default-false is safe).
  { source: 'mimo-v2.5-multimodal', out: true,
    match: p => p.family === 'mimo' &&
      parseFloat(p.version ?? '0') >= 2.5 &&
      !/pro/.test(p.variant ?? '') },
  // mimo-v2.5-pro and any other MiMo not caught above → text-only.
  { source: 'mimo-text', out: false,
    match: p => p.family === 'mimo' },
]

// ─────────────── Public API ───────────────

export function lookupSupportsImages(
  p: ParsedModel,
  raw: string,
): boolean | undefined {
  for (const entry of TABLE) {
    if (!entry.fallback && entry.match(p, raw)) return entry.out
  }
  for (const entry of TABLE) {
    if (entry.fallback && entry.match(p, raw)) return entry.out
  }
  return undefined
}

export function fuzzyMatchSupportsImages(
  modelName: string,
): boolean | undefined {
  const raw = modelName.toLowerCase()
  return lookupSupportsImages(parseModelName(modelName), raw)
}

/** Diagnostic — returns the table source label that decided the match. */
export function debugSupportsImagesSource(
  modelName: string,
): string | undefined {
  const raw = modelName.toLowerCase()
  const p = parseModelName(modelName)
  for (const entry of TABLE) {
    if (!entry.fallback && entry.match(p, raw)) return entry.source
  }
  for (const entry of TABLE) {
    if (entry.fallback && entry.match(p, raw)) return entry.source
  }
  return undefined
}

/**
 * Resolve the effective image-support flag for a configured model.
 *
 * Precedence:
 *   1. Explicit `models[id].supportsImages` in `~/.axiomate.json` (true/false)
 *   2. Fuzzy match on the model name (this file's table)
 *   3. Final default: false (text-only is the safer floor — sending an image
 *      to a text-only endpoint usually 400s, while sending no image to a
 *      multimodal endpoint always works)
 *
 * Used by all three providers' image-stripping gates so behavior is
 * consistent across protocols. Anthropic's older `!== true` gate (strip
 * unless explicitly true) is replaced by this helper to honor the fuzzy
 * fallback for known multimodal models.
 */
export function resolveSupportsImages(
  modelConfig: { model?: string; supportsImages?: boolean } | undefined,
): boolean {
  if (modelConfig?.supportsImages !== undefined) {
    return modelConfig.supportsImages
  }
  if (modelConfig?.model) {
    const fuzzy = fuzzyMatchSupportsImages(modelConfig.model)
    if (fuzzy !== undefined) return fuzzy
  }
  return false
}
