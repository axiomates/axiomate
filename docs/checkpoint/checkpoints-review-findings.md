# Checkpoints Review Findings

Date: 2026-06-08

This review uses `docs/checkpoint/checkpoints-design.md` as the source of truth.
The removed v2 phase docs are not review inputs.

## Review Scope

The review covers:

- pre-change snapshot semantics
- nested git filesystem staging
- `/rewind` file-tab row identity and consequence stats
- `/checkpoints list` commit-history stats
- `WorktreeReconcilePlan` lifecycle, temp files, and index isolation
- e2e coverage quality

## Findings

### F1: `/checkpoints list` currently uses rewind-style stats

Severity: high

`/checkpoints list` should render commit-vs-parent stats for each checkpoint
commit. Current CLI and slash-command handlers compute a separate map through
`bulkDiffEventStats`, whose semantics are consequence/event-oriented and whose
newest entry compares against current disk.

Affected files:

- `agent/src/cli/handlers/checkpoints.ts`
- `agent/src/commands/checkpoints/checkpoints.tsx`

Expected fix:

- `/checkpoints list` should render `SnapshotEntry.filesChanged`,
  `SnapshotEntry.insertions`, `SnapshotEntry.deletions`, and
  `SnapshotEntry.filePaths` from `listSnapshots(..., { withStats: true })`.
- `bulkDiffEventStats` should remain a `/rewind` concern or be renamed so it
  cannot be mistaken for checkpoint-list stats.

Required tests:

- Build a three-commit history where commit-vs-parent and rewind consequence
  stats differ.
- Assert `/checkpoints list` shows parent-to-commit stats.
- Assert `/rewind` file-tab rows show checkpoint-to-next or checkpoint-to-disk
  stats.

### F2: Rewind no longer uses the fixed project index, but other disk-preview helpers still can

Severity: medium

The rewind reconciler now uses an operation-scoped scratch index, which is the
right boundary. Some preview/diff helpers still stage current disk into the
fixed per-project index. That is acceptable for ordinary snapshot/list paths
only if they do not run concurrently with restore-sensitive operations.

Known helper to revisit:

- `fileHistoryBulkDiffVsDisk`

Expected fix:

- Delete unused fixed-index preview helpers, or move them to scratch indexes.
- Keep the invariant simple: any operation that stages arbitrary current disk
  outside normal snapshot creation should prefer an operation-scoped index.

Required tests:

- A stale fixed index lock must not break `/rewind`.
- A stale fixed index lock should not break any active picker preview path that
  the UI still calls.

### F3: Rewind action needs a bottom-layer per-workdir concurrency gate

Severity: medium

The UI has a `useRef` guard that prevents duplicate Enter dispatch before React
rerenders. That is useful but not a correctness boundary. Future call sites,
tests, or non-React entry points can still call `fileHistoryRewind` concurrently
for the same workdir.

Expected fix:

- Add a per-workdir rewind mutex or fail-fast guard around `fileHistoryRewind`.
- Keep the UI guard as responsiveness polish, not as the only protection.

Required tests:

- Two concurrent rewinds for the same workdir are serialized or one is rejected
  before disk mutation.
- Concurrent rewinds for different workdirs do not block each other.

### F4: Plan staleness after prepare is not explicitly checked

Severity: medium

`WorktreeReconcilePlan` captures `currentTree` and pathspecs for the difference
between that tree and the target. If disk changes after plan creation and before
apply, the final full-tree verification can detect mismatch, but apply may still
operate on a stale pathspec set.

Expected decision:

- Either accept final verification as the safety boundary and document the
  tradeoff, or add a pre-apply current-tree check that rebuilds or aborts when
  disk no longer matches `plan.currentTree`.

Required tests:

- Mutate an untouched path after plan creation but before apply.
- Verify the chosen behavior: rebuild/abort or fail with the recovery hint.

### F5: Temp pathspec lifecycle should be pinned on failure paths

Severity: medium

The plan cleanup path removes the temp directory in `finally`. Tests cover many
restore outcomes, but cleanup itself should be pinned for prepare/apply/verify
failure paths because large NUL files are the reason the plan exists.

Required tests:

- Prepare failure removes temp dir.
- Apply failure removes temp dir.
- Verification failure removes temp dir.
- Cleanup failure is logged without hiding the original restore error.

### F6: Existing checkpoint e2e had false-green assertions

Severity: resolved for the touched file, but keep as test-policy finding

The checkpoint CLI e2e previously allowed module-not-found and non-zero exit
paths to pass because assertions accepted any stdout/stderr/exitCode and some
tests returned early on non-zero exit.

Current action taken:

- CLI helper path corrected to `agent/dist/cli.js`.
- Assertions now check `stderr`, `exitCode`, and expected stdout.
- Added regression for manual temp deletion plus stale fixed index lock.

Policy:

- E2E tests for checkpoint commands must assert exit code and meaningful output.
- No `if (exitCode !== 0) return` in e2e tests.

## Stage 1 Status

Done in this pass:

- Replaced stale phase docs with `checkpoints-design.md`.
- Defined `/rewind` stats and `/checkpoints list` stats as separate semantics.
- Documented RewindPlan as a transaction-scoped optimization.

## Stage 2 Status

Initial review is complete enough to identify the next code work:

1. Fix `/checkpoints list` stats semantics.
2. Add bottom-layer rewind concurrency protection.
3. Decide and test plan staleness behavior.
4. Expand cleanup-path tests for NUL pathspec temp files.

No code fix should claim the design is complete until these findings are either
closed or explicitly accepted in `docs/checkpoint/checkpoints-open-questions.md`.
