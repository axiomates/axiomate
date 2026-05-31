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
`agent/src/__tests__/unit/tools/FileHarness/`. The current local branch adds or
modifies about 1k lines around FileHarness tests and file guard logic, plus a
small 70-line in-process registry. The already-pushed stage 1 commit was:

- `c8f6b352 test: add file harness coverage`

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

Status: implemented locally, not committed.

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

Status: implemented locally, not committed.

Implemented decisions:

- `FileWriteTool` rejects exact `FILE_UNCHANGED_STUB` content.
- It also rejects short wrapper text around that stub.
- It allows normal larger documents that quote the stub as documentation.

Why:

- Hermes blocks internal read-dedup status text from being written back into
  real files.
- Axiomate's equivalent status is `FILE_UNCHANGED_STUB`.

### Stage 2C: Minimal Cross-Context File State Registry

Status: implemented locally, not committed.

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
- It does not solve external editors or separate OS processes. Those remain
  covered by mtime/content stale checks.

## Current Local Verification

The current local uncommitted implementation has passed:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness --hookTimeout 120000`
- `pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/fileStateCache.test.ts --hookTimeout 120000`
- `pnpm run build:types`
- `git diff --check`
- `pnpm run test` with 149 files / 2098 tests passing

## Remaining Migration Work

### Stage 3: Complete Registry Coverage

Status: not started.

Need to decide and implement:

- Whether `NotebookEditTool` should call `noteFileWrite`.
- Whether Bash-driven file writes can or should participate. Axiomate currently
  has simulated sed edit tracking, but arbitrary shell writes cannot be fully
  observed without shell instrumentation.
- Whether AgentTool/subagent completion should surface a Hermes-like reminder:
  "subagent modified files the parent previously read."
- Whether to add per-path locks around `Edit`/`Write` critical sections.

Risks:

- Current registry only sees `FileReadTool`, `FileEditTool`, and
  `FileWriteTool`.
- This is enough for the current file tool guard, but not a complete Hermes
  equivalent.

Estimated remaining work:

- Narrow registry coverage for `NotebookEditTool`: 0.5-1 day.
- Parent/subagent completion reminder: 1-2 days.
- Per-path lock design and non-flaky tests: 1-2 days.
- Bash write participation: research item; likely partial coverage only.

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

## Open Questions

1. Should registry warnings be hard errors everywhere, or should some agent
   contexts receive warnings/reminders instead?
2. Should `NotebookEditTool` be brought into the same registry immediately?
3. How much can Bash writes realistically participate without shell-level file
   monitoring?
4. Should non-atomic fallback be removed globally, or only for FileEdit/FileWrite?
5. What is the final UTF-8 BOM policy for read/edit/write?
6. Should `FileWriteTool` keep LF full replacement policy for existing CRLF
   files?

## Recommended Next Slice

The safest next implementation slice is Stage 3, narrowed to official Axiomate
write tools:

1. Add tests showing `NotebookEditTool` writes are visible to the registry.
2. Add `noteFileWrite` to `NotebookEditTool` successful write path.
3. Audit BashTool's simulated sed edit path and decide whether it should call
   `noteFileWrite`.
4. Do not attempt broad shell write detection yet.

After that, move to Stage 4 atomic write semantics, because it is the largest
remaining reliability invariant from Hermes.
