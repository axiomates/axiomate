/**
 * Commit-message codec for checkpoint snapshots.
 *
 * **Single source of truth** for the on-disk format of checkpoint commit
 * messages. All readers and writers must go through this module.
 *
 * ## On-disk layout
 *
 * Each checkpoint commit's full message has two parts:
 *
 *   - **subject** (line 1): `axiomate:<messageId>:<label>`
 *   - **body** (lines 3+, after blank separator): structured content,
 *     decoded by `parseCommitBody` below
 *
 * ## Subject
 *
 * Format: `axiomate:<messageId>:<label>`
 *   - prefix `axiomate` is the discriminator (Hermes used opaque `auto`)
 *   - `messageId` may NOT contain `:`, must match [A-Za-z0-9_-]+;
 *     either an Anthropic message UUID (regular turn anchor) or a
 *     fresh `randomUUID()` (pre-rewind safety net's synthetic UUID)
 *   - `label` is free text up to the first newline. **Reserved label
 *     prefixes**:
 *       - `file-history` — normal per-turn anchor, default
 *       - `pre-rewind:<8-char-target-hash>` — pre-rewind safety net,
 *         identifies which rewind this anchor is undoing
 *     Anything else is treated as a free-text label (legacy or future).
 *
 * ## Body
 *
 * Body is optional. When present it carries structured fields, one
 * per line, each prefixed with a discriminator key. Currently:
 *
 *   - `prompt: <preview>` — for normal turn anchors, the first ~80
 *     chars of the user's prompt. Picker uses it to label off-branch
 *     orphan rows: `↶ "<prompt>"`.
 *   - `target: <preview>` — for pre-rewind safety-net anchors, the
 *     first ~80 chars of the rewind target's user message. Picker
 *     uses it to label undo rows: `↶ Undo rewind to "<target>"`.
 *
 * Bodies of unknown / missing form parse to `{ kind: 'unknown', raw }`
 * so adding new field types later (or reading older sessions written
 * before structured bodies existed) doesn't break the parser. The
 * picker's label logic falls through to a generic copy in that case.
 *
 * **Why structured prefixes**: pre-Phase-7-fix, both kinds of body
 * stored a free-form preview string. The picker's syntheticAnchor
 * label rendered `↶ "<body>"` for both — semantically wrong, since
 * "prompt" and "target" describe different points in time relative
 * to the anchor. Adding a one-char-cost prefix lets picker pick the
 * right copy without re-deriving from the subject's label field.
 *
 * Format is intentionally flat and non-extensible-from-callers. If a
 * future phase needs richer per-anchor metadata, add a new key here
 * and update `parseCommitBody` — don't shove JSON or YAML into the
 * body. Bodies are read by humans too (git log, /checkpoints list).
 */

const SUBJECT_PREFIX = 'axiomate'
const ALLOWED_MESSAGE_ID = /^[A-Za-z0-9_-]+$/

/** Reserved label prefix for pre-rewind safety-net anchors. */
export const LABEL_PRE_REWIND = 'pre-rewind'

/** Body-line discriminators. Add new ones here, never inline. */
export const BODY_KEY_PROMPT = 'prompt'
export const BODY_KEY_TARGET = 'target'

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
 *   - Pre-rollback subjects from any code path that pre-dates the
 *     `axiomate:` prefix convention (e.g. literal `pre-rollback snapshot
 *     (restoring to a1b2c3d4)`). The current writer emits
 *     `axiomate:pre-rollback:<label>`, so those parse as `kind: 'axiomate'`
 *     — but if a user `git commit`s directly into the store, we don't choke.
 *   - Manual writes by future tooling that hasn't adopted the format.
 *   - Subjects from a foreign shadow store imported into axiomate's
 *     (e.g. a Hermes store), where the prefix differs.
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

/**
 * Higher-level classifier built on `parseCommitSubject`. Returns the
 * structural role of an anchor — picker / chooser / list all branch on
 * this rather than re-parsing the subject. Adding a new role here means
 * touching one file: every reader picks it up automatically.
 *
 * Roles:
 *   - 'pre-rewind' — safety-net snapshot taken before a rewind. Label
 *     starts with `${LABEL_PRE_REWIND}:`.
 *   - 'turn'       — regular per-turn anchor; any other axiomate-kind
 *     subject.
 *   - 'foreign'    — subject doesn't conform to the format (raw kind
 *     from parseCommitSubject). Surface in lists but the picker
 *     doesn't synthesize ↶ rows for these.
 */
