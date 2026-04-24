/**
 * SessionSearchTool — relevance scoring (Stage 4 helper).
 *
 * Pure function. Higher score = more relevant.
 *
 * Design choices vs. textbook BM25:
 * - **No corpus IDF**: axiomate is single-tenant local CLI, computing IDF
 *   across all sessions adds cost without much benefit at this scale.
 * - **Saturation via k1**: termFreq saturates as it grows (BM25-like with k1=1.2).
 * - **Metadata boosts**: user-curated tag > title > summary fields earn fixed
 *   bonus weights that dwarf raw body matches — mirrors hermes BM25 + boost
 *   pattern but flatter.
 * - **Recency decay**: 1 / (1 + days/halflife) — gentle decay; 30 days halves
 *   the score, 60 days third, etc. Newer sessions surface first when scores
 *   are otherwise close.
 *
 * Plan: see C:\Users\kiro\.claude\plans\ai-agent-harness-enginneering-hermes-ag-lucky-cloud.md
 */
import type { MetadataField } from './types.js'

export interface ScoreInputs {
  /** Number of times the query (or its tokens) appears in the body content. */
  termFreq: number
  /** Total scanned content length in chars (currently informational; reserved). */
  contentLength: number
  /** Which metadata fields contained the query (if any). */
  metadataMatches?: readonly MetadataField[]
  /** Days since session was last modified. Negative is treated as 0. */
  recencyDays: number
}

const TF_K1 = 1.2 // BM25 saturation constant
const TAG_BOOST = 5.0 // user-curated → strongest signal
const TITLE_BOOST = 3.0 // ai-title or custom-title
const SUMMARY_BOOST = 2.0
const RECENCY_HALFLIFE_DAYS = 30

export function scoreHit(inputs: ScoreInputs): number {
  const { termFreq, metadataMatches, recencyDays } = inputs

  // Saturating term-frequency contribution. tf=0 → 0. tf=∞ → 1.
  // BM25-ish: tf / (tf + k1). No length normalization (axiomate sessions
  // vary too much for fixed b parameter to mean much).
  const tfScore = termFreq > 0 ? termFreq / (termFreq + TF_K1) : 0

  // Metadata boosts (additive). Multiple field hits stack.
  let metadataBoost = 0
  if (metadataMatches && metadataMatches.length > 0) {
    if (metadataMatches.includes('tag')) metadataBoost += TAG_BOOST
    if (
      metadataMatches.includes('title') ||
      metadataMatches.includes('customTitle')
    ) {
      metadataBoost += TITLE_BOOST
    }
    if (metadataMatches.includes('summary')) metadataBoost += SUMMARY_BOOST
  }

  const rawScore = tfScore + metadataBoost

  // Recency decay: 1 / (1 + max(0, days)/halflife)
  const safeDays = Math.max(0, recencyDays)
  const recencyFactor = 1 / (1 + safeDays / RECENCY_HALFLIFE_DAYS)

  return rawScore * recencyFactor
}
