# Axiomate/Hermes File Harness Migration Plan

Status date: 2026-06-09

This plan tracks the work to copy the useful file-harness engineering from
Hermes into Axiomate without replacing Axiomate's existing TypeScript file tool
surface.

The goal is not to port Hermes' Python file tools line-for-line. The goal is to
move the invariants: read-before-write safety, stale-write detection, atomic
write semantics, line-ending/BOM correctness, read-dedup safety, failure
classification, and cross-agent coordination.

## Scope Summary

Hermes file harness material worth studying is roughly 4.6k lines across core
implementation and targeted tests:

| Area | Hermes files | Approx. size | Migration stance |
| --- | --- | ---: | --- |
| File state registry | `tools/file_state.py`, `tests/tools/test_file_state_registry.py` | 512 LOC | Adapt concepts, not API |
| Read/write/patch tools | `tools/file_tools.py` | 1,270 LOC | Selectively copy guard semantics |
| Atomic write, BOM, line endings | `tools/file_operations.py` | 1,924 LOC | Port invariants into existing TS helpers |
| Read guard tests | `tests/tools/test_file_read_guards.py` | 699 LOC | Convert behavior to Vitest |
| Staleness tests | `tests/tools/test_file_staleness.py` | 236 LOC | Convert behavior to Vitest |

Axiomate now has a native file harness test surface under
`agent/src/__tests__/unit/tools/FileHarness/`. The current implementation adds
or modifies about 5.6k inserted lines and 0.6k removed lines across
FileHarness tests, file guard logic, registry/locking helpers, failure
metadata, text-format handling, escalation utilities, and this plan. The
earlier file-harness commits include:

- `c8f6b352 test: add file harness coverage`
- `1b0bfaa7 feat: extend file harness stale-write guards`
- `b713951a feat: extend file registry coverage`
- `b8acd2a2 feat: add subagent file state reminders`
- `2c9d7553 feat: serialize file harness writes by path`
- `119af9b9 feat: enforce atomic file write failures`
- `d92d47e4 feat: define file harness text format policy`
- `a1064188 test: catalog file harness failure reasons`
- `35e1c892 feat: add file harness validation failure metadata`
- `8cc0d3a1 feat: add file harness execution failure metadata`
- `6465bf1a feat: wrap atomic write failures with file harness metadata`
- `476a62c8 feat: escalate repeated file edit match failures`

## Progress

### Stage 1: Native Axiomate FileHarness Tests

Status: complete and pushed in `c8f6b352`.

What landed:

- Added `agent/src/__tests__/unit/tools/FileHarness/` test helpers and behavior
  tests.
- Covered baseline FileRead/FileEdit/FileWrite behavior in Axiomate's own
  runtime shape instead of copying Hermes fixtures.
- Also repaired previously unreasonable checkpoint/fileHistory tests so the
  suite can be used as a reliable guardrail.

Approximate committed size:

- 1,061 insertions, 47 deletions across FileHarness and related tests.

### Stage 2A: Read/Write/Edit Guard Semantics

Status: complete and pushed in `1b0bfaa7`.

Implemented decisions:

- `FileReadTool` records `isPartialView` for text reads using `offset` or
  `limit`.
- `FileWriteTool` treats partial reads as insufficient for overwriting an
  existing file.
- `FileEditTool` does not treat partial reads as insufficient. Edit is a
  precise replacement operation: it reads the current full file from disk during
  execution and applies `old_string -> new_string`.
- Partial-read `Edit` is still rejected if the file changed after the partial
  read, because partial read state cannot safely prove content equality.
- Full-read mtime drift now uses a content fallback: if mtime changed but the
  full cached content still matches disk, `Edit`/`Write` can proceed.

Important product decision:

| Tool | Existing file after partial `Read` | Rationale |
| --- | --- | --- |
| `Write` | Reject | Write is full-file replacement, so partial context can destroy unseen content. |
| `Edit` | Allow if file is otherwise fresh | Edit reads current disk content and applies a precise replacement. Full read would waste tokens on large files for small edits. |

### Stage 2B: Read Dedup Status Guard

Status: complete and pushed in `1b0bfaa7`.

Implemented decisions:

- `FileWriteTool` rejects exact `FILE_UNCHANGED_STUB` content.
- It also rejects short wrapper text around that stub.
- It allows normal larger documents that quote the stub as documentation.

Why:

- Hermes blocks internal read-dedup status text from being written back into
  real files.
- Axiomate's equivalent status is `FILE_UNCHANGED_STUB`.

### Stage 2C: Minimal Cross-Context File State Registry

Status: complete and pushed in `1b0bfaa7`.

New file:

- `agent/src/utils/fileStateRegistry.ts`

What it does:

- Maintains process-local logical ordering for file reads and writes.
- Assigns an owner identity to each `ToolUseContext`:
  - subagents use `agentId`;
  - main or anonymous contexts use a WeakMap identity keyed by `readFileState`.
- On `Read`, stores a `registrySequence` on that file's `readFileState` entry.
- On successful `Edit`/`Write`, records the last writer for that path and updates
  the writer's own read state.
- Before `Edit`/`Write`, checks whether another context wrote the same path
  after this context's last read.

What "cross subagent/context fileStateRegistry" means:

Before this registry, Axiomate only had `readFileState` inside each
`ToolUseContext`. That was enough for same-context "read before edit/write":

```text
Read(path) -> readFileState[path] exists -> Edit/Write existing file may proceed
No Read(path) -> readFileState[path] missing -> Edit/Write existing file rejects
```

It did not coordinate multiple contexts. For example:

```text
Parent reads foo.txt
Child/subagent clones parent's readFileState
Child writes foo.txt
Parent still has its old readFileState for foo.txt
Parent writes foo.txt again
```

If filesystem mtime detects the child write, the old stale check can reject.
But if mtime is restored, rounded, or otherwise not useful, the parent can miss
that another in-process context wrote after its read. The new registry fills
that gap by comparing logical read/write order inside the running process.

