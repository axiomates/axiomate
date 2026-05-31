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
- `b713951a feat: extend file registry coverage`
- `b8acd2a2 feat: add subagent file state reminders`
- `2c9d7553 feat: serialize file harness writes by path`

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

## Remaining Migration Work

## Current Position

Stage 6B is complete. Validation metadata, execution-time typed stale failures,
and shared atomic helper failure wrapping are implemented.

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
  `sibling_write_after_read`, and `stale_mtime`. It does not claim
  `stale_content` because the final notebook write path does not currently run
  a content fallback.
- `writeFileSyncAndFlush_DEPRECATED` now wraps atomic write failures in
  `FileHarnessError` with `reason: atomic_write_failed`, `phase: helper`,
  `path`, errno `code`, and original filesystem error in `cause`.

Next implementation target:

- Move to Stage 7 patch/edit failure escalation, or take a separate encoding
  policy slice for `encoding_unsupported`.

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

Still to decide and implement:

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
  is a separate Stage 3D design requiring IPC, a file-backed registry, SQLite,
  lockfiles, or checkpoint-based dirty detection.

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
  this lock and belong to Stage 3D.
- Re-check stale state inside the lock. Validation remains a preflight only;
  waiting behind another writer can make an earlier validation result stale.

Stage 3E candidate:

- The one current candidate is `BashTool`'s internal `_simulatedSedEdit` path:
  permission UI precomputes a specific `filePath` and `newContent`, then
  `BashTool` applies that content directly instead of executing `sed`. That is
  a structured file write, unlike arbitrary shell redirection or PowerShell
  `Set-Content`, so it can safely call `noteFileWrite` after success.

Estimated remaining work:

- Cross-process registry/detection decision: 0.5-1 day for design; more if
  implemented.
- Additional Bash write participation: research item; likely no broader
  coverage without shell instrumentation.

### Stage 4: Atomic Write Semantics

Status: Stage 4A complete.

Hermes invariant:

- Failed writes should not leave half-written files.
- Temp files should be same-directory and cleaned.
- Existing file mode should be preserved.

Previous Axiomate baseline:

- `writeFileSyncAndFlush_DEPRECATED` attempts temp+rename.
- If atomic write fails, it falls back to non-atomic direct write.

Stage 4A decision:

- Remove the non-atomic fallback from the shared helper. A failed temp write,
  chmod, or rename now cleans the temp file and rethrows the original atomic
  error instead of directly overwriting the target path.
- This applies to all current callers of `writeFileSyncAndFlush_DEPRECATED`,
  including file tools, settings, and config writes.
- Rationale: Hermes' atomic write invariant is stronger and easier to reason
  about. Direct fallback can turn an atomic rename failure into a partial or
  non-atomic target overwrite.

Local tests added:

- `agent/src/__tests__/unit/utils/file.test.ts` simulates `renameSync` failure
  for existing and new files.
- The tests assert the original target remains intact, no new target is
  created, temp files are cleaned, and the atomic error is rethrown.

Remaining follow-up:

- Classify atomic write failures into a model-facing error category during
  Stage 6.

### Stage 5: BOM and Line Ending Policy

Status: complete locally.

Implemented decisions:

- `FileWriteTool` is full replacement and writes canonical text:
  UTF-8, LF, no leading BOM. It does not preserve overwritten files'
  encoding, BOM, CRLF, or mixed line endings.
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
- `FileWriteTool` calls `normalizeContentToLf` and writes with UTF-8/LF.
- `FileEditTool`, `NotebookEditTool`, and simulated sed pass
  `preserveLeadingBom` when the original file had a leading BOM.
- `readNotebook` strips BOM before parsing so BOM-prefixed notebooks are
  readable and can round-trip through `NotebookEditTool`.

Tests added:

- Metadata read tests for majority line-ending detection and BOM metadata.
- `FileWriteTool` tests for canonical new/overwrite writes, existing BOM
  removal, CRLF normalization, and UTF-16LE replacement to UTF-8.
