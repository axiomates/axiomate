/**
 * SessionSearchTool — per-session summarizer (Stage 4 finalize).
 *
 * Takes a SessionSearchHit with body content (snippet) and asks a cheap aux
 * model to produce a focused recap. Bounded concurrency prevents flooding
 * the aux endpoint when many sessions match.
 *
 * Failures are graceful: a session whose summary fails returns the raw
 * snippet untouched. The hit array is never dropped, only enriched.
 *
 * Plan: see C:\Users\kiro\.claude\plans\ai-agent-harness-enginneering-hermes-ag-lucky-cloud.md
 */
import { sideQuery } from '../../services/api/capabilities/sideQuery.js'
import { getProviderForModel } from '../../services/api/providerRegistry.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getSummaryPrompt } from './prompt.js'
import type { SessionSearchHit } from './types.js'

const DEFAULT_CONCURRENCY = 3
const MAX_TOKENS = 800
const TEMPERATURE = 0.1

export interface SummarizeOpts {
  query: string
  /** Override aux model resolution; mainly for tests. */
  modelOverride?: string
  /** Override max parallel summaries; default 3 (matches hermes). */
  concurrency?: number
  /** Optional abort signal propagated to each LLM call. */
  signal?: AbortSignal
}

/**
 * Pick the model for per-session summarization.
 *
 * Preference order:
 *   1. Explicit `midModel` from config — better instruction following for
 *      synthesis-class queries when user has bothered to configure one
 *   2. Explicit `fastModel` from config — cheap aux model
 *   3. `currentModel` — last resort if neither aux is configured
 *
 * Why not `getMidModel()` directly: that helper falls back to
 * currentModel when midModel is unset, which would route summary calls
 * through the user's flagship model. That defeats the whole "cheap aux
 * task" purpose for the (common) case of users who only configure a
 * fastModel. We fall back to fastModel first to preserve that intent.
 */
export function pickSummaryModel(): string {
  const cfg = getGlobalConfig()
  const models = cfg.models ?? {}
  if (cfg.midModel && models[cfg.midModel]) return cfg.midModel
  if (cfg.fastModel && models[cfg.fastModel]) return cfg.fastModel
  if (cfg.currentModel && models[cfg.currentModel]) return cfg.currentModel
  throw new Error(
    'No model configured. Set currentModel (and optionally fastModel/midModel) ' +
      'in ~/.axiomate.json.',
  )
}

/** Run summarizer on one hit. Returns the hit with `summary` populated, or the hit unchanged on failure. */
export async function summarizeHit(
  hit: SessionSearchHit,
  opts: SummarizeOpts,
): Promise<SessionSearchHit> {
  if (!hit.snippet) return hit // nothing to summarize (metadata-only with empty snippet)

  const model = opts.modelOverride ?? pickSummaryModel()
  let provider
  try {
    provider = getProviderForModel(model)
  } catch (err) {
    logForDebugging(
      `SessionSearch summarize: provider resolution failed for model=${model}: ${err}`,
    )
    return hit
  }

  try {
    const response = await sideQuery(provider, {
      model,
      system: getSummaryPrompt(opts.query),
      messages: [
        {
          role: 'user',
          content: `EXCERPT:\n${hit.snippet}\n\nSummarize the excerpt with focus on: "${opts.query}"`,
        },
      ],
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      signal: opts.signal,
      querySource: 'session_search',
    })

    const textBlock = response.content.find(b => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text' || !textBlock.text.trim()) {
      logForDebugging(
        `SessionSearch summarize: empty response for session ${hit.sessionId}`,
      )
      return hit
    }
    return { ...hit, summary: textBlock.text.trim() }
  } catch (err) {
    logForDebugging(
      `SessionSearch summarize: LLM call failed for session ${hit.sessionId}: ${err}`,
    )
    return hit
  }
}

/**
 * Bounded-concurrency parallel summarizer. Returns hits in the same order
 * as input, each with `summary` populated where the LLM call succeeded.
 * Failed summaries leave the hit unchanged (snippet preserved).
 */
export async function summarizeAll(
  hits: SessionSearchHit[],
  opts: SummarizeOpts,
): Promise<SessionSearchHit[]> {
  if (hits.length === 0) return hits
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const results: SessionSearchHit[] = new Array(hits.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= hits.length) return
      results[idx] = await summarizeHit(hits[idx]!, opts)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, hits.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}