This is smaller than Hermes' full `FileStateRegistry`. Hermes also has:

- per-agent read stamp maps;
- global last writer map;
- per-path locks;
- `writes_since()` for delegate-completion reminders;
- `known_reads()` for parent reminders;
- an environment kill switch.

Axiomate currently has only the minimal stale sibling-write check needed by
FileRead/FileEdit/FileWrite tests.

Design boundary:

- The registry is not a persistence format.
- `registrySequence` is process-local and is stripped by `cacheToObject`.
- `cloneFileStateCache` intentionally preserves it so subagents inherit the
  parent's read ordering.
- In-process teammates run in the same JS process with `AsyncLocalStorage`
  context isolation, so they share the module-level registry.
- Pane/tmux teammates start another CLI process, so they do not share this
  in-memory registry. Their writes are only caught by mtime/content checks,
  checkpoint-style dirty detection, or future IPC/file-backed state.
- The registry is not a lock. Synchronous `Map` updates are not interrupted
  inside one JS turn, but async tool calls can interleave between awaits.
- It does not solve external editors, arbitrary shell writes, separate OS
  processes, or future Worker-thread tool execution.

Concurrency implication:

- Current registry state is a stale-write detector for structured, same-process
  file tools.
- It does not serialize the full "check stale, then write" critical section.
- Hermes has per-path locking in addition to the registry. Axiomate has not
  ported that yet.
- If Axiomate wants real concurrent write safety, add per-path locks after the
  parent/subagent reminder surface or pull that stage forward if race safety is
  more urgent than user-facing reminders.

## Current Verification

Commit `1b0bfaa7` passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness --hookTimeout 120000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/fileStateCache.test.ts --hookTimeout 120000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 149 files / 2098 tests passing

Commit `b713951a` passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `pnpm run test` with 151 files / 2102 tests passing

Commit `b8acd2a2` passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/fileStateRegistry.test.ts src/__tests__/unit/tools/AgentTool/fileStateReminder.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/AgentTool/fileStateReminder.test.ts src/__tests__/unit/utils/fileStateRegistry.test.ts src/__tests__/unit/tools/FileHarness --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 153 files / 2108 tests passing

Commit `2c9d7553` passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/fileStateRegistry.test.ts src/__tests__/unit/tools/FileHarness --no-file-parallelism --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 153 files / 2115 tests passing

Stage 4A local verification passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/file.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness/fileWrite.behavior.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/file.test.ts src/__tests__/unit/tools/FileHarness --no-file-parallelism --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 154 files / 2117 tests passing

Stage 5 local verification passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness src/__tests__/unit/utils/file.test.ts --no-file-parallelism --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 154 files / 2128 tests passing

Stage 6A local verification passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/fileHarnessFailures.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/checkpoints/prune.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 155 files / 2133 tests passing

Stage 6B validation-metadata local verification passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness/failureMetadata.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness --no-file-parallelism --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 156 files / 2140 tests passing

Stage 6B execution-metadata local verification passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness/failureMetadata.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness --no-file-parallelism --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 156 files / 2144 tests passing

Stage 6B atomic-helper local verification passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/file.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/fileHarnessFailures.test.ts src/__tests__/unit/tools/FileHarness/failureMetadata.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness src/__tests__/unit/utils/file.test.ts src/__tests__/unit/utils/fileHarnessFailures.test.ts --no-file-parallelism --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 156 files / 2144 tests passing

Stage 7A local verification passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/services/tools/toolExecutionValidation.test.ts src/__tests__/unit/utils/fileEditFailureEscalation.test.ts src/__tests__/unit/tools/FileHarness/failureMetadata.test.ts --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness --no-file-parallelism --hookTimeout 120000 --testTimeout 30000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 158 files / 2152 tests passing

Stage 7B and Stage 8 local verification passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness/fileRead.dedup.test.ts src/__tests__/unit/tools/FileHarness/failureMetadata.test.ts --no-file-parallelism --hookTimeout 120000 --testTimeout 30000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness --no-file-parallelism --hookTimeout 120000 --testTimeout 30000` with 7 files / 76 tests passing
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/fileEditFailureEscalation.test.ts src/__tests__/unit/utils/fileReadDedupEscalation.test.ts src/__tests__/unit/services/tools/toolExecutionValidation.test.ts --hookTimeout 120000 --testTimeout 30000` with 3 files / 9 tests passing
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 159 files / 2157 tests passing

Known test-system note:

- FileHarness-focused test files use import mocks and can hang in Vitest's
  parallel file mode when several tool modules are imported concurrently. Use
  `--no-file-parallelism` for focused FileHarness runs. The full `pnpm run
  test` suite passed after this slice.

## Remaining Migration Work

## Current Position

Stage 8 is complete through read-dedup loop guidance. Stage 7B is complete
through low-cardinality edit-failure escalation telemetry. The core
same-process file harness is now implemented for Axiomate's structured file
tools: read-before-write, stale detection, sibling-write detection,
same-process path locking, atomic write semantics, format policy, typed failure
metadata, edit-match escalation, and read-dedup loop guidance.

2026-06-01 review follow-up:

- The highest-risk b59a review item is now resolved: resume/cold-start
  reconstruction for `Write` semantic canonicalization and historical `Edit`
  replay.
- `Write` history reconstruction canonicalizes historical tool input into
  semantic content and records runtime-only `toolNormalization` only when the
  tool input actually contained a leading UTF-8 BOM or CR/CRLF.
- `Edit` history reconstruction replays against full-known transcript content
  only; it does not read current disk and does not seed state from stale human
  edits made after the historical tool call.
- The JSONL transcript is not rewritten, and `toolNormalization` is omitted from
  `cacheToObject`.
- HR2/HR3/HR4 are also resolved: atomic helper strictness is scoped to file
  tools with constrained config/settings fallback, NotebookEdit has full-read
  mtime content fallback, and NotebookEdit/file-harness stale throws are caught
  by the tool runner and surfaced as `is_error` tool results rather than
  exiting the program.