- `FileEditTool` tests for CRLF, mixed-majority CRLF, tied-mixed LF, BOM
  preservation, and BOM mtime-only stale fallback.
- `NotebookEditTool` and structured simulated sed tests for BOM preservation.

Estimated work:

- Complete after verification and push.

### Stage 6: Failure Taxonomy

Status: Stage 6A and Stage 6B complete. `encoding_unsupported` remains a
planned future encoding-policy slice, not unfinished Stage 6B work.

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
- `encoding_unsupported`: planned only; current helpers explicitly detect
  UTF-8 and UTF-16LE but do not have a dedicated unsupported-encoding failure.

Stage 6B options:

- Done: add reason metadata to validation results without changing message text
  or error codes.
- Done: add a typed error wrapper that carries `reason`, `phase`, `path`, and
  optional original `cause`.
- Done: map execution-time stale failures to distinct reasons at their branch
  sites.
- Done: wrap atomic helper failures with `atomic_write_failed` while preserving
  errno `code`, original message, and original `cause`.
- Deferred: decide whether unsupported encodings should be rejected or left as
  best-effort UTF-8/UTF-16LE decoding.

Estimated work:

- Stage 6A: complete.
- Stage 6B: complete. UI/error rendering changes and unsupported-encoding
  policy remain separate optional follow-ups.

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
      not shared and Stage 3D needs IPC/file-backed coordination.

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

15. Atomic write failure does not fall back to direct target writes.
    - `writeFileSyncAndFlush_DEPRECATED` cleans its temp file and throws
      `FileHarnessError` with the original atomic error as `cause`.
    - The wrapper preserves the original error message and errno `code`.
    - The stricter behavior applies to all current callers of the shared
      helper, not only file tools.
    - This matches Hermes' "target unchanged unless rename succeeds" invariant.

16. `Write` canonicalizes; precise edit paths preserve.
    - `FileWriteTool` writes UTF-8, LF, no leading BOM for both new files and
      overwrites.
    - `FileEditTool`, `NotebookEditTool`, and structured simulated sed preserve
      existing encoding, leading BOM, and majority line-ending style.
    - Majority line-ending detection defaults to LF on ties or no line breaks.

17. File-harness typed failures are additive metadata for now.
    - Validation result `message` and `errorCode` stay unchanged.
    - Execution-time thrown `.message` stays
      `FILE_UNEXPECTEDLY_MODIFIED_ERROR`.
    - New callers can inspect `error.fileHarnessFailure` without changing
      model-facing tool text.

18. Notebook execution stale-content classification waits for a real fallback.
    - `FileWriteTool` and `FileEditTool` can report `stale_content` when their
      final critical section compares cached full content to current content.
    - `NotebookEditTool` currently checks mtime before reading/parsing the
      notebook in `call()`, so execution-time mtime drift remains
      `stale_mtime`.

19. Unsupported encoding is a policy decision, not Stage 6B cleanup.
    - The catalog keeps `encoding_unsupported` so future code has a stable
      reason name.
    - Current helpers still explicitly handle UTF-8 and UTF-16LE only.
    - Adding rejection for other encodings would be a behavior change and needs
      its own tests/decision.

## Open Questions

1. Should registry warnings be hard errors everywhere, or should some agent
   contexts receive warnings/reminders instead?
2. How much can Bash writes realistically participate without shell-level file
   monitoring?
3. Should pane/tmux teammates get a cross-process registry, or is
   checkpoint/mtime/content detection enough?
4. Should `FileStateCache` entries be deep-cloned, or is the current
   replace-entry write pattern enough?
5. Should UTF-16BE or other non-UTF8/non-UTF16LE encodings be detected or
   rejected explicitly?

## Recommended Next Slice

The immediate next slice is Stage 7 patch/edit failure escalation, unless
encoding policy is more urgent.

Focused verification note:

- Use `--no-file-parallelism` for focused FileHarness slices because the
   existing FileHarness import mocks can be flaky when several files import
   tool modules concurrently.
