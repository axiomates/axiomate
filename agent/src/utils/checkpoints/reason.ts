/**
 * Commit-subject codec for checkpoint snapshots.
 *
 * Decision #14 (above-Hermes parity): we encode `{messageId, label}`
 * into the commit subject in a structured form so consumers (Phase 5
 * `/checkpoints list`, round-trip tests, Phase 6 resume↔rollback union)
 * can recover the messageId without regex-mining free-form strings.
 *
 * Format: `axiomate:<messageId>:<label>`
 *   - prefix `axiomate` is the discriminator (Hermes uses opaque `auto`)
 *   - `messageId` may NOT contain `:` (validated below)
 *   - `label` is free text up to the first newline (subject is single-line)
 *
 * The `pre-rollback` reserved messageId (set by `rollback` step 4 in the
 * spec) is just a regular messageId from this module's POV — the parser
 * will round-trip it cleanly. Consumers that care about pre-rollback
 * detection match on `messageId === 'pre-rollback'` after parsing.
 *
 * We deliberately keep the format flat and non-extensible. If Phase 6
 * needs structured fields beyond {messageId, label}, those go in
 * `projects/<hash16>.json` or git notes — not in the subject line.
 */

const SUBJECT_PREFIX = 'axiomate'
const ALLOWED_MESSAGE_ID = /^[A-Za-z0-9_-]+$/

/**
 * Build the canonical commit subject for a snapshot.
 *
 * - `messageId` must match `[A-Za-z0-9_-]+`. Throws on violation — this
 *   is a programmer error, not user input. The fileHistory.ts call site
 *   passes either Anthropic message ids (UUID-like with dashes/underscores
 *   only) or the literal `'pre-rollback'`, so this never fires in
 *   practice. We throw rather than sanitize so a regression up the call
 *   chain (e.g. someone passes a session id with `:`) surfaces loudly
 *   instead of silently corrupting the round-trip.
 * - `label` is free text. Newlines are stripped (git subject must be
 *   single-line). Leading/trailing whitespace preserved — callers may
 *   want it for visual alignment in `/rewind` selectors.
 */
export function formatCommitSubject(reason: {
  messageId: string
  label: string
}): string {
  if (!ALLOWED_MESSAGE_ID.test(reason.messageId)) {
    throw new Error(
      `formatCommitSubject: messageId must match ${ALLOWED_MESSAGE_ID}, ` +
        `got: ${JSON.stringify(reason.messageId)}`,
    )
  }
  const label = reason.label.replace(/[\r\n]+/g, ' ')
  return `${SUBJECT_PREFIX}:${reason.messageId}:${label}`
}

/** Discriminated union returned by `parseCommitSubject`. */
export type ParsedReason =
  | { kind: 'axiomate'; messageId: string; label: string }
  | { kind: 'raw'; subject: string }

/**
 * Inverse of `formatCommitSubject`. Falls back to `kind: 'raw'` for any
 * subject that doesn't match the canonical shape — future-proofs against:
 *
 *   - Pre-rollback subjects written by older Hermes-style code paths
 *     (e.g. literal `pre-rollback snapshot (restoring to a1b2c3d4)`).
 *     The plan still emits these as `axiomate:pre-rollback:<label>`, so
 *     they parse as `kind: 'axiomate'` — but if a user `git commit`s
 *     directly into the store, we don't choke.
 *   - Manual writes by future tooling that hasn't adopted the format.
 *   - Hermes-style imports if we ever migrate v1 → v2.
 *
 * Pure function. No throws (this is a parser, not a validator — the
 * `kind: 'raw'` branch is the validation result for non-conforming
 * input, not an error condition).
 */
export function parseCommitSubject(subject: string): ParsedReason {
  // Match: `axiomate:<messageId>:<rest>`. Capture group 1 enforces the
  // same character class as `formatCommitSubject` (so subjects with
  // `axiomate:foo bar:baz` fall through to `kind: 'raw'` rather than
  // round-tripping to a non-formattable messageId).
  const match = subject.match(/^axiomate:([A-Za-z0-9_-]+):(.*)$/)
  if (!match) {
    return { kind: 'raw', subject }
  }
  const [, messageId, label] = match
  return { kind: 'axiomate', messageId, label }
}