- HR5 is resolved: Bash `_simulatedSedEdit` is a structured harness writer and
  now enforces read-before-write, sibling-write, and mtime/content stale guards.
  Arbitrary Bash/PowerShell writes remain outside this scope.
- HR7 is resolved: process-local `fileStateRegistry`/path locks now use a
  canonical internal path key. Existing paths are resolved through `realpath`,
  new paths under symlinked parents resolve the deepest existing ancestor, and
  casefolding is Windows-only. `readFileState` keys remain unchanged.
- HR8 is resolved: same async-chain reentry into the same canonical path lock
  now fails fast instead of waiting on itself. Normal concurrent writers from
  other async tasks still queue.
- HR9 is resolved: killed/failed async subagent notifications append the same
  file-state reminder when structured child writes touch parent-read files.
  The task status stays killed/failed and the failure summary stays intact.
- There is no remaining core b59a file-harness behavior decision before
  UI/statistics work.

2026-06-09 read-state churn root-cause and fix:

After the 5/31 harness landed, interactive sessions hit frequent false write
rejections ("Error writing file" / "modified since read"), and a long run of
"fix read state" commits (roughly 28e9b6f7..HEAD) chased them. A focused
architecture review found a single root cause, separate from the
content-fidelity fixes.

- Two layers, different verdicts:
  - The content cache (`FileStateCache`) plus transcript reconstruction is
    architecturally sound and matches pristine upstream: hard read-before-write
    + rebuild the content snapshot across compact/resume. Its fixes (lone CR,
    whitespace recovery, line-number-prefix stripping, UTF-16LE decoding) are
    reconstruction-fidelity work that converges.
  - The cross-context registry (`fileStateRegistry.ts`, added 5/31) was the
    defect source. It paired Hermes' registry structure with upstream's
    blocking contract, then tried to reconstruct `registrySequence` — a
    process-local monotonic counter with no transcript representation. The old
    `wasFileModifiedAfterReadByAnotherContext` treated
    `registrySequence === undefined` as stale and rejected. Every
    reconstruction path (print.ts SDK seed, compact restorePreservedReadState,
    REPL resume) repopulates content but cannot repopulate the stamp, so writes
    were wrongly rejected. The "fix registry stamp" commits were patching an
    unreconstructable quantity and could not converge.

- Reference check: neither reference does what 5/31 did. Pristine upstream
  hard-blocks but has no registry/sequence at all. Hermes has the registry but
  it only warns (never blocks) and never reconstructs (drops on compact).

