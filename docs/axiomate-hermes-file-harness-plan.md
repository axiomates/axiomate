# Axiomate/Hermes File Harness Migration Plan

Status date: 2026-05-31

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
or modifies about 1.2k lines around FileHarness tests, file guard logic, a
small in-process registry, and this plan. The already-pushed commits are:

- `c8f6b352 test: add file harness coverage`
- `1b0bfaa7 feat: extend file harness stale-write guards`

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

## Remaining Migration Work

### Stage 3: Complete Registry Coverage

Status: Stage 3A implemented locally; broader registry coverage remains.

Implemented locally in Stage 3A:

- `NotebookEditTool` checks sibling writes before validation/call writes and
  calls `noteFileWrite` after a successful notebook write.
- `BashTool` calls `noteFileWrite` only for its internal `_simulatedSedEdit`
  path, where the permission UI already supplied an exact `filePath` and
  `newContent`.

Current local files:

- `agent/src/tools/NotebookEditTool/NotebookEditTool.ts`
- `agent/src/tools/BashTool/BashTool.tsx`
- `agent/src/__tests__/unit/tools/FileHarness/notebookEdit.behavior.test.ts`
- `agent/src/__tests__/unit/tools/FileHarness/bashSimulatedSed.behavior.test.ts`
- `agent/src/__tests__/unit/tools/FileHarness/helpers.ts`

Still to decide and implement:

- Stage 3B: AgentTool/subagent completion should surface a Hermes-like
  reminder: "subagent modified files the parent previously read."
- Stage 3C: per-path locks around `Edit`/`Write`/`NotebookEdit` and structured
  simulated writes, so stale-check-plus-write becomes a serialized critical
  section within one process.
- Stage 3D: decide whether cross-process state is worth adding for pane/tmux
  teammates. This likely needs IPC, a file-backed registry, SQLite, or
  checkpoint integration.
- Stage 3E: audit whether any additional structured shell-write paths exist.
  Arbitrary PowerShell/Bash writes remain intentionally out of scope.

Risks:

- Current registry sees `FileReadTool`, `FileEditTool`, `FileWriteTool`,
  `NotebookEditTool`, and `BashTool`'s `_simulatedSedEdit`.
- This is enough for the current file tool guard, but not a complete Hermes
  equivalent.
- It only covers in-process teammates. Pane/tmux teammates are separate CLI
  processes and do not share the module-level registry.
- It does not provide a per-path mutex. Two async structured writes in the same
  process can still interleave between awaits until Stage 3C lands.
- Hermes does not try to parse arbitrary `terminal` shell writes into its
  `FileStateRegistry`. Its terminal prompt tells agents not to use `sed`/`awk`
  for edits or `echo`/heredoc for file creation, and to use `patch` or
  `write_file` instead. Registry hooks attach to `read_file`, `write_file`,
  and `patch`; checkpointing is a heavier safety layer around destructive tool
  calls, not a lightweight path-level stale-write signal.
- Axiomate should not try to recognize every PowerShell/Bash file write. For
  shell commands, only explicitly parsed, path-specific simulated edits should
  be considered for registry participation.
- The one current candidate is `BashTool`'s internal `_simulatedSedEdit` path:
  permission UI precomputes a specific `filePath` and `newContent`, then
  `BashTool` applies that content directly instead of executing `sed`. That is
  a structured file write, unlike arbitrary shell redirection or PowerShell
  `Set-Content`, so it can safely call `noteFileWrite` after success.

Estimated remaining work:

- Commit/verify Stage 3A: 0.5 day.
- Parent/subagent completion reminder: 1-2 days.
- Per-path lock design and non-flaky tests: 1-2 days.
- Cross-process registry/detection decision: 0.5-1 day for design; more if
  implemented.
- Additional Bash write participation: research item; likely no broader
  coverage without shell instrumentation.

### Stage 4: Atomic Write Semantics

Status: not started.

Hermes invariant:

- Failed writes should not leave half-written files.
- Temp files should be same-directory and cleaned.
- Existing file mode should be preserved.

Axiomate baseline:

- `writeFileSyncAndFlush_DEPRECATED` attempts temp+rename.
- If atomic write fails, it falls back to non-atomic direct write.

Decision needed:

- Keep non-atomic fallback for compatibility, or remove/disable it to make
  failure semantics stricter?

Recommended direction:

- Add tests first for atomic failure and temp cleanup.
- Prefer removing the non-atomic fallback for file tools, or at least surface a
  distinct "write state uncertain" error.

Estimated work:

- 1-2 days for tests and helper refactor.

### Stage 5: BOM and Line Ending Policy

Status: partially tested, not fully decided.

Current Axiomate decisions:

- `FileEditTool` preserves existing CRLF line endings.
- `FileWriteTool` treats `content` as full replacement and writes the model's
  explicit line endings, currently through LF policy.
