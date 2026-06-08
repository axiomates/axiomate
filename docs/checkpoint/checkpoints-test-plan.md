# Checkpoints Test Plan

Date: 2026-06-08

This test plan follows `docs/checkpoint/checkpoints-design.md`.

## Snapshot Creation

- No-change pre-change snapshot does not create a commit.
- A real file change creates one commit on the project ref.
- Commit hash is stable identity for file rewind rows.
- `messageId` is optional label metadata and not required for restore.
- Oversize files are dropped from the managed tree.
- File-count guard skips with typed `too-many-files` result.

## Nested Git Staging

- Ordinary files in nested repositories are captured by current disk bytes.
- `.git`, `.hg`, and `.svn` metadata is never staged.
- Parent file-level ignore rules do not leak into traversed embedded repos.
- Parent directory-level ignore rules can prune the embedded repo boundary.
- Tracked-but-now-ignored user-repo files are not included merely because the
  user's repository tracks them.
- Fresh-index `git add -A` appears only in tests as an oracle, not in production
  staging.

## `/checkpoints list`

- Shows read-only checkpoint history for the current workdir.
- Uses commit-vs-parent stats.
- Does not use current disk for historical commit rows.
- Does not use `/rewind` consequence stats helpers.
- CLI and slash command render the same stats.
- E2E asserts exit code, stderr, and expected stdout.

## `/rewind` File Tab

- Rows are keyed by checkpoint hash.
- Older rows show checkpoint-to-next-checkpoint stats.
- Newest row shows checkpoint-to-current-disk stats.
- Rows with no file consequence are hidden.
- Message labels can be missing without breaking restore.
- Pre-rewind synthetic rows restore by hash.
- Disk drift affects only the newest row unless the design later chooses
  confirm-time refresh.

## RewindPlan

- Stale fixed project index locks do not affect rewind.
- Checkout pathspec and delete pathspec files are NUL-delimited temp files.
- Temp directory is removed after success.
- Temp directory is removed after prepare/apply/verify failure.
- Pathspec records reject absolute paths, drive-prefixed paths, NUL bytes, empty
  records, and traversal outside the worktree.
- File/directory type conflicts are handled before checkout.
- Manual deletion after a later AI-created temp file does not break rewind.

## Rewind Transaction

- Target hash must exist before disk mutation.
- Pre-rewind safety snapshot is created from the prepared current tree.
- If safety snapshot fails with a real error, disk remains unchanged.
- If apply fails after disk mutation, error points to the pre-rewind recovery row.
- Touched-path verify catches confident touched-path mismatches.
- Full-tree verify catches confident managed-tree mismatches.
- Verification command failures are treated as inconclusive according to the
  fail-open checkpoint style.

## Concurrency

- Duplicate UI Enter dispatches one restore action.
- Two concurrent lower-level rewinds for the same workdir are serialized or one
  fails before disk mutation.
- Concurrent rewinds for different workdirs are independent.
- Preview/list helpers that stage disk do not share fixed indexes with rewind
  restore operations.
