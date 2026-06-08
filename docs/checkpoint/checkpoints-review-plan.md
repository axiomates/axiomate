# Checkpoints Documentation and Review Plan

Date: 2026-06-08

This plan is ordered as requested: documentation first, then Stage 1 and Stage 2
review work.

## Policy

No active checkpoint document may contradict current behavior. If a document is
wrong, update it or delete it. Historical notes belong in git history, not in
`docs/` as stale guidance.

`docs/user/checkpoints_zhcn.html` is part of the same contract as internal
checkpoint docs.

## Documentation Refresh

Status: done for the first pass.

Active checkpoint docs:

- `docs/checkpoint/checkpoints-design.md`
- `docs/checkpoint/checkpoints-review-plan.md`
- `docs/checkpoint/checkpoints-review-findings.md`
- `docs/checkpoint/checkpoints-test-plan.md`
- `docs/checkpoint/checkpoints-open-questions.md`
- `docs/checkpoint/checkpoints-defaults-tuning.md`
- `docs/user/checkpoints_zhcn.html`

Removed from active docs:

- obsolete phase design memo
- obsolete progress log
- obsolete completion plan
- obsolete port audit

## Stage 1: Freeze Current Design

Status: done for the first pass.

Design contract:

1. AI file changes are protected by pre-change snapshots.
2. Only real file diffs become checkpoint commits.
3. Checkpoint commit hash is the file rewind primary key.
4. `messageId` and prompt preview are labels.
5. Nested git metadata is excluded; nested ordinary files are filesystem
   snapshot content.
6. `/rewind` file-tab stats describe rewind consequence.
7. `/checkpoints list` stats describe commit history.
8. `WorktreeReconcilePlan` is a one-shot transaction object with private temp
   NUL pathspec files and a scratch index.

## Stage 2: Review Implementation Against Design

Status: initial review complete; findings recorded in
`docs/checkpoint/checkpoints-review-findings.md`.

Required review tracks:

- Snapshot creation: pre-change/no-change/commit identity.
- Scanner: nested git, ignore boundaries, VCS metadata exclusion.
- `/rewind` rows: hash identity, message label fallback, consequence stats.
- `/checkpoints list`: read-only history and commit-vs-parent stats.
- RewindPlan: one-shot lifecycle, temp cleanup, scratch index isolation.
- Concurrency: duplicate Enter and lower-level concurrent rewind calls.
- E2E: no false-green assertions.

## Next Code Work

1. Rename or narrow rewind-only stats helpers so they cannot be reused by
   `/checkpoints list`.
2. Add temp cleanup tests for prepare/apply/verify failure paths.
3. Decide whether `WorktreeReconcilePlan` needs a runtime one-shot guard.

## Review Exit Criteria

- Design and user docs match implementation.
- `/checkpoints list` and `/rewind` stats semantics are tested separately.
- Rewind is unaffected by stale fixed project index locks.
- Duplicate rewind cannot corrupt a worktree.
- Temp NUL pathspec files are cleaned on success and failure.
- Checkpoint e2e tests assert exit code and meaningful output.
