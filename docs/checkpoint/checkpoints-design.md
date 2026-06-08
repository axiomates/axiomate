# Checkpoints Current Design

This is the active design document for Axiomate checkpoints. Older phase notes,
port audits, and progress logs were removed from active docs because they no
longer matched the implementation. Git history remains the archive.

## Core Model

Axiomate snapshots files before an AI tool turn changes the worktree.

1. Before a file-changing tool runs, Axiomate attempts a pre-change snapshot of
   the current worktree.
2. If that snapshot is identical to the current checkpoint ref tip, no commit is
   written.
3. If disk content differs, the snapshot is committed to the shadow checkpoint
   git store.
4. The checkpoint commit hash is the primary key for file rewind.
5. `messageId`, prompt preview, and line counts are labels and UI metadata, not
   identity.

This means a row labeled "Before edit foo.py" points to the filesystem state
before that prompt's tool changes landed.

## Store Layout

Checkpoint data lives under the Axiomate config directory:

```text
~/.axiomate/checkpoints/
  store/
    objects/
    refs/axiomate/<projectHash16>
    indexes/<projectHash16>
    projects/<projectHash16>.json
    info/exclude
  .last_prune
```

`projectHash16` is `sha256(normalized absolute workdir).slice(0, 16)`.

The shadow store is a real git object database, isolated from the user's own
repository by `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE`. User git config
is muted for checkpoint git processes so signing hooks, credential helpers, and
global ignore files do not affect checkpoint behavior.

Normal snapshot staging uses the fixed per-project index:

```text
~/.axiomate/checkpoints/store/indexes/<projectHash16>
```

Rewind and restore reconciliation must not use that fixed index. They use an
operation-scoped scratch index inside the rewind temp directory.

## Filesystem Snapshot Semantics

The checkpoint store tracks the worktree as one filesystem snapshot. It does not
mirror the user's git repository state.

Production staging does not use the user's repository index and does not run
production `git add -A`.

The staging pipeline is:

1. Walk directory entries to find traversable directories and embedded git
   boundaries.
2. Use `git check-ignore --stdin -z --no-index` for directory-boundary pruning.
3. For each scan root, use `git ls-files --others --exclude-standard -z` with a
   dedicated empty discovery index.
4. Rebuild the checkpoint staging index with `git read-tree --empty`.
5. Add discovered filesystem paths with `git update-index --add -z --stdin`.
6. Drop oversize files from the index.
7. `write-tree`, `commit-tree`, and `update-ref`.

Validation tests may use fresh-index `git add -A` as an oracle for ordinary
trees, and a composed per-repository oracle for embedded repositories. That is a
test oracle, not the production staging mechanism.

## Nested Git Semantics

Nested repositories, submodules, and worktrees are treated as ordinary
filesystem content after metadata is removed.

- Entries named `.git`, `.hg`, and `.svn` are never staged.
- Ordinary files inside an embedded repository are included by current disk
  bytes.
- The nested repository's dirty, staged, untracked, or deleted state is ignored.
- When a traversed directory contains `.git`, file discovery resets ignore scope
  at that directory.
- Parent directory ignore rules can still prune the embedded repository boundary
  before it is entered.
- Parent file-level rules such as `child/*` do not leak into a traversed child
  repository's own file discovery.

Checkpoint-owned default excludes are intentionally small:

- `.git/`, `.hg/`, `.svn/`
- `node_modules/`
- `.DS_Store`, `Thumbs.db`, `desktop.ini`

Other files, including `.env*`, logs, build outputs, lockfiles, and framework
artifacts, are included unless the user's worktree `.gitignore` excludes them.

## `/rewind` File Tab

The file tab is a rewind UI over the current workdir's checkpoint ref history.

- The row key is the checkpoint commit hash.
- `messageId` maps a checkpoint back to the prompt that caused the next change.
- Prompt text and timestamps are labels.
- The displayed `+x -y` means "what selecting this row will change", not "what
  this commit itself changed".

For a checkpoint list ordered newest first:

```text
anchors[0] = newest checkpoint
anchors[1] = previous checkpoint
anchors[2] = older checkpoint
```

`/rewind` file-tab stats are:

- newest row: `anchors[0].tree -> current disk`
- older row `i`: `anchors[i].tree -> next checkpoint tree`

This is consequence-oriented. It answers: "If I press Enter on this row, what
will the managed worktree change toward?"

Rows with no file consequence are hidden from the file tab. The commit hash
remains the restore target even when message labels are missing or synthetic.

## `/checkpoints list`

`/checkpoints list` is a read-only history view. It is not a rewind selector.

Its change counts must describe the checkpoint commit itself:

```text
parent(commit).tree -> commit.tree
```

That is intentionally different from `/rewind` file-tab stats.

The same commit can therefore have different numbers in `/checkpoints list` and
`/rewind`, because the two screens answer different questions.

## Rewind Transaction

File rewind is a transaction around a target checkpoint hash.

The high-level flow is:

1. Verify the target commit still exists.
2. Prepare a worktree reconcile plan.
3. Create a pre-rewind safety snapshot from the prepared current tree.
4. Apply the plan.
5. Verify touched pathspecs.
6. Verify the full managed tree.
7. Clean the plan temp directory.

The pre-rewind snapshot is the recovery anchor. If restore fails after disk is
partially modified, the user can reopen `/rewind` and select the "Before rewind"
row.

## RewindPlan

`WorktreeReconcilePlan` exists to avoid repeated full-tree probes in the Enter
path and to keep large path lists out of memory.

The plan owns:

- target checkpoint hash
- prepared current tree hash
- operation-scoped scratch index
- temp directory
- NUL-delimited checkout pathspec file
- NUL-delimited delete pathspec file
- path counts used to skip empty work

Rules:

- A plan is one-shot.
- A plan is private to one rewind action.
- NUL pathspec files live only under the plan temp directory.
- Cleanup must run in `finally`.
- Restore and verify git commands must use the plan scratch index.
- A stale lock on the fixed per-project index must not affect rewind.

## Performance Design

Two optimizations are part of the current architecture.

### Rewind Row Stats

Older `/rewind` rows derive stats from immutable checkpoint commits. That is not
a cache of mutable disk state; it is a cheap projection of commit history.

Only the newest `/rewind` row compares a checkpoint to current disk and can
change while the picker is open.

### RewindPlan

The Enter path used to repeat expensive work across confirmation, restore, and
verification. `WorktreeReconcilePlan` reuses the current-tree probe and streams
large pathspecs to temp files. This is the correct architecture as long as the
plan remains transaction-scoped and all scratch state is private to that plan.

## Active Maintenance Rule

Checkpoint docs in `docs/` must describe current behavior. Do not add phase
logs, stale audits, or historical design memos as active documentation. If a
behavior changes, update this document and `docs/user/checkpoints_zhcn.html` in
the same change.