- `readFileSyncWithMetadata` detects encoding and line endings for edit/write
  paths.

Open decisions:

- Should UTF-8 BOM be preserved by edit/write, stripped, or normalized?
- Should `FileWriteTool` preserve old CRLF for existing files, or continue to
  respect replacement content exactly?

Recommended direction:

- Keep `Edit` preserving line endings.
- Keep `Write` as full replacement unless there is a strong product reason to
  preserve old line endings.
- Add explicit BOM tests before changing implementation.

Estimated work:

- 1-2 days depending on BOM policy.

### Stage 6: Failure Taxonomy

Status: not started.

Hermes has more explicit failure categories and model-facing escalation paths.
Axiomate currently mixes validation `errorCode`s with thrown generic errors such
as `FILE_UNEXPECTEDLY_MODIFIED_ERROR`.

Needed categories:

- not-read
- partial-view-insufficient-for-write
- stale-mtime
- stale-content
- sibling-write-after-read
- string-not-found
- multiple-match
- permission-denied
- atomic-write-failed
- encoding-unsupported

Estimated work:

- 2-4 days, depending on UI/tool result integration.

### Stage 7: Patch/Edit Failure Escalation

Status: not started.

Hermes tracks repeated patch failures and escalates guidance after repeated
old-string mismatches.

Axiomate baseline:

- `FileEditTool` reports string-not-found and multiple-match.
- It does not yet maintain per-file repeated failure escalation comparable to
  Hermes.

Recommended direction:

- Add a small per-session failure tracker.
- Escalate after repeated `old_string` failures on the same file.
- Do not import Hermes fuzzy patch matching wholesale yet.

Estimated work:

- 1-3 days.

### Stage 8: Read Dedup Loop Guard

Status: partially implemented.

Done:

- Repeated unchanged reads can return a stub.
- Write refuses to write that stub.
- Read dedup is disabled after sibling writes so a requested re-read can recover
  real content.

Remaining:

- Track repeated `file_unchanged` loops and provide stronger guidance if the
  model keeps asking for the same unchanged range.

Estimated work:

- 0.5-1 day.

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

9. Cross-context registry supplements, not replaces, `readFileState`.
   - `readFileState` still handles same-context read-before-write.
   - Registry handles sibling/subagent writes after a context's last read.

10. The current registry is process-local, not cross-process.
    - In-process teammates share it.
    - Pane/tmux teammates and separate CLI processes do not.
    - Cross-process detection must use mtime/content, checkpoint, IPC, or a
      file-backed registry.

11. The current registry is not a concurrency lock.
    - It detects stale sibling writes.
    - It does not serialize read-modify-write critical sections.
    - Per-path locking is a separate Stage 3C item.

12. Do not parse arbitrary shell writes into the registry.
    - Hermes does not do this either.
    - Axiomate should only attach registry hooks to structured write paths
      where the tool already knows the exact path and content.

## Open Questions

1. Should registry warnings be hard errors everywhere, or should some agent
   contexts receive warnings/reminders instead?
2. How much can Bash writes realistically participate without shell-level file
   monitoring?
3. Should pane/tmux teammates get a cross-process registry, or is
   checkpoint/mtime/content detection enough?
4. Should per-path locks happen immediately after Stage 3A, or after the
   parent/subagent completion reminder?
5. Should non-atomic fallback be removed globally, or only for FileEdit/FileWrite?
6. What is the final UTF-8 BOM policy for read/edit/write?
7. Should `FileWriteTool` keep LF full replacement policy for existing CRLF
   files?

## Recommended Next Slice

The immediate next slice is to finish and land Stage 3A, then move to Stage 3B.

Stage 3A close-out:

1. Re-run the focused FileHarness tests for `NotebookEditTool` and
   `_simulatedSedEdit`.
2. Run `pnpm run build:types`.
3. Run the full `pnpm run test` only after focused tests are stable.
4. Commit the Stage 3A code plus this plan update.

Stage 3B implementation plan:

1. Add a registry API equivalent to Hermes `known_reads()` / `writes_since()`
   for Axiomate contexts.
2. Find the AgentTool/subagent completion path and add a model-facing reminder
   only when a child wrote a file the parent had previously read.
3. Add tests for the parent/subagent completion reminder: child modifies a file
   the parent previously read, and the parent gets the reminder.
4. Keep arbitrary shell writes out of the reminder unless they pass through a
   structured Axiomate write path.
5. Keep the first implementation process-local. Document that pane/tmux
   teammates are not covered until cross-process state is designed.

Stage 3C should add per-path locks, because that is the missing piece behind
the user's thread-safety question. After Stage 3C, move to Stage 4 atomic write
semantics, because it is the largest remaining reliability invariant from
Hermes.
