# Checkpoints Open Questions

Date: 2026-06-08

## Rewind Stats Refresh

The newest `/rewind` file-tab row compares the newest checkpoint to current
disk. If disk changes while the picker is open, the row can become stale.

Decision:

- Treat picker rows as preview data.
- When a File tab row is selected, refresh only that selected restore hash
  against current disk before showing confirmation.
- Do not reload the whole picker list on selection.
- Conversation-tab confirmation does not carry file restore state or refresh
  file stats.

## RewindPlan Staleness

`WorktreeReconcilePlan` captures current disk as `currentTree`. Disk can change
between plan preparation and apply.

Decision:

- Do not add a pre-apply freshness check for now.
- The prepare-to-apply window is expected to be small in normal operation, but
  that is not a correctness guarantee. The existing final full-tree
  verification remains the authoritative guard.
- User-facing errors should stay concise; detailed git/pathspec diagnostics
  belong in debug logs.

Follow-up:

- Keep tests that prove verification failures point users at the newest
  recovery row.

## Rewind Concurrency

Duplicate Enter is guarded in the UI, but the lower-level rewind API can still
be called concurrently.

Decision:

- Add a process-local per-workdir fail-fast gate around `fileHistoryRewind`.
- Do not queue rewinds. A queued second rewind is likely based on stale picker
  state after the first rewind changes disk and checkpoint history.
- Concurrent rewinds for different workdirs remain independent.

## Synthetic Checkpoints in `/checkpoints list`

Pre-rewind safety snapshots are real commits. `/checkpoints list` is a history
view, so showing them is defensible. They are also implementation artifacts from
a user point of view.

Decision needed:

- Show all commits by default.
- Or hide synthetic pre-rewind commits unless a verbose flag is passed.

## Foreign Commits

The shadow ref can contain commits without structured `axiomate:<messageId>`
subjects.

Decision needed:

- Keep foreign commits visible in `/checkpoints list` and hidden from
  `/rewind`.
- Or expose them in `/rewind` as hash-only rows.
