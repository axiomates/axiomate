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

### F1: `/checkpoints list` used rewind-style stats

Severity: resolved

`/checkpoints list` should render commit-vs-parent stats for each checkpoint
commit. The previous CLI and slash-command handlers computed a separate
rewind/event stats map, whose semantics are consequence/event-oriented and whose
newest entry compares against current disk.

Affected files:

- `agent/src/cli/handlers/checkpoints.ts`
- `agent/src/commands/checkpoints/checkpoints.tsx`

Current action taken:

- `/checkpoints list` should render `SnapshotEntry.filesChanged`,
  `SnapshotEntry.insertions`, `SnapshotEntry.deletions`, and
  `SnapshotEntry.filePaths` from `listSnapshots(..., { withStats: true })`.
- Added `diffStatsBySnapshotHash` as the `/checkpoints list` renderer adapter.
- CLI and slash-command list paths now use commit-vs-parent snapshot stats.

Regression test:

- `agent/src/__tests__/e2e/checkpoint.cli.test.ts` builds a three-checkpoint
  history where the same middle hash has different `/checkpoints list` and
  `/rewind` stats.
- The test asserts `/checkpoints list` shows parent-to-commit stats and the
  rewind row still shows checkpoint-to-next stats.

Current hardening:

- Removed the exported rewind/event stats helper from the public file-history
  API surface.
- Rewind consequence stats are exposed through `buildRewindCodeRows`.
- `/checkpoints list` uses `diffStatsBySnapshotHash` and commit-vs-parent
  `SnapshotEntry` fields.

### F2: Disk-preview helpers used the fixed project index

Severity: resolved

The rewind reconciler now uses an operation-scoped scratch index, which is the
right boundary. Some preview/diff helpers also staged current disk into the
fixed per-project index, which made picker previews, dry-run stats, and no-op
checks vulnerable to stale fixed index locks.

Current action taken:

- Added a short-lived disk-preview scratch index helper.
- `fileHistoryGetDiffVsDisk`, `fileHistoryHasDiffVsDisk`,
  `fileHistoryBulkDiffVsDisk`, and `buildRewindCodeRows` now stage current
  disk through scratch indexes.
- Read-only object lookups no longer pass the fixed index unnecessarily.

Invariant:

- Normal snapshot creation may use the fixed per-project index.
- Any preview/dry-run/no-op helper that stages arbitrary current disk must use
  an operation-scoped scratch index.

Regression test:

- A stale fixed project index lock does not break disk preview helpers or
  `/rewind` row construction.

### F3: Rewind action needs a bottom-layer per-workdir concurrency gate

Severity: resolved

The UI has a `useRef` guard that prevents duplicate Enter dispatch before React
rerenders. That is useful but not a correctness boundary. Future call sites,
tests, or non-React entry points can still call `fileHistoryRewind` concurrently
for the same workdir.

Current action taken:

- Added a process-local per-workdir fail-fast guard around `fileHistoryRewind`.
- Same-workdir concurrent rewinds are rejected before a second transaction can
  prepare or mutate disk.
- Different workdirs are not globally blocked.
- Keep the UI guard as responsiveness polish, not as the only protection.

Regression tests:

- Same-workdir concurrent rewind rejects with "already in progress".
- The guard is released after a failed rewind, allowing a later retry.

### F4: Plan staleness after prepare is accepted and verified at the end

Severity: accepted tradeoff

`WorktreeReconcilePlan` captures `currentTree` and pathspecs for the difference
between that tree and the target. If disk changes after plan creation and before
apply, the final full-tree verification can detect mismatch, but apply may still
operate on a stale pathspec set.

Decision:

- Do not add a pre-apply current-tree check now.
- The prepare-to-apply window is expected to be small in normal operation, but
  not treated as a correctness guarantee.
- Final touched-path and full-tree verification remain the safety boundary.
- User-facing failures should show concise recovery guidance; detailed git and
  pathspec diagnostics belong in debug logs.

Current action taken:

- Rewind prepare/apply/verification errors now avoid exposing full git commands,
  temp NUL paths, lock files, or pathspec internals to the user.
- Added a regression that injects an apply failure and asserts the user-visible
  error stays concise while still pointing at the newest recovery row.

### F4b: Confirmation used stale picker stats

Severity: resolved

`/rewind` File tab picker rows are optimized previews. The newest row can become
stale if disk changes while the picker is open. The confirmation view previously
reused the row's cached `diffStats`, so the displayed `+x -y` and `Restore file`
availability could be based on stale disk state.

Current action taken:

- Selecting a File tab row refreshes only that selected restore hash against
  current disk before entering confirmation.
- The picker list is not reloaded on selection.
- Conversation-tab confirmation continues to avoid file-stat refresh.

Regression tests:

- A real checkpoint-row test builds picker stats, mutates disk, then verifies
  confirmation refresh returns the newer selected-hash diff.
- A helper-level test proves File tab refreshes exactly one restore hash and
  Conversation tab does not refresh file stats.

### F4c: RewindPlan one-shot contract needed runtime enforcement

Severity: resolved

`WorktreeReconcilePlan` owns private temp NUL pathspec files and a scratch index.
The design says a plan is one-shot, but the previous object did not enforce that
at runtime. A future caller could accidentally apply the same plan twice or use
it after cleanup, which would operate from stale prepared state or missing temp
files.

Current action taken:

- Added a plan lifecycle state.
- `apply` consumes a prepared plan and rejects repeated apply.
- `verify` rejects cleaned, failed, or in-progress plans.
- `cleanup` closes the plan and remains idempotent for `finally` safety.

Regression tests:

- Applying the same plan twice is rejected.
- Applying or verifying a cleaned plan is rejected.
- Repeated cleanup is allowed.

### F5: Temp pathspec lifecycle should be pinned on failure paths

Severity: resolved

The plan cleanup path removes the temp directory in `finally`. Tests cover many
restore outcomes, but cleanup itself should be pinned for prepare/apply/verify
failure paths because large NUL files are the reason the plan exists.

Current action taken:

- Added file-history rewind tests that assert no new `axiomate-rewind-*` temp
  directories remain after success, prepare failure, apply failure, and verify
  failure.
- Added a worktree-reconcile test hook to force cleanup failure and verify that
  cleanup diagnostics do not hide the original apply error.

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
- Do not expand to full Ink `/rewind` interaction e2e in this review. Keep
  picker/confirmation semantics covered by row-model and helper tests until a
  stable UI harness or a real UI regression justifies the cost.

## Stage 1 Status

Done in this pass:

- Replaced stale phase docs with `checkpoints-design.md`.
- Defined `/rewind` stats and `/checkpoints list` stats as separate semantics.
- Documented RewindPlan as a transaction-scoped optimization.

## Stage 2 Status

Initial review findings are now either resolved or explicitly accepted in
`docs/checkpoint/checkpoints-open-questions.md`.