export type AnchorRole = 'pre-rewind' | 'turn' | 'foreign'

export function classifyAnchor(subject: string): AnchorRole {
  const parsed = parseCommitSubject(subject)
  if (parsed.kind !== 'axiomate') return 'foreign'
  return parsed.label.startsWith(`${LABEL_PRE_REWIND}:`) ? 'pre-rewind' : 'turn'
}

/**
 * Single-source-of-truth formatter for human-readable anchor reasons.
 * Used by `/checkpoints list`, status output, debug logs, and any
 * future surface that needs to print "what is this anchor". Routes
 * through `parseCommitSubject` + `parseCommitBody` so the result is
 * derived from the on-disk format, never re-derived from raw strings.
 *
 * @param subject - the raw `git log %s` subject
 * @param body    - the raw `git log %b` body (empty string if absent)
 *
 * Output shapes:
 *   - turn anchor with prompt body:  `<label> "<prompt>" (msgid8)`
 *   - turn anchor without body:      `<label> (msgid8)`
 *   - pre-rewind with target body:   `Undo rewind to "<target>"`
 *   - pre-rewind without target:     `Undo last rewind`
 *   - foreign:                        raw subject (or '(no subject)')
 */
export function formatAnchorReason(subject: string, body: string): string {
  const parsedSubject = parseCommitSubject(subject)
  if (parsedSubject.kind !== 'axiomate') {
    return subject || '(no subject)'
  }
  const parsedBody = parseCommitBody(body)
  const role = classifyAnchor(subject)
  if (role === 'pre-rewind') {
    return parsedBody.kind === 'target' && parsedBody.preview.length > 0
      ? `Undo rewind to "${parsedBody.preview}"`
      : 'Undo last rewind'
  }
  const msgIdSuffix = parsedSubject.messageId
    ? ` (${parsedSubject.messageId.slice(0, 8)})`
    : ''
  if (parsedBody.kind === 'prompt' && parsedBody.preview.length > 0) {
    return `${parsedSubject.label} "${parsedBody.preview}"${msgIdSuffix}`
  }
  return `${parsedSubject.label}${msgIdSuffix}`
}

/**
 * Discriminated union returned by `parseCommitBody`. See module
 * docstring for the on-disk layout.
 */
export type ParsedBody =
  | { kind: 'prompt'; preview: string } // normal turn anchor
  | { kind: 'target'; preview: string } // pre-rewind safety net
  | { kind: 'unknown'; raw: string }    // legacy / no-body / future

/**
 * Build the canonical commit body for a given anchor kind. Truncates
 * the preview to ~80 chars to keep `/checkpoints list` output and
 * picker labels compact. Returns empty string for `kind: 'unknown'`
 * (no body written when caller has nothing to record).
 */
export function formatCommitBody(input:
  | { kind: 'prompt'; preview: string }
  | { kind: 'target'; preview: string }
  | { kind: 'unknown' },
): string {
  if (input.kind === 'unknown') return ''
  const preview = input.preview.replace(/[\r\n]+/g, ' ').slice(0, 80).trim()
  if (preview.length === 0) return ''
  const key = input.kind === 'prompt' ? BODY_KEY_PROMPT : BODY_KEY_TARGET
  return `${key}: ${preview}`
}

/**
 * Inverse of `formatCommitBody`. Recognizes the structured prefixes
 * defined above; falls back to `kind: 'unknown'` for anything else
 * so older sessions or future writers don't crash the picker.
 */
export function parseCommitBody(body: string): ParsedBody {
  const trimmed = body.trim()
  if (trimmed.length === 0) return { kind: 'unknown', raw: '' }
  const promptMatch = trimmed.match(/^prompt:\s*(.*)$/s)
  if (promptMatch) {
    return { kind: 'prompt', preview: promptMatch[1].trim() }
  }
  const targetMatch = trimmed.match(/^target:\s*(.*)$/s)
  if (targetMatch) {
    return { kind: 'target', preview: targetMatch[1].trim() }
  }
  return { kind: 'unknown', raw: trimmed }
}
