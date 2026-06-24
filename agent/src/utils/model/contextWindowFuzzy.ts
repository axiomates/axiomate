/**
 * Fuzzy match a model name → context window in tokens.
 *
 * 4-step resolution per the design spec:
 *   1. Parse name → 4-tuple (family, version, sizeB, quant) + variant + explicitContextK
 *   2. Walk the lookup table (most-specific first) for a match.
 *   3. Partial info still resolves: quantization is parsed but ignored for
 *      context — q4_K_M / int4 / fp16 of the same model all have the same
 *      context. Missing size or version falls back to the family default.
 *   4. Nothing recognised → return undefined; caller uses 64K floor.
 *
 * Table values come from authoritative vendor docs for hosted APIs and HF
 * `config.json` reads for local/open-weight models. Where the published
 * "advertised" context is YARN-extended at runtime (Qwen 2.5/3 model cards
 * say 128K but config.json ships 32K/40K), the table reflects the **shipped
 * base value**. Users running with explicit YARN should set per-model
 * contextWindow in ~/.axiomate.json.
 */

export type Quant =
  | 'q2_k' | 'q3_k_l' | 'q3_k_m' | 'q3_k_s'
  | 'q4_0' | 'q4_1' | 'q4_k_m' | 'q4_k_s'
  | 'q5_0' | 'q5_1' | 'q5_k_m' | 'q5_k_s'
  | 'q6_k' | 'q8_0'
  | 'int4' | 'int8' | 'fp8' | 'fp16' | 'bf16'
  | 'awq' | 'gptq' | 'mlx'

export type Family =
  | 'qwen' | 'deepseek' | 'kimi' | 'minimax'
  | 'gemma' | 'glm' | 'llama' | 'mistral' | 'phi' | 'yi'
  | 'openai' | 'claude' | 'mimo' | 'doubao'

export interface ParsedModel {
  family?: Family
  /** Version string as written ("2.5", "3", "v3", "r1", "4.6") */
  version?: string
  /** Parameter count in billions (8, 32, 70, 1.5, 235, 480) */
  sizeB?: number
  quant?: Quant
  /** Variant tags joined by "-" (coder, plus, 1m, vl, instruct, qwq, math, distill, edge, nemo, small, etc) */
  variant?: string
  /**
   * Context window encoded directly in the model name (e.g.
   * "phi-3-mini-128k-instruct" or "qwen2.5-7b-1m"). Wins over family
   * lookup since the publisher put the number in the name on purpose.
   */
  explicitContextTokens?: number
}