- Fix (2026-06-09):
  1. `wasFileModifiedAfterReadByAnotherContext` now ABSTAINS (returns false) on
     a read with no `registrySequence` instead of reporting stale. An unstamped
     read is reconstructed/injected; its logical order is unknowable, so the
     registry defers to the mtime/content gate. This is the same downgrade
     already accepted for cross-process teammates (decisions #10/#24).
  2. New `shouldForceContentStaleCheck(fileState, mtimeAdvanced)` in
     `fileStateCache.ts` forces a content comparison for an unstamped FULL read
     even when mtime did not advance, closing the narrow gap where a sibling
     write plus a restored/rounded mtime would skip the content check. Gated on
     `fileStateHasFullContent`, so fresh partial-read Edits still proceed
     (decision #4). Wired into all four gates (FileWrite/FileEdit
     validate + in-lock call).
  3. `compact.ts` `restorePreservedReadState` no longer mints a fresh "now"
     stamp for an already-unstamped reconstructed read; it keeps it unstamped
     so the registry abstains. The branch that preserves a real pre-compact
     `registrySequence` is unchanged and correct — the module-level sequence
     counter survives compaction in the same process, so that coordinate stays
     valid.

- Scope notes: full compaction already re-injects recent files as attachments
  (`createPostCompactFileAttachments`) and does not call
  `restorePreservedReadState`; only forked/partial compaction uses it, and it
  is safe after the abstention change. The screenshot symptom of a plan file
  judged "not read" immediately after a Read is the `not_read` gate (cache
  identity / path-key), a separate concern from the sibling-write registry gate
  fixed here.

- Verification: `pnpm run build:types` clean; full `pnpm run test` green
  (2466 tests; one unrelated pathspec performance test flaked on a 5s timeout
  under full-suite load and passes in isolation).

2026-06-09 follow-up (same day, second commit):

- Retired the "stamp on reconstruct" behavior in
  `restoreObservedReadFilesFromMessages` (used by TUI resume and speculation).
  It minted a fresh `registrySequence` for rebuilt historical reads, which
  ordered them after any real concurrent sibling write and masked it — a false
  negative, most impactful during speculation (same live process with real
  `lastWriterByPath` entries). Reconstructed reads are now left unstamped so the
  registry abstains and the content/mtime gate decides. On real TUI resume the
  process is fresh (empty writer registry), so this is observationally a no-op
  there. Four tests updated to assert the abstain semantics; dead helper
  `fileStatesHaveSameObservedContent` removed.
- Deduplicated the four copy-pasted staleness checks (FileWrite/FileEdit,
  validate + in-lock call) into `isReadStateStaleForWrite` in
  `fileStateCache.ts`. `shouldForceContentStaleCheck` remains only where it
  still guards an on-demand disk read (FileWrite validate).
- Added the two highest-value B-class test gaps from the b59a review: dedup
  escalation reset after a real full re-read (B06), and FileEdit match-failure
  escalation reset hinging on read-state object identity — only a
  content-changing re-read resets it (B11).
- Verification: full `pnpm run test` green (2468 tests).

Completed and pushed:

- Stage 1: native Axiomate FileHarness tests.
- Stage 2A/2B/2C: read/write/edit guard semantics, read-dedup write guard, and
  minimal process-local registry.
- Stage 3A: registry coverage for `NotebookEditTool` and structured
  `_simulatedSedEdit`.
- Stage 3B: parent/subagent completion reminders based on registry query APIs.
- Stage 3C: process-local per-path write serialization.
- Stage 4A: strict atomic write failure semantics.
- Stage 5: BOM and line-ending policy for structured file writes.
- Stage 6A: internal file-harness failure taxonomy/catalog.
- Stage 6B: validation result metadata.
- Stage 6B: execution-time typed failures and atomic helper wrapping.
- Stage 7A: repeated FileEdit match-failure tracker and escalation hint.
- Stage 7B: telemetry for repeated FileEdit match-failure escalation.
- Stage 8: repeated `file_unchanged` read-dedup loop guidance.
- HR9: killed/failed subagent file-state reminders.

Completed Stage 6B slice:

- Add `FileHarnessError` / `throwFileHarnessFailure` for execution-time
  failures while preserving existing thrown message text.
- Attach `reason`, `phase: execution`, and `path` to final critical-section
  guards in `FileWriteTool`, `FileEditTool`, and `NotebookEditTool`.
- `FileWriteTool` now distinguishes execution-time `not_read`,
  `partial_read_for_write`, `sibling_write_after_read`, `stale_mtime`, and
  `stale_content`.
- `FileEditTool` now distinguishes execution-time `not_read`,
  `sibling_write_after_read`, `stale_mtime`, and `stale_content`.
- `NotebookEditTool` now distinguishes execution-time `not_read`,
  `sibling_write_after_read`, `stale_mtime`, and `stale_content` after the
  same FileReadTool cell-view content fallback used by its validation path.
- `writeFileSyncAndFlush_DEPRECATED` now wraps atomic write failures in
  `FileHarnessError` with `reason: atomic_write_failed`, `phase: helper`,
  `path`, errno `code`, and original filesystem error in `cause`.

Completed Stage 7B/8 slice:

- Added `file_edit_failure_escalation` telemetry on FileEdit
  `string_not_found` and `multiple_match` validation failures.
- Telemetry intentionally excludes full paths and records only reason, count,
  escalation level, and file extension.
- Added `fileReadDedupEscalation` tracking for repeated unchanged-content read
  stubs.
- `FileReadTool` now includes optional `dedupCount` and `dedupLevel` metadata
  on `file_unchanged` outputs.
- First dedup remains identical in spirit: it returns only the unchanged stub.
- Second repeated unchanged read of the same path/range adds guidance to reuse
  the earlier Read result.
- Third and later repeated unchanged reads add STOP-level guidance.
- A real text or notebook read clears the dedup loop tracker for that path.

Completed HR4 follow-up:

- Keep thrown `FileHarnessError` semantics inside file tools and NotebookEdit
  for execution-time safety failures.
- Treat the tool runner as the boundary: `runToolUse` / `checkPermissionsAndCallTool`
  catches the throw and returns a normal `tool_result` with `is_error: true`.
- The main loop should not exit because a file harness guard throws.
- This is pinned by
  `agent/src/__tests__/unit/services/tools/toolExecutionFileHarnessError.test.ts`.

Next implementation target:

- Treat the remaining harness work as optional observability/UI/recovery
  polish, not missing core Stage 1-8 behavior. Two candidate policy branches
  are explicitly closed for now:
  - `encoding_unsupported` stays reserved in the taxonomy but is not enforced;
    `Edit` keeps current best-effort behavior for compatibility.
  - Cross-process registry/locking is not implemented; mtime/content stale
    checks plus checkpoint/rewind are the accepted cross-session safety layer.
  - HR10 telemetry/privacy audit should precede any dashboard or broad UI
    surfacing of file-harness metadata.

### Stage 3: Complete Registry Coverage

Status: Stage 3A complete and pushed in `b713951a`; Stage 3B complete and
pushed in `b8acd2a2`; Stage 3C complete and pushed in `2c9d7553`; broader
registry coverage remains.

Implemented in Stage 3A:

- `NotebookEditTool` checks sibling writes before validation/call writes and
  calls `noteFileWrite` after a successful notebook write.
- `BashTool` calls `noteFileWrite` only for its internal `_simulatedSedEdit`
  path, where the permission UI already supplied an exact `filePath` and
  `newContent`.

Implemented in Stage 3B:

- `fileStateRegistry` now exposes sequence-based reminder queries:
  `getFileStateRegistrySequence()`, `getKnownReadFilePaths()`, and
  `getPathsWrittenByOtherContextsSince()`.
- `AgentTool` captures the parent's read snapshot before launching a subagent.
- Synchronous subagent completions append a model-facing reminder if the child
  wrote files the parent had already read.
- Background agent completion notifications use the same reminder path.
- The reminder is process-local and only sees structured write paths already
  attached to `noteFileWrite`.

Implemented in Stage 3C:

- Added a process-local path-keyed async mutex in `fileStateRegistry`.
- Added lock primitive tests for same-path serialization, different-path
  overlap, rejection release, and idle cleanup.
- Wrapped `FileEditTool`, `FileWriteTool`, `NotebookEditTool`, and `BashTool`
  `_simulatedSedEdit` around their final stale-check/current-read/write/
  cache-update/`noteFileWrite` critical sections.
- Added FileHarness behavior tests that hold the same-path lock and assert each
  structured write waits before touching disk.

Implemented in HR7:

- `fileStateRegistry` no longer keys sibling writes and path locks by
  `path.normalize` alone.
- Existing path aliases are collapsed with `realpath`.
- New/nonexistent paths under a symlinked parent are collapsed by resolving the
  deepest existing ancestor and rejoining the missing tail.
- Windows registry keys are casefolded; Linux/macOS keys are not lowercased.
- `readFileState` keeps its original logical path keys; registry maintains a
  process-local map from canonical registry key to the logical path this context
  read.
- Tests cover existing symlink aliases, new files under symlink parents,
  Windows-only casefold policy, sibling stale checks across aliases, and path
  mutex serialization across aliases.
- Still not covered by design: hard-link identity, arbitrary shell writes, and
  cross-process registry/locking.

Implemented in HR8:

- `withFileStatePathLock` uses `AsyncLocalStorage` to track canonical path locks
  already held by the current async execution chain.
- A nested acquire of the same canonical path throws immediately, avoiding
  self-deadlock.
- A focused registry test verifies same-path reentry rejects and the lock queue
  remains usable afterwards.
- Different async tasks still serialize through the existing path queue.

Decided boundaries:

- Stage 3D cross-process registry/locking is not planned now. Pane/tmux
  teammates and separate CLI processes remain outside the in-process registry;
  mtime/content checks and checkpoint/rewind are the cross-session backstop.
- Stage 3E broader shell-write participation is also closed for now. Arbitrary
  PowerShell/Bash writes remain intentionally out of scope.

Risks:

- Current registry sees `FileReadTool`, `FileEditTool`, `FileWriteTool`,
  `NotebookEditTool`, and `BashTool`'s `_simulatedSedEdit`.
- This is enough for the current file tool guard, but not a complete Hermes
  equivalent.
- It only covers in-process teammates. Pane/tmux teammates are separate CLI
  processes and do not share the module-level registry.
- The new per-path mutex only serializes structured writes in this process.
  It does not cover pane/tmux teammates, separate CLI processes, future Worker
  tool runners, external editors, or arbitrary shell writes.
- `cloneFileStateCache` currently clones LRU entries shallowly. Real write
  tools replace their own cache entry before `noteFileWrite`, so current guard
  and reminder tests are safe. A future stage can still deep-clone file state
  entries if another path mutates entries in place.
- Hermes does not try to parse arbitrary `terminal` shell writes into its
  `FileStateRegistry`. Its terminal prompt tells agents not to use `sed`/`awk`
  for edits or `echo`/heredoc for file creation, and to use `patch` or
  `write_file` instead. Registry hooks attach to `read_file`, `write_file`,
  and `patch`; checkpointing is a heavier safety layer around destructive tool
  calls, not a lightweight path-level stale-write signal.
- Axiomate should not try to recognize every PowerShell/Bash file write. For
  shell commands, only explicitly parsed, path-specific simulated edits should
  be considered for registry participation.

Runtime lock boundary as of 2026-05-31:

- Bun supports `Worker`. Official docs describe Workers as a new JavaScript
  instance running on a separate thread while sharing I/O resources with the
  main thread. A local Bun 1.3.14 probe also showed `Worker` exists and
  `Bun.isMainThread` is false inside a worker.
- Bun 1.3.14 in this repo environment does not expose `navigator.locks`; the
  local probe returned `navigator.locks` as missing. Do not base Stage 3C on
  Web Locks / `LockManager`.
- `rg` found no `new Worker`, `worker_threads`, `SharedArrayBuffer`, or
  `Atomics` usage in `agent/src`. Current in-process teammates use
  `AsyncLocalStorage` in one JS process, so a module-level registry/lock is
  visible to them.
- If a future tool runner moves file tools into Workers, module-level `Map`
  state will not be shared. The same is true for pane/tmux teammates because
  they spawn separate CLI processes.
- Therefore Stage 3C implemented a small in-process async per-path mutex for
  current same-process structured writes. Cross-worker or cross-process safety
  is intentionally not implemented now because mtime/content stale checks and
  checkpoint/rewind cover the common practical risk without a new live
  coordination protocol.

Stage 3C locking decision:

- Implemented a small process-local, path-keyed async mutex. This mirrors
  existing Axiomate Promise-based serialization patterns such as pane creation
  locks and MCP state update chaining, but uses one queue per normalized file
  path instead of one global queue.
- Scope the lock to the structured write critical section only:
  stale/read-before-write checks, current disk read, write, `readFileState`
  update, and `noteFileWrite`.
- Keep slower or unrelated work outside the lock: permission checks, skill
  discovery/loading, parent directory creation, diagnostic pre-hooks, and LSP
  notifications.
- Same path must serialize; different paths should remain concurrent.
- Do not use `proper-lockfile` in Stage 3C. Existing mailbox/tasks/history
  lockfile usage is for cross-process shared files; Stage 3C is deliberately a
  lighter same-process harness lock.
- Do not use `navigator.locks`. Current Bun does not expose it.
- Do not claim cross-process safety. Pane/tmux teammates, another CLI process,
  arbitrary shell writes, and future Worker-based tool runners remain outside
  this lock.
- Re-check stale state inside the lock. Validation remains a preflight only;
  waiting behind another writer can make an earlier validation result stale.

Stage 3E candidate:

- The one current candidate is `BashTool`'s internal `_simulatedSedEdit` path:
  permission UI precomputes a specific `filePath` and `newContent`, then
  `BashTool` applies that content directly instead of executing `sed`. That is
  a structured file write, unlike arbitrary shell redirection or PowerShell
  `Set-Content`, so it can safely call `noteFileWrite` after success.

Estimated remaining work:

- Cross-process registry/detection: no implementation planned.
- Additional Bash write participation: no broader implementation planned
  without a future structured path+content signal.

### Stage 4: Atomic Write Semantics

Status: Stage 4A complete.

Hermes invariant:

- Failed writes should not leave half-written files.
- Temp files should be same-directory and cleaned.
- Existing file mode should be preserved.

Previous Axiomate baseline:

- `writeFileSyncAndFlush_DEPRECATED` attempts temp+rename.
- If atomic write fails, it falls back to non-atomic direct write.

Stage 4A / HR2 decision:

- Structured file tools do not use the non-atomic fallback. A failed temp
  write, chmod, or rename cleans the temp file and throws `atomic_write_failed`
  instead of directly overwriting the target path.
- Config/settings writes are explicit opt-in exceptions. They may fall back to
  direct write only after the temp file has already been written/flushed and
  the failure is a rename-stage lock-style errno (`EPERM`, `EACCES`, `EBUSY`).
- Rationale: Hermes' atomic write invariant remains the right default for user
  files, but config/settings are small application-owned JSON files where
  rename-lock fallback is a useful reliability harness. The fallback is not
  allowed for temp-write, flush, chmod, or non-lock rename failures.

Local tests added:

- `agent/src/__tests__/unit/utils/file.test.ts` simulates `renameSync` failure
  for existing and new files.
- The tests assert the original target remains intact, no new target is
  created, temp files are cleaned, and the atomic error is rethrown.
- The tests also assert opt-in fallback succeeds for rename lock errors and
  does not run for non-lock rename errors.
- `agent/src/__tests__/unit/utils/settingsWriteFallback.test.ts` pins
  settings-level opt-in fallback and verifies failed settings writes do not
  leave an internal-write watcher mark.

Remaining follow-up:

- Classify atomic write failures into a model-facing error category during
  Stage 6.

### Stage 5: BOM and Line Ending Policy

Status: complete locally.

Implemented decisions:

- `FileWriteTool` is full semantic replacement. New files use the project
  default envelope: UTF-8, LF, no leading BOM.
- `FileWriteTool` overwrites preserve the existing file envelope: original
  encoding, leading BOM, and detected majority line-ending style.
- `FileEditTool` preserves existing text format for precise edits:
  original encoding, leading BOM, and detected majority line-ending style.
- `NotebookEditTool` uses the same preservation policy as `FileEditTool`.
- `BashTool`'s structured `_simulatedSedEdit` path uses the same preservation
  policy because it is an exact-content edit, not arbitrary shell output.
- New files are UTF-8, LF, no leading BOM.
- Line-ending detection is majority-based: CRLF only wins when CRLF count is
  greater than LF count; ties, no newlines, and LF-majority files use LF.

Implementation details:

- `readFileSyncWithMetadata` strips a leading BOM from returned `content`,
  normalizes CRLF/lone CR to LF, and returns `hadLeadingBom` separately.
- `writeTextContent` normalizes incoming content to LF first, then expands to
  CRLF only when the caller asks to preserve CRLF.
- `FileWriteTool` calls `normalizeContentToLf`; new files write UTF-8/LF, while
  overwrites pass the original file metadata to `writeTextContent`.
- `FileEditTool`, `NotebookEditTool`, and simulated sed pass
  `preserveLeadingBom` when the original file had a leading BOM.
- `readNotebook` strips BOM before parsing so BOM-prefixed notebooks are
  readable and can round-trip through `NotebookEditTool`.

Tests added:

- Metadata read tests for majority line-ending detection and BOM metadata.
- `FileWriteTool` tests for canonical new writes and overwrite preservation of
  CRLF, UTF-8 BOM, UTF-16LE BOM, majority CRLF, and mixed-tie LF.
- `FileEditTool` tests for CRLF, mixed-majority CRLF, tied-mixed LF, UTF-8 BOM
  preservation, UTF-16LE BOM preservation, and BOM mtime-only stale fallback.
- `NotebookEditTool` and structured simulated sed tests for BOM preservation.

Estimated work:

- Complete after verification and push.

### Stage 6: Failure Taxonomy

Status: Stage 6A and Stage 6B complete. `encoding_unsupported` remains a
reserved taxonomy reason only; it is not enforced in current behavior.

Hermes has more explicit failure categories and model-facing escalation paths.
Axiomate currently mixes validation `errorCode`s with thrown generic errors such
as `FILE_UNEXPECTEDLY_MODIFIED_ERROR`.

Stage 6A decision:

- Do not replace existing `validateInput` error codes yet.
- Do not change tool result text or thrown error text yet.
- Introduce an internal catalog in
  `agent/src/utils/fileHarnessFailures.ts`.
- Treat the catalog as a stable naming/coverage matrix for tests, logging, and
  future UI/error wrappers.
- Separate phases:
  - `validation`: preflight checks that can become stale before execution.
  - `execution`: final checks inside the path lock.
  - `helper`: shared lower-level helpers such as atomic writes.

Catalog reasons:

- `not_read`
- `partial_read_for_write`
- `stale_mtime`
- `stale_content`
- `sibling_write_after_read`
- `string_not_found`
- `multiple_match`
- `permission_denied`
- `atomic_write_failed`
- `encoding_unsupported`

Current Stage 6A mapping:

- `not_read`: current FileEdit/FileWrite/Notebook validation codes and final
  `FILE_UNEXPECTEDLY_MODIFIED_ERROR` branches.
- `partial_read_for_write`: current FileWrite partial-view guard.
- `stale_mtime`: current mtime drift branches.
- `stale_content`: current mtime+content mismatch branch.
- `sibling_write_after_read`: current `fileStateRegistry` sibling-write guard.
- `string_not_found`: current FileEdit errorCode 8.
- `multiple_match`: current FileEdit errorCode 9.
- `permission_denied`: current file permission deny validation branches.
- `atomic_write_failed`: atomic helper throws `FileHarnessError` with original
  filesystem error as `cause`.
- `encoding_unsupported`: reserved only; current helpers explicitly detect
  UTF-8 and UTF-16LE but `Edit` keeps existing best-effort behavior for other
  encodings instead of rejecting.

Stage 6B options:

- Done: add reason metadata to validation results without changing message text
  or error codes.
- Done: add a typed error wrapper that carries `reason`, `phase`, `path`, and
  optional original `cause`.
- Done: map execution-time stale failures to distinct reasons at their branch
  sites.
- Done: wrap atomic helper failures with `atomic_write_failed` while preserving
  errno `code`, original message, and original `cause`.
- Decided: unsupported/unknown encodings are not rejected for now. The catalog
  keeps `encoding_unsupported` for future optional strict-mode work.

Estimated work:

- Stage 6A: complete.
- Stage 6B: complete. UI/error rendering changes remain optional follow-ups.

### Stage 7: Patch/Edit Failure Escalation

Status: Stage 7A and 7B complete.

Hermes tracks repeated patch failures and escalates guidance after repeated
old-string mismatches.

Previous Axiomate baseline:

- `FileEditTool` reports string-not-found and multiple-match.
- It did not maintain per-file repeated failure escalation comparable to Hermes.

Implemented in Stage 7A:

- Added a process-local `WeakMap` tracker keyed by `readFileState`.
- Tracks repeated `FileEditTool.validateInput` match failures for
  `string_not_found` and `multiple_match`.
- Counts only consecutive failures for the same normalized path, same reason,
  and same read-state object.
- A successful FileEdit validation clears the same-path tracker.
- Validation result `meta.fileEditFailureEscalation` carries
  `reason/path/count/level`.
- `toolExecution` appends model-facing guidance when escalation level reaches
  `reread` or `stop`.
- The original validation message and errorCode remain unchanged.

Implemented in Stage 7B:

- Added telemetry for the same repeated match-failure tracker.
- Event name: `file_edit_failure_escalation`.
- Properties: `reason`, `count`, `level`, and optional `file_extension`.
- Full paths are intentionally excluded to avoid sensitive or high-cardinality
  telemetry.
- This is observability only. It does not add fuzzy matching, automatic patch
  guessing, or UI rendering changes.

Recommended direction:

- Keep Stage 7A's tracker conservative and per-session/process-local.
- Expand only after observing whether the new guidance breaks old-string loops.
- Do not import Hermes fuzzy patch matching wholesale yet.

Estimated work:

- Stage 7A and 7B complete.
- 0.5-2 days remains only if we add richer recovery policy or UI rendering;
  more if we add fuzzy patch matching. That work is deferred until telemetry
  shows repeated edit-match failures are still a meaningful problem.

### Stage 8: Read Dedup Loop Guard

Status: complete for the Hermes-style loop-guidance slice.

Done:

- Repeated unchanged reads can return a stub.
- Write refuses to write that stub.
- Read dedup is disabled after sibling writes so a requested re-read can recover
  real content.
- Repeated unchanged stubs now track same path, same read-state object, same
  offset, and same limit.
- First unchanged stub is quiet.
- Second repeated unchanged stub adds guidance to reuse the earlier Read result.
- Third and later repeated unchanged stubs add STOP-level guidance and suggest
  reading a different offset/range only if new context is needed.
- Full real text/notebook reads clear the same-path dedup tracker.

Estimated work:

- Complete for current scope.

## Decision Log

1. Do not port Hermes Python tool stack wholesale.
   - Axiomate keeps TypeScript `FileReadTool`, `FileEditTool`, and
     `FileWriteTool`.

2. Use tests first.
   - Every behavior change in this migration should start with a failing
     FileHarness or utility test.

3. `Write` requires full-file context for existing files.
   - Because `Write` is full-file replacement.
   - Partial read state is not enough.

4. `Edit` may proceed after partial read if the file has not changed.
   - Because `Edit` reads current disk content and applies a precise
     replacement.
   - This avoids wasting tokens on large files for small edits.

5. Full-read mtime drift can use content fallback.
   - If content is unchanged, mtime-only drift should not block edits.
   - This reduces false positives from filesystem timestamp churn.

6. Partial-read stale drift stays rejected.
   - Partial content cannot prove unchanged full-file content.

7. Internal read-dedup status text must not become file content.
   - Exact and short-wrapper `FILE_UNCHANGED_STUB` writes are rejected.

8. Process-local registry state must not persist.
   - `registrySequence` is stripped by `cacheToObject`.
   - It is preserved by clone only for live subagent ordering.
   - Because it does not persist, reads rebuilt across a boundary arrive without
     it. Those unstamped reads make the sibling-write check abstain rather than
     reject (decision #25), so non-persistence is safe by design.

9. Cross-context registry supplements, not replaces, `readFileState`.
   - `readFileState` still handles same-context read-before-write.
   - Registry handles sibling/subagent writes after a context's last read.

10. The current registry is process-local, not cross-process.
    - In-process teammates share it.
    - Pane/tmux teammates and separate CLI processes do not.
    - Current decision: do not add cross-process registry/locking. Use
      mtime/content stale checks before writes and checkpoint/rewind after
      writes as the cross-session safety layer.

11. Registry stale detection and write serialization are separate layers.
    - The registry detects sibling/subagent writes after a context's last read.
    - Stage 3C added a process-local per-path mutex that serializes structured
      write critical sections in the current JS process.
    - The mutex does not cover pane/tmux teammates, separate CLI processes,
      Workers, external editors, or arbitrary shell writes.

12. Do not rely on Bun Web Locks for Stage 3C.
    - Local Bun 1.3.14 exposes `Worker` but not `navigator.locks`.
    - Current Axiomate tool execution does not use Workers, so an in-process
      per-path async mutex is enough for same-process structured writes.
    - If tools move into Workers or pane/tmux CLI processes, module globals are
      not shared; this is accepted for now rather than adding IPC/file-backed
      coordination.

13. Stage 3C uses a path-keyed in-process mutex, not a global write lock.
    - Same normalized path serializes.
    - Different paths remain concurrent.
    - The lock is for structured write critical sections only.
    - Validation is still preflight; final stale checks must run inside the
      lock.

14. Do not parse arbitrary shell writes into the registry.
    - Hermes does not do this either.
    - Axiomate should only attach registry hooks to structured write paths
      where the tool already knows the exact path and content.

15. Atomic write failure does not fall back to direct target writes for
    structured file tools.
    - `writeFileSyncAndFlush_DEPRECATED` cleans its temp file and throws
      `FileHarnessError` with the original atomic error as `cause`.
    - The wrapper preserves the original error message and errno `code`.
    - Config/settings explicitly opt into a constrained rename-lock fallback;
      this is application config reliability, not user-file harness behavior.
    - This matches Hermes' "target unchanged unless rename succeeds" invariant.

16. `Write` canonicalizes semantic content; overwrites preserve envelope.
    - `FileWriteTool` writes new files as UTF-8, LF, no leading BOM.
    - `FileWriteTool` overwrites preserve existing encoding, leading BOM, and
      majority line-ending style.
    - `FileEditTool`, `NotebookEditTool`, and structured simulated sed also
      preserve existing encoding, leading BOM, and majority line-ending style.
    - Majority line-ending detection defaults to LF on ties or no line breaks.
    - Resume reconstruction follows the same semantic policy: historical
      `Write` input is canonicalized as semantic content only, while historical
      `Edit` is replayed against full-known transcript content rather than
      current disk.
    - `toolNormalization` is recorded only when format correction actually
      happened and remains runtime/reconstructable metadata, not JSONL history.

17. File-harness typed failures are additive metadata for now.
    - Validation result `message` and `errorCode` stay unchanged.
    - Execution-time thrown `.message` stays
      `FILE_UNEXPECTEDLY_MODIFIED_ERROR`.
    - New callers can inspect `error.fileHarnessFailure` without changing
      model-facing tool text.

18. Notebook execution stale-content classification uses the cell-view fallback.
    - `FileWriteTool` and `FileEditTool` can report `stale_content` when their
      final critical section compares cached full content to current content.
    - `NotebookEditTool` now compares the current FileReadTool notebook cell
      view to the cached full read state after mtime drift.
    - Full-read mtime-only drift can proceed; partial-read drift still rejects.
    - Execution safety failures still throw inside the tool, but the tool runner
      catches them and surfaces an `is_error` tool result.

19. Unsupported encoding is reserved but not enforced.
    - The catalog keeps `encoding_unsupported` so future code has a stable
      reason name.
    - Current helpers still explicitly handle UTF-8 and UTF-16LE only.
    - `Edit` keeps current best-effort behavior for unsupported/unknown
      encodings for compatibility.
    - Adding rejection for other encodings would be a future strict-mode
      behavior change, not part of the current harness scope.

20. Stage 7A tracks repeated edit-match failures by read snapshot.
    - Repeated `string_not_found` or `multiple_match` failures count only while
      path, reason, and cached read-state object stay the same.
    - A successful FileEdit validation clears the same-path tracker.
    - The first failure stays quiet; the second asks for a reread; the third
      adds a STOP-level warning.
    - This does not add fuzzy matching or automatic patch guessing.

21. Stage 7B telemetry must avoid full paths.
    - File paths can be sensitive and high-cardinality.
    - Edit escalation telemetry records only reason, count, level, and file
      extension.
    - Telemetry is used to decide whether richer recovery policy is worth the
      product risk.

22. Bash `_simulatedSedEdit` is a structured harness writer.
    - The scope is only the internal permission-preview path where BashTool
      applies the previewed sed edit directly.
    - It must have current read state before writing.
    - It rejects sibling writes after read.
    - It rejects mtime/content stale changes, using full-read content fallback
      like `FileEditTool`.
    - Arbitrary Bash and PowerShell writes remain outside registry/lock/stale
      parsing.

23. Stage 8 read-dedup guidance escalates only after repeated stubs.
    - The first `file_unchanged` stub remains quiet to preserve existing dedup
      behavior.
    - The second same-path/same-range/same-read-state stub adds a reuse hint.
    - The third and later stubs add STOP-level guidance.
    - A real text/notebook Read clears the path's dedup tracker, so legitimate
      rereads after a content change are not punished.

24. Cross-process registry is intentionally not implemented.
    - Checkpoint is already cross-session, but it is a recovery/audit layer,
      not a live read/write registry.
    - mtime/content checks catch most practical cross-process stale writes
      before structured file tools write.
    - Checkpoint/rewind handles recovery after a bad write lands.
    - A file-backed registry, SQLite state, IPC, or lockfile protocol would add
      crash cleanup, stale lock, path normalization, and performance concerns
      without current evidence that the extra complexity is justified.

25. An unstamped read makes the registry abstain, not reject (2026-06-09).
    - `registrySequence` is process-local and unreconstructable from the
      transcript. A read state without it (reconstructed, SDK-seeded, or
      injected across a boundary) has unknowable logical order.
    - The sibling-write check must return false (abstain) for such reads and let
      the mtime/content gate decide. Treating a missing stamp as stale caused
      the bulk of the post-5/31 false write rejections.
    - To keep the narrow sibling-write-plus-restored-mtime case covered, an
      unstamped full read forces a content comparison even when mtime did not
      advance (`shouldForceContentStaleCheck`). Content equality is the
      authority; the registry only adds ordering when it has a live stamp.
    - This deliberately accepts the same downgrade as decisions #10/#24 at the
      compact/resume boundary: detection falls back to content/mtime, which is
      the reliable signal, plus checkpoint/rewind as backstop.

## Remaining Work

There is no remaining core Hermes file-harness port planned. Remaining work is
observability, privacy audit, and product polish:

0. Telemetry/privacy audit before UI/statistics expansion.
   - Verify file-harness metadata paths are not exported through analytics or
     debug surfaces unexpectedly.
   - Keep existing edit-escalation telemetry low sensitivity: reason/count/
     level/file extension only.

1. UI surfacing for file-harness failures.
   - Decide whether validation/execution `fileHarnessFailure` metadata should
     appear in tool error UI, `/doctor`, or recovery traces.
   - Keep model-facing text stable unless there is evidence that additional
     UI text improves recovery.

2. Telemetry and dashboard follow-up.
   - Use `file_edit_failure_escalation` telemetry to measure repeated
     `string_not_found` / `multiple_match` loops.
   - Add aggregate counters for stale guards, partial-read write rejects,
     read-dedup STOP hits, and atomic write failures only if product or
     debugging needs justify them.
   - Continue avoiding full paths and code content in telemetry.

3. Optional edit recovery after telemetry.
   - Consider stronger UI/model guidance only if repeated edit-match failures
     remain common after Stage 7A/7B.
   - Do not add fuzzy patch matching until data shows the conservative
     reread/STOP guidance is insufficient.

4. Regression maintenance.
   - Keep FileHarness focused tests under `--no-file-parallelism` when running
     narrow slices because import mocks can be flaky in parallel file mode.
   - Add tests for any future structured shell path only if that tool knows
     exact path and final content before writing.

Focused verification note:

- Use `--no-file-parallelism` for focused FileHarness slices because the
   existing FileHarness import mocks can be flaky when several files import
   tool modules concurrently.
