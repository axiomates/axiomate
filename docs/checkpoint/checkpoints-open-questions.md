# Checkpoints Open Questions

Date: 2026-06-08

## Rewind Stats Refresh

The newest `/rewind` file-tab row compares the newest checkpoint to current
disk. If disk changes while the picker is open, the row can become stale.

Decision needed:

- Refresh the newest row when entering confirmation.
- Or document that the picker row is a preview and the final restore/verify path
  is authoritative.

## RewindPlan Staleness

`WorktreeReconcilePlan` captures current disk as `currentTree`. Disk can change
between plan preparation and apply.

Decision needed:

- Abort/rebuild if current disk no longer matches `plan.currentTree`.
- Or rely on final full-tree verification and recovery guidance.

## Rewind Concurrency

Duplicate Enter is guarded in the UI, but the lower-level rewind API can still
be called concurrently.

Decision needed:

- Per-workdir mutex with queued execution.
- Or per-workdir fail-fast "rewind already in progress".

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