// ---------------------------------------------------------------------------
// Quantization patterns (parsed for completeness; do NOT affect context)
// ---------------------------------------------------------------------------
//
// Order matters — the most specific patterns first so q4_k_m doesn't match q4
// before we get a chance to capture the suffix. We keep a single combined
// regex (rather than iterating the list twice) so we both detect AND strip
// in one pass.
const QUANT_REGEX =
  /[-_]?\b(q[2-8]_k_[mlsxl]|q[2-8]_k|q[4-8]_[01]|int[48]|fp(?:16|8)|bf16|awq|gptq|mlx|gguf|safetensors|q[2-8])\b/i

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseModelName(raw: string): ParsedModel {
  if (!raw) return {}

  // 0. Lowercase + strip provider prefix. We DO NOT collapse separators yet —
  // quant patterns rely on `_` (q4_K_M) being intact.
  let s = raw
    .toLowerCase()
    .replace(/^(local|ollama|vllm|llama-?cpp|hf|huggingface|lmstudio):/i, '')

  // 1. Quantization — detect on raw separators first, then strip.
  let quant: Quant | undefined
  const quantMatch = s.match(QUANT_REGEX)
  if (quantMatch?.[1]) {
    quant = quantMatch[1].toLowerCase() as Quant
  }
  s = s.replace(QUANT_REGEX, '')

  // 2. Now collapse remaining separators so the rest of the parser can use a
  //    single normalized form.
  s = s.replace(/[_\s/]+/g, '-')

  // 3. Explicit "Nk" / "Nm" context in the name itself (publisher-encoded).
  // Examples: "phi-3-mini-128k-instruct", "qwen2.5-7b-1m", "moonshot-v1-32k".
  let explicitContextTokens: number | undefined
  const ctxMMatch = s.match(/(?:^|-)(\d+)m(?=-|\.|$)/)
  const ctxKMatch = s.match(/(?:^|-)(\d+)k(?=-|\.|$)/)
  if (ctxMMatch) {
    explicitContextTokens = parseInt(ctxMMatch[1]!, 10) * 1_000_000
  } else if (ctxKMatch) {
    const n = parseInt(ctxKMatch[1]!, 10)
    // Sanity: a real "Nk context" should be ≥ 4K. Smaller numbers are
    // probably noise (hex digits, version numbers).
    if (n >= 4) explicitContextTokens = n * 1024
  }

  // 4. Size in billions: "8b", "70b", "1.5b", "235b-a22b" (MoE active param).
  // The trailing "-a22b" form is MoE notation; we take the leading total.
  let sizeB: number | undefined
  const sizeMatch = s.match(/(\d+(?:\.\d+)?)b(?:[-.:]|$|-?a\d)/i)
  if (sizeMatch?.[1]) sizeB = parseFloat(sizeMatch[1])

  // 5. Family — pick whichever marker appears EARLIEST in the name (left-to-right).
  // This handles "deepseek-r1-distill-qwen-32b" correctly: even though it
  // contains both "deepseek" and "qwen", the deepseek prefix wins because
  // the family marker is the leading identity, not the distillation backbone.
  // Same logic for "llama-finetune-on-qwen-data" → llama, etc.
  const result: ParsedModel = { quant, sizeB, explicitContextTokens }

  let earliestFamily: Family | undefined
  let earliestPos = Infinity
  for (const { family, pattern } of FAMILY_MARKERS) {
    const m = pattern.exec(s)
    if (m && m.index < earliestPos) {
      earliestPos = m.index
      earliestFamily = family
    }
  }
  result.family = earliestFamily

  // 6. Family-specific version + variant extraction. Only the relevant branch
  // runs; other-family substrings (e.g. distillation backbone names) are
  // intentionally ignored.
  switch (earliestFamily) {
    case 'deepseek': {
      const variants: string[] = []
      if (/coder/.test(s)) variants.push('coder')
      if (/math/.test(s)) variants.push('math')
      // Distill onto a backbone takes precedence over bare 'distill'.
      if (/distill-qwen|distill.*qwen/.test(s)) variants.push('distill-qwen')
      else if (/distill-llama|distill.*llama/.test(s)) variants.push('distill-llama')
      else if (/distill/.test(s)) variants.push('distill')
      const v = s.match(/deepseek-?(?:coder-?|math-?)?(v\d+(?:\.\d+)?|r\d+)/)?.[1]
      if (v) result.version = v
      if (!result.version && /r\d+/.test(s)) {
        const rm = s.match(/(r\d+)/)
        if (rm) result.version = rm[1]
      }
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'qwen': {
      const variants: string[] = []
      if (/qwq/.test(s)) variants.push('qwq')
      if (/coder/.test(s)) variants.push('coder')
      if (/plus/.test(s)) variants.push('plus')
      if (/(?:^|-)max(?:-|$)/.test(s)) variants.push('max')
      if (/flash/.test(s)) variants.push('flash')
      if (/(?:^|-)1m(?:-|$)/.test(s)) variants.push('1m')
      if (/(?:^|-)vl(?![a-z])/.test(s)) variants.push('vl')
      const v = s.match(/qwen-?(\d+(?:\.\d+)?)/)?.[1]
      if (v) result.version = v
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'kimi': {
      const variants: string[] = []
      if (/(?:^|-)vl(?![a-z])/.test(s)) variants.push('vl')
      const kV = s.match(/kimi-?k?(\d+(?:\.\d+)?)/)?.[1]
      const mV = s.match(/moonshot-?v?(\d+(?:\.\d+)?)/)?.[1]
      if (kV) result.version = kV
      else if (mV) result.version = mV
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'minimax': {
      const variants: string[] = []
      if (/text-?01/.test(s)) variants.push('text-01')
      const mxV = s.match(/minimax-?m?(\d+(?:\.\d+)?)/)?.[1]
      const ababV = s.match(/abab(\d+(?:\.\d+)?)s?/)?.[1]
      if (mxV) result.version = `m${mxV}`
      else if (ababV) result.version = `abab${ababV}`
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'gemma': {
      const variants: string[] = []
      if (/code/.test(s)) variants.push('code')
      const v = s.match(/(?:code)?gemma-?(\d+)/)?.[1]
      if (v) result.version = v
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'glm': {
      const variants: string[] = []
      if (/(?:^|-)1m(?:-|$)/.test(s)) variants.push('1m')
      if (/edge/.test(s)) variants.push('edge')
      const v = s.match(/(?:chat)?glm-?(\d+(?:\.\d+)?)/)?.[1]
      if (v) result.version = v
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'llama': {
      const v = s.match(/l(?:la)?ma-?(\d+(?:\.\d+)?)/)?.[1]
      if (v) result.version = v
      break
    }
    case 'mistral': {
      const variants: string[] = []
      if (/nemo/.test(s)) variants.push('nemo')
      const sizeVariant = s.match(/(small|medium|large)/)?.[1]
      if (sizeVariant) variants.push(sizeVariant)
      const v = s.match(/(?:mistral|mixtral|magistral|ministral)-?(\d+(?:\.\d+)?)/)?.[1]
      if (v) result.version = v
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'phi': {
      const v = s.match(/phi-?(\d+(?:\.\d+)?)/)?.[1]
      if (v) result.version = v
      break
    }
    case 'yi': {
      const v = s.match(/yi-?(\d+(?:\.\d+)?)/)?.[1]
      if (v) result.version = v
      break
    }
    case 'openai': {
      const variants: string[] = []
      if (/pro/.test(s)) variants.push('pro')
      if (/mini/.test(s)) variants.push('mini')
      if (/nano/.test(s)) variants.push('nano')
      if (/codex/.test(s)) variants.push('codex')
      if (/chat/.test(s)) variants.push('chat')
      const v = s.match(/gpt-?(\d+(?:\.\d+)?)/)?.[1]
      if (v) result.version = v
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'mimo': {
      // Xiaomi MiMo — version like "v2.5", "v2.5-pro". Variants: 'pro'.
      // "mimo-v2.5-pro" → version='2.5', variant='pro'
      // "mimo-v2.5"     → version='2.5'
      // The version regex matches the literal "v2.5" / "2.5" form Xiaomi uses;
      // the optional leading "v" is consumed but not captured.
      const variants: string[] = []
      if (/(?:^|-)pro(?:-|$)/.test(s)) variants.push('pro')
      const v = s.match(/mimo-?v?(\d+(?:\.\d+)?)/)?.[1]
      if (v) result.version = v
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'doubao': {
      // Volcengine Ark Doubao — names use dash-separated version digits and a
      // tier word, e.g.:
      //   "doubao-seed-2-1-pro-260628"   → version='2.1', variant='pro'
      //   "doubao-seed-2-1-turbo-260628" → version='2.1', variant='turbo'
      //   "doubao-seed-2-0-lite-260428"  → version='2.0', variant='lite'
      //   "doubao-seed-evolving"         → variant='evolving' (no numeric version)
      // Capability tables key off the tier word (lite is text-only; pro/turbo/
      // evolving are multimodal); context/output are uniform across the family.
      const variants: string[] = []
      if (/(?:^|-)pro(?:-|$)/.test(s)) variants.push('pro')
      if (/(?:^|-)turbo(?:-|$)/.test(s)) variants.push('turbo')
      if (/(?:^|-)lite(?:-|$)/.test(s)) variants.push('lite')
      if (/(?:^|-)mini(?:-|$)/.test(s)) variants.push('mini')
      if (/(?:^|-)evolving(?:-|$)/.test(s)) variants.push('evolving')
      // "seed-2-1" / "seed-2-0" → join the two digits as major.minor.
      const v = s.match(/doubao-(?:seed-)?(\d+)-(\d+)/)
      if (v) result.version = `${v[1]}.${v[2]}`
      if (variants.length) result.variant = variants.join('-')
      break
    }
    case 'claude': {
      const variants: string[] = []
      if (/mythos/.test(s)) variants.push('mythos')
      if (/fiber/.test(s)) variants.push('fiber')
      const modelClass = s.match(/(?:^|[-.])(opus|sonnet|haiku)(?:[-.]|$)/)?.[1]
      if (modelClass) variants.push(modelClass)
      if (/preview/.test(s)) variants.push('preview')
      // Two layouts in the wild:
      //   class-first: opus-4 / sonnet-3.5 / haiku-3
      //   number-first: claude-3-haiku / claude-3.5-sonnet / claude-2 / claude-2.1
      // Try class-first first (it's the modern Anthropic naming), then fall
      // back to a bare claude-N(.M) capture so 2.x and the older 3-class
      // ordering still parse a version.
      const v = s.match(/(?:opus|sonnet|haiku)-?(\d+)(?:[.-](\d+))?/)
      if (v?.[1]) {
        result.version = v[2] ? `${v[1]}.${v[2]}` : v[1]
      } else {
        const v2 = s.match(/claude-?(\d+(?:\.\d+)?)/)
        if (v2?.[1]) result.version = v2[1]
      }
      if (variants.length) result.variant = variants.join('-')
      break
    }
  }

  return result
}

// Position-based family detection: whichever marker appears EARLIEST wins.
// Order in this array is irrelevant — position in the input string decides.
const FAMILY_MARKERS: ReadonlyArray<{ family: Family; pattern: RegExp }> = [
  { family: 'deepseek', pattern: /deepseek/ },
  { family: 'qwen',     pattern: /(qwen|qwq|千问|通义)/ },
  { family: 'kimi',     pattern: /(kimi|moonshot)/ },
  { family: 'minimax',  pattern: /(minimax|abab)/ },
  { family: 'gemma',    pattern: /gemma/ },
  { family: 'glm',      pattern: /(glm|chatglm|智谱)/ },
  { family: 'llama',    pattern: /(?:^|[-:])l(?:la)?ma/ },
  { family: 'mistral',  pattern: /(mistral|mixtral|magistral|ministral)/ },
  { family: 'phi',      pattern: /phi/ },
  { family: 'yi',       pattern: /(?:^|[-:])yi(?:-|$)/ },
  { family: 'openai',   pattern: /(?:^|[-:.])gpt(?=[-:.]|$)|openai/ },
  { family: 'claude',   pattern: /(claude|anthropic)/ },
  { family: 'mimo',     pattern: /mimo/ },
  { family: 'doubao',   pattern: /doubao/ },
]

// ---------------------------------------------------------------------------
// Lookup table (specific → general; first match wins)
// ---------------------------------------------------------------------------

interface TableEntry {
  match: (p: ParsedModel) => boolean
  ctx: number
  /** Diagnostic label for tests / logs. */
  source: string
  /**
   * True for catch-all family defaults (e.g. "qwen-fallback"). False/undefined
   * for specific entries. The resolver uses this to decide whether to honor
   * an explicit Nk/Nm in the model name: a specific table entry overrides the
   * explicit only via max(); a fallback entry yields to the explicit.
   *
   * Concretely: `moonshot-v1-32k` has no specific kimi entry, so the explicit
   * "32k" wins over the family fallback. `minimax-m1-80k` has a specific
   * "minimax-text-m1" entry (10.24M), which beats the misleading "80k"
   * suffix (which is M1's output token cap, not its context).
   */
  fallback?: boolean
}

const TABLE: ReadonlyArray<TableEntry> = [
  // ---------- OpenAI ----------
  // GPT-5.5 (official OpenAI model docs). GPT-5.6 is carried forward from
  // GPT-5.5 until a distinct official cap is published.
  { source: 'openai-gpt-5.5+', ctx: 1_050_000,
    match: p => p.family === 'openai' &&
      ['5.5', '5.6'].includes(p.version ?? '') },

  // ---------- Claude / Anthropic ----------
  // Claude Mythos Preview (AWS Bedrock model card)
  { source: 'claude-mythos-preview', ctx: 1_000_000,
    match: p => p.family === 'claude' && /mythos/.test(p.variant ?? '') },
  // Claude Opus 4.6/4.7/4.8 (Anthropic model docs)
  { source: 'claude-opus-4.6+', ctx: 1_000_000,
    match: p => p.family === 'claude' &&
      /opus/.test(p.variant ?? '') &&
      ['4.6', '4.7', '4.8'].includes(p.version ?? '') },

  // ---------- Qwen ----------
  // -1M dedicated builds (Qwen2.5-7B/14B-Instruct-1M)
  { source: 'qwen-1m-build', ctx: 1_010_000,
    match: p => p.family === 'qwen' && /1m/.test(p.variant ?? '') },
  // Coder + Plus → 1M (DashScope-only, but users put it in config)
  { source: 'qwen-coder-plus', ctx: 1_000_000,
    match: p => p.family === 'qwen' && /coder/.test(p.variant ?? '') && /plus/.test(p.variant ?? '') },
  // Qwen3-Coder (480B-A35B) → 256K base, documented YARN to 1M
  { source: 'qwen3-coder', ctx: 262_144,
    match: p => p.family === 'qwen' && /coder/.test(p.variant ?? '') && parseFloat(p.version ?? '0') >= 3 },
  // Qwen2.5-Coder → 32K base (not the 128K YARN-extended)
  { source: 'qwen2.5-coder', ctx: 32_768,
    match: p => p.family === 'qwen' && /coder/.test(p.variant ?? '') },
  // Qwen-VL family (mRoPE, base 32K)
  { source: 'qwen-vl', ctx: 32_768,
    match: p => p.family === 'qwen' && /vl/.test(p.variant ?? '') },
  // QwQ → 40K
  { source: 'qwq', ctx: 40_960,
    match: p => p.family === 'qwen' && /qwq/.test(p.variant ?? '') },
  // Qwen3.5+ commercial tiers (Plus / Max / Flash) → 1M (DashScope docs).
  // Three separate entries (vs one combined regex) so debugLookupSource
  // identifies which tier matched. version >= 3.5 covers the 3.6 / 3.7
  // generation while leaving older v3.0–3.4 plus/max/flash to qwen3-base —
  // those predate the 1M context expansion.
  { source: 'qwen3.5+-plus', ctx: 1_000_000,
    match: p => p.family === 'qwen' && /plus/.test(p.variant ?? '') && parseFloat(p.version ?? '0') >= 3.5 },
  { source: 'qwen3.5+-max', ctx: 1_000_000,
    match: p => p.family === 'qwen' && /max/.test(p.variant ?? '') && parseFloat(p.version ?? '0') >= 3.5 },
  { source: 'qwen3.5+-flash', ctx: 1_000_000,
    match: p => p.family === 'qwen' && /flash/.test(p.variant ?? '') && parseFloat(p.version ?? '0') >= 3.5 },
  // Qwen 3.x base → 40K (model card promotes 128K via runtime YARN)
  { source: 'qwen3-base', ctx: 40_960,
    match: p => p.family === 'qwen' && parseFloat(p.version ?? '0') >= 3 },
  // Qwen 2.x / 2.5 → 32K base
  { source: 'qwen2-base', ctx: 32_768,
    match: p => p.family === 'qwen' && parseFloat(p.version ?? '0') >= 2 },
  // Qwen 1.5 → 32K
  { source: 'qwen1.5', ctx: 32_768,
    match: p => p.family === 'qwen' && parseFloat(p.version ?? '0') >= 1.5 },
  // Qwen family fallback → 32K
  { source: 'qwen-fallback', ctx: 32_768, fallback: true,
    match: p => p.family === 'qwen' },

  // ---------- DeepSeek ----------
  // Math (legacy) → 4K
  { source: 'deepseek-math', ctx: 4_096,
    match: p => p.family === 'deepseek' && /math/.test(p.variant ?? '') },
  // Coder legacy 33b → 16K
  { source: 'deepseek-coder-33b', ctx: 16_384,
    match: p => p.family === 'deepseek' && /coder/.test(p.variant ?? '') && p.sizeB === 33 },
  // R1-Distill-Qwen-32B → 128K (distill inherits backbone, not parent)
  { source: 'deepseek-r1-distill-qwen', ctx: 131_072,
    match: p => p.family === 'deepseek' && /distill-qwen/.test(p.variant ?? '') },
  // R1-Distill-Llama-70B → 128K (Llama 3.1+ backbone)
  { source: 'deepseek-r1-distill-llama', ctx: 131_072,
    match: p => p.family === 'deepseek' && /distill-llama/.test(p.variant ?? '') },
  // Coder-V2 / V3 → 160K (modern MoE)
  { source: 'deepseek-coder-v2', ctx: 163_840,
    match: p => p.family === 'deepseek' && /coder/.test(p.variant ?? '') },
  // V4+ (Pro/Flash) → 1M (vendor docs; mirrors maxOutputTokens deepseek-v4-pro)
  { source: 'deepseek-v4-pro', ctx: 1_000_000,
    match: p => p.family === 'deepseek' && /^v?[4-9]/.test(p.version ?? '') },
  // Modern MoE V2-V3 / R1 → 160K
  { source: 'deepseek-moe', ctx: 163_840,
    match: p => p.family === 'deepseek' &&
      (/v?[23]/.test(p.version ?? '') || /r\d+/.test(p.version ?? '')) },
  // DeepSeek family fallback → 160K (most modern)
  { source: 'deepseek-fallback', ctx: 163_840, fallback: true,
    match: p => p.family === 'deepseek' },

  // ---------- Kimi (Moonshot) ----------
  // Current Moonshot lineup — kimi-k2.5 / k2.6 / k2.7-code[-highspeed], plus
  // plain k2 — are all 256K. Match the whole K2 family by version >= 2.
  // moonshot-v1-* carry an explicit Nk suffix handled by explicitContextTokens.
  { source: 'kimi-k2', ctx: 262_144,
    match: p => p.family === 'kimi' && parseFloat(p.version ?? '0') >= 2 },
  // K1.5 (older closed RL) → 128K
  { source: 'kimi-k1.5', ctx: 131_072,
    match: p => p.family === 'kimi' && /^1\.5/.test(p.version ?? '') },
  // Kimi family fallback → 128K
  { source: 'kimi-fallback', ctx: 131_072, fallback: true,
    match: p => p.family === 'kimi' },

  // ---------- MiniMax ----------
  // M3 → 1M (vendor docs; multimodal, 1M ctx). Specific-before-fallback so
  // version 'm3' doesn't fall through to the minimax-m2 entry below.
  { source: 'minimax-m3', ctx: 1_000_000,
    match: p => p.family === 'minimax' && /m3/.test(p.version ?? '') },
  // M2 / M2.x (incl. -highspeed) → 192K. Existing entry, retained as the
  // M2 family default. M2.7 / M2.5 / M2.1 all match `/m2/` and inherit this.
  { source: 'minimax-m2', ctx: 196_608,
    match: p => p.family === 'minimax' && /m2/.test(p.version ?? '') },
  // M1 / Text-01 → 10.24M (lightning attention)
  { source: 'minimax-text-m1', ctx: 10_240_000,
    match: p => p.family === 'minimax' &&
      (/m1/.test(p.version ?? '') || /text-01/.test(p.variant ?? '')) },
  // abab6.5 / 6.5s → 200K
  { source: 'abab6.5', ctx: 200_000,
    match: p => p.family === 'minimax' && /abab6\.5/.test(p.version ?? '') },
  // abab6 → 32K
  { source: 'abab6', ctx: 32_768,
    match: p => p.family === 'minimax' && /abab6/.test(p.version ?? '') },
  // MiniMax family fallback → 192K (M2 era is the new normal)
  { source: 'minimax-fallback', ctx: 196_608, fallback: true,
    match: p => p.family === 'minimax' },

  // ---------- Gemma ----------
  // Gemma 3 1B special → 32K
  { source: 'gemma3-1b', ctx: 32_768,
    match: p => p.family === 'gemma' && /^3/.test(p.version ?? '') && p.sizeB === 1 },
  // Gemma 3 (4B+) → 128K (RoPE-rescaled from 32K pretraining)
  { source: 'gemma3', ctx: 131_072,
    match: p => p.family === 'gemma' && /^3/.test(p.version ?? '') },
  // CodeGemma → 8K (inherits Gemma 1)
  { source: 'codegemma', ctx: 8_192,
    match: p => p.family === 'gemma' && /code/.test(p.variant ?? '') },
  // Gemma 2 → 8K
  { source: 'gemma2', ctx: 8_192,
    match: p => p.family === 'gemma' && /^2/.test(p.version ?? '') },
  // Gemma 1 / family fallback → 8K
  { source: 'gemma-fallback', ctx: 8_192, fallback: true,
    match: p => p.family === 'gemma' },

  // ---------- GLM ----------
  // GLM-4-9B-Chat-1M → 1M
  { source: 'glm-4-1m', ctx: 1_048_576,
    match: p => p.family === 'glm' && /1m/.test(p.variant ?? '') },
  // GLM-5.2 → 1M (vendor docs; the only 5.x with extended context)
  { source: 'glm-5.2', ctx: 1_000_000,
    match: p => p.family === 'glm' && parseFloat(p.version ?? '0') >= 5.2 },
  // GLM-4.6 / 4.7 / 5 / 5.1 / 5-Turbo → 200K
  { source: 'glm-4.6+', ctx: 202_752,
    match: p => p.family === 'glm' && parseFloat(p.version ?? '0') >= 4.6 },
  // GLM-4 / 4.5 → 128K
  { source: 'glm-4', ctx: 131_072,
    match: p => p.family === 'glm' && parseFloat(p.version ?? '0') >= 4 },
  // ChatGLM3 → 8K
  { source: 'chatglm3', ctx: 8_192,
    match: p => p.family === 'glm' && /^3/.test(p.version ?? '') },
  // GLM family fallback → 128K
  { source: 'glm-fallback', ctx: 131_072, fallback: true,
    match: p => p.family === 'glm' },

  // ---------- Llama (bonus, not in user's 6 but very common locally) ----------
  // Llama 4 (Scout/Maverick) → 1M (more accurately ~10M Scout, conservative pick)
  { source: 'llama4', ctx: 1_000_000,
    match: p => p.family === 'llama' && parseFloat(p.version ?? '0') >= 4 },
  // Llama 3.1+ / 3.2 / 3.3 → 128K
  { source: 'llama3.1+', ctx: 131_072,
    match: p => p.family === 'llama' && parseFloat(p.version ?? '0') >= 3.1 },
  // Llama 3 base → 8K
  { source: 'llama3', ctx: 8_192,
    match: p => p.family === 'llama' && parseFloat(p.version ?? '0') >= 3 },
  // Llama 2 → 4K
  { source: 'llama2', ctx: 4_096,
    match: p => p.family === 'llama' && parseFloat(p.version ?? '0') >= 2 },
  // Llama family fallback → 4K
  { source: 'llama-fallback', ctx: 4_096, fallback: true,
    match: p => p.family === 'llama' },

  // ---------- Mistral ----------
  { source: 'mistral-nemo', ctx: 131_072,
    match: p => p.family === 'mistral' && /nemo/.test(p.variant ?? '') },
  { source: 'mistral-large/medium/small', ctx: 131_072,
    match: p => p.family === 'mistral' && /(small|medium|large)/.test(p.variant ?? '') },
  { source: 'mistral-fallback', ctx: 32_768, fallback: true,
    match: p => p.family === 'mistral' },

  // ---------- Phi ----------
  { source: 'phi-4', ctx: 16_384,
    match: p => p.family === 'phi' && parseFloat(p.version ?? '0') >= 4 },
  // Phi-3 base — 4K (the 128K variants self-identify via name "phi-3-mini-128k"
  // which is caught by explicitContextTokens before reaching the table)
  { source: 'phi-3', ctx: 4_096,
    match: p => p.family === 'phi' && parseFloat(p.version ?? '0') >= 3 },
  { source: 'phi-fallback', ctx: 4_096, fallback: true,
    match: p => p.family === 'phi' },

  // ---------- Yi ----------
  { source: 'yi-1.5+', ctx: 32_768,
    match: p => p.family === 'yi' && parseFloat(p.version ?? '0') >= 1.5 },
  { source: 'yi-fallback', ctx: 4_096, fallback: true,
    match: p => p.family === 'yi' },

  // ---------- MiMo (Xiaomi) ----------
  // mimo-v2.5 and mimo-v2.5-pro both advertise 1M tokens (Xiaomi MiMo model
  // detail pages). Pro is text-only with the same context budget; plain v2.5
  // is multimodal with the same budget.
  { source: 'mimo-v2.5+', ctx: 1_000_000,
    match: p => p.family === 'mimo' && parseFloat(p.version ?? '0') >= 2.5 },
  // MiMo family fallback — pre-2.5 (v2-pro, v2-omni, v2-flash) are slated for
  // deprecation in 2026.6.30 per the in-product banner, but until then they
  // accept the same OpenAI-compatible shape and historically shipped with
  // similar context budgets. Conservative 128K matches the lowest documented
  // value across that family (vendor docs vary). Users running them can
  // override via contextWindow in ~/.axiomate.json.
  { source: 'mimo-fallback', ctx: 131_072, fallback: true,
    match: p => p.family === 'mimo' },

  // ---------- Doubao (Volcengine Ark) ----------
  // doubao-seed-2.x (pro/turbo/lite) and doubao-seed-evolving all advertise a
  // 256K context window (Volcengine Ark model list). Uniform across the line,
  // so a single family fallback covers every variant/version.
  { source: 'doubao-fallback', ctx: 262_144, fallback: true,
    match: p => p.family === 'doubao' },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function lookupContextWindow(p: ParsedModel): number | undefined {
  // Two passes: prefer specific entries; family fallbacks only if nothing
  // more specific matches. The explicit-Nk/Nm suffix (publisher-encoded in
  // the model name) interacts with each pass differently:
  //   - Specific table match: take max(table, explicit) — both are signals,
  //     and a publisher-stamped "1m" or "128k" usually means "≥ that much".
  //   - No specific match: explicit beats fallback (e.g. moonshot-v1-32k:
  //     explicit "32k" overrides the kimi family fallback of 128K).
  for (const entry of TABLE) {
    if (!entry.fallback && entry.match(p)) {
      return p.explicitContextTokens != null
        ? Math.max(entry.ctx, p.explicitContextTokens)
        : entry.ctx
    }
  }
  if (p.explicitContextTokens != null) return p.explicitContextTokens
  for (const entry of TABLE) {
    if (entry.fallback && entry.match(p)) return entry.ctx
  }
  return undefined
}

export function fuzzyMatchContextWindow(modelName: string): number | undefined {
  return lookupContextWindow(parseModelName(modelName))
}

/**
 * Exposed for tests / diagnostics. Returns the source that actually decided
 * the final value (mirrors lookupContextWindow's decision tree).
 */
export function debugLookupSource(modelName: string): string | undefined {
  const p = parseModelName(modelName)
  for (const entry of TABLE) {
    if (!entry.fallback && entry.match(p)) {
      if (p.explicitContextTokens != null && p.explicitContextTokens > entry.ctx) {
        return 'explicit-name-suffix'
      }
      return entry.source
    }
  }
  if (p.explicitContextTokens != null) return 'explicit-name-suffix'
  for (const entry of TABLE) {
    if (entry.fallback && entry.match(p)) return entry.source
  }
  return undefined
}
