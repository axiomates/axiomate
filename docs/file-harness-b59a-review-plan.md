# File Harness Review Plan: b59ac433254fb..HEAD

Status date: 2026-06-01

Baseline under review:

- Base: `b59ac433254fb311cada9fa70963045fd772e17b`
- Static review head: `9bc40e1e`
- Static review range: `b59ac433254fb311cada9fa70963045fd772e17b..9bc40e1e`

This document is a serious review plan and static behavior review record for
the file harness work since `b59a`. The original review pass was docs-only.
The 2026-06-01 follow-up implements the first approved fix: transcript/resume
reconstruction for `Write` canonicalization and `Edit` replay.

Review status:

- Static diff and behavior inventory: complete.
- HR1 follow-up implementation: complete and covered by focused unit tests.
- Remaining work: 6 product/engineering decisions plus their approved
  follow-up tests/fixes.

## Review Goal

The goal is to review every behavior change introduced by the file harness
series, not merely confirm that the new tests pass.

For every behavior difference from `b59a`, the review must answer:

- What was the previous Axiomate behavior?
- What is the new behavior?
- Was this an explicit product/engineering decision?
- What compatibility, correctness, race, or robustness risk does it create?
- Which tests pin the behavior?
- Which tests are missing?
- Should the behavior be kept, changed, reverted, or documented as an accepted
  risk?

The review must treat model-facing text changes, failure metadata, registry
semantics, shared helper behavior, subagent behavior, and test-system changes
as part of the review surface.

## Scope Inventory

The `b59a..HEAD` range contains 14 commits:

| Commit | Subject |
| --- | --- |
| `c8f6b352` | `test: add file harness coverage` |
| `1b0bfaa7` | `feat: extend file harness stale-write guards` |
| `b713951a` | `feat: extend file registry coverage` |
| `b8acd2a2` | `feat: add subagent file state reminders` |
| `2c9d7553` | `feat: serialize file harness writes by path` |
| `119af9b9` | `feat: enforce atomic file write failures` |
| `d92d47e4` | `feat: define file harness text format policy` |
| `a1064188` | `test: catalog file harness failure reasons` |
| `35e1c892` | `feat: add file harness validation failure metadata` |
| `8cc0d3a1` | `feat: add file harness execution failure metadata` |
| `6465bf1a` | `feat: wrap atomic write failures with file harness metadata` |
| `476a62c8` | `feat: escalate repeated file edit match failures` |
| `c3115493` | `feat: add file harness read and edit loop signals` |
| `9bc40e1e` | `docs: finalize file harness remaining scope` |

Post-review implementation delta on 2026-06-01:

- `agent/src/utils/queryHelpers.ts`
  - `Write` resume reconstruction canonicalizes historical input and records
    `toolNormalization` only for actual BOM/CR normalization.
  - `Edit` resume reconstruction replays against full-known transcript content
    and no longer reads current disk.
- `agent/src/tools/FileWriteTool/FileWriteTool.ts`
  - live `Write` stores runtime-only `toolNormalization` when the tool actually
    removed a leading BOM or normalized CR/CRLF.
- `agent/src/utils/file.ts`
  - adds `getToolNormalizationForWrite`.
- `agent/src/utils/fileStateCache.ts`
  - omits `toolNormalization` from `cacheToObject`.
- `agent/src/__tests__/unit/utils/queryHelpers.fileStateResume.test.ts`
  - pins canonical Write reconstruction and safe Edit replay behavior.

Changed-file inventory:

- 42 files changed.
- Diff stat: 6,169 insertions, 765 deletions.
- Core tool files:
  - `agent/src/tools/FileReadTool/FileReadTool.ts`
  - `agent/src/tools/FileWriteTool/FileWriteTool.ts`
  - `agent/src/tools/FileEditTool/FileEditTool.ts`
  - `agent/src/tools/NotebookEditTool/NotebookEditTool.ts`
  - `agent/src/tools/BashTool/BashTool.tsx`
- Shared helpers and state:
  - `agent/src/utils/file.ts`
  - `agent/src/utils/fileRead.ts`
  - `agent/src/utils/notebook.ts`
  - `agent/src/utils/fileStateCache.ts`
  - `agent/src/utils/fileStateRegistry.ts`
  - `agent/src/utils/fileHarnessFailures.ts`
  - `agent/src/utils/fileEditFailureEscalation.ts`
  - `agent/src/utils/fileReadDedupEscalation.ts`
- Agent/tool execution surfaces:
  - `agent/src/Tool.ts`
  - `agent/src/services/tools/toolExecution.ts`
  - `agent/src/tools/AgentTool/AgentTool.tsx`
  - `agent/src/tools/AgentTool/agentToolUtils.ts`
  - `agent/src/tools/AgentTool/fileStateReminder.ts`
  - `agent/src/tools/AgentTool/resumeAgent.ts`
- Test surface:
  - `agent/src/__tests__/unit/tools/FileHarness/*`
  - `agent/src/__tests__/unit/tools/AgentTool/fileStateReminder.test.ts`
  - `agent/src/__tests__/unit/services/tools/toolExecutionValidation.test.ts`
  - `agent/src/__tests__/unit/utils/file*.test.ts`
  - `agent/src/__tests__/unit/utils/fileState*.test.ts`
  - selected checkpoint/fileHistory tests
- Documentation:
  - `docs/axiomate-hermes-file-harness-plan.md`
  - `docs/axiomate-hermes-file-harness-report.html`

## Behavior Change List

### B01: Existing-file `Write` now requires a full prior `Read`

Old behavior at `b59a`:

- Existing-file `Write` required a `readFileState` entry.
- It did not have a reliable ordinary range-read marker because normal
  `FileReadTool` range reads did not set `isPartialView`.
- A range `Read` could therefore be treated as sufficient for a full-file
  overwrite in some paths.

New behavior:

- `FileReadTool` marks text reads as partial when `offset !== 1` or
  `limit !== undefined`.
- `FileWriteTool` rejects existing-file overwrite if the recorded read state is
  absent or partial.
- Execution-time `FileWriteTool.call` repeats the same check inside the
  per-path lock.

Decision status:

- Intended and previously approved.
- Rationale: `Write` is full-file replacement and can destroy unseen content.

Current tests:

- `fileWrite.behavior.test.ts`
  - rejects unread existing write
  - rejects range-read overwrite in validation
  - rejects range-read overwrite in `call`
- `failureMetadata.test.ts`
  - classifies partial write as `partial_read_for_write`

Review result:

- Keep behavior.
- Confirmed validation and execution paths both enforce it.

2026-06-01 follow-up:

- Resume/cold-start reconstruction now treats partial read state as
  insufficient only for `Write`, not for `Edit`.
- `Write` reconstruction canonicalizes historical tool input through
  `normalizeContentToLf` so reconstructed `readFileState.content` matches the
  semantic content written by the tool.
- If historical `Write` input actually needed BOM removal or CR/CRLF
  normalization, reconstructed state records runtime-only `toolNormalization`.
- `toolNormalization` is not persisted by `cacheToObject`; it is reconstructable
  metadata and does not alter JSONL history or model transcript content.

### B02: `Write` canonicalizes all output to UTF-8, LF, no BOM

Old behavior at `b59a`:

- `FileWriteTool` wrote the supplied content through `writeTextContent`.
- `readFileState` and tool output used the original `content` input.
- `writeTextContent` normalized CRLF for CRLF-preserving writes, but did not
  globally strip BOM or lone CR.

New behavior:

- `FileWriteTool` computes `canonicalContent = normalizeContentToLf(content)`.
- Existing and new files are written as UTF-8, LF, no BOM.
- Tool output `content`, `structuredPatch`, `originalFile`, `readFileState`,
  and LSP change notification use the canonical content.

Decision status:

- Intended and previously approved.
- Rationale: `Write` is full replacement, not format-preserving edit.

Current tests:

- `fileWrite.behavior.test.ts`
  - canonicalizes new writes to LF/no BOM
  - canonicalizes overwrite of CRLF file
  - canonicalizes overwrite of UTF-8 BOM file
  - canonicalizes overwrite of UTF-16LE file to UTF-8

Review result:

- Keep behavior; HR1 follow-up fixed the resume/cold-start reconstruction gap.
- This changes both disk bytes and model-visible tool output for CRLF, BOM, and
  lone-CR input.

2026-06-01 follow-up:

- `queryHelpers.ts` transcript reconstruction for successful `Write` now stores
  canonical content, not raw tool input.
- It records `toolNormalization` only when a leading UTF-8 BOM was removed or
  CR/CRLF line endings were normalized. Standard LF/no-BOM writes do not get an
  extra marker.
- The transcript itself is not rewritten. This avoids KV-cache-sensitive
  history mutation while preserving the fact that the structured tool normalized
  content.

Current additional tests:

- `queryHelpers.fileStateResume.test.ts`
  - reconstructs `Write` state from canonical tool semantics
  - records format normalization only as runtime metadata
- `fileStateCache.test.ts`
  - omits `toolNormalization` from persisted cache output
- `fileWrite.behavior.test.ts`
  - records live `toolNormalization` for BOM/CRLF normalization

### B03: `Edit` allows partial-read precise edits

Old behavior at `b59a`:

- `FileEditTool` rejected `readTimestamp.isPartialView`, but ordinary range
  `Read` did not mark `isPartialView`; therefore range-read `Edit` was
  practically allowed in normal cases.
- The stale check relied on mtime and full-content fallback only when the read
  state was considered full.

New behavior:

- `FileReadTool` does mark range reads partial.
- `FileEditTool` no longer treats partial read as equivalent to unread.
- `Edit` reads current full disk content during validation/execution and applies
  a precise `old_string -> new_string` replacement.
- It rejects partial-read edits if mtime changed, because partial content cannot
  prove equality.

Decision status:

- Intended and previously approved.
- Rationale: full-file read would waste tokens for small precise edits on large
  files.

Current tests:

- `fileEdit.behavior.test.ts`
  - allows manually marked partial-view state for unchanged precise edit
  - allows range-read validation
  - allows range-read `call`
  - rejects range-read edit after mtime/content changed
  - allows partial read after sibling write that happened before the partial
    read

Review result:

- Keep behavior.
- This restores the intended Claude Code-like split: `Write` requires full read;
  `Edit` can use partial read plus current-disk exact matching.

2026-06-01 resume follow-up:

- Resume/cold-start reconstruction for successful historical `Edit` no longer
  reads current disk.
- It replays `old_string -> new_string` only against the latest full-known
  transcript state for that file.
- If there is no full-known prior state, or replay cannot be applied uniquely,
  it does not seed `readFileState`; the next live `Edit`/`Write` naturally has
  to read again.

Missing tests:

- Partial-read edit where mtime changes but content remains identical. Current
  design rejects because partial read cannot prove full equality; this should be
  pinned explicitly if kept.

### B04: `Edit` preserves existing BOM, encoding, and line endings

Old behavior at `b59a`:

- `FileEditTool` already used `readFileSyncWithMetadata` in the direct edit
  path, but `readFileSyncWithMetadata` did not expose `hadLeadingBom`.
- Lone CR was not normalized consistently.

New behavior:

- `readFileSyncWithMetadata` detects leading BOM, strips it from normalized
  content, and returns `hadLeadingBom`.
- `FileEditTool` writes back with original encoding and majority line ending.
- `writeTextContent` can preserve leading BOM.
- Mixed line endings use majority style; ties default to LF.

Decision status:

- Intended and previously approved.
- Rationale: edit is format-preserving; write is canonical replacement.

Current tests:

- `fileEdit.behavior.test.ts`
  - preserves CRLF
  - preserves majority CRLF
  - defaults mixed tie to LF
  - preserves UTF-8 BOM
- `fileRead.metadata.test.ts`
  - verifies line-ending detection
  - verifies BOM stripping/reporting
  - verifies UTF-16LE metadata read

Review result:

- Keep behavior.

Potential concern:

- `writeTextContent` prepends `UTF8_BOM` even when writing with `utf16le`
  encoding. Node may encode that character as the UTF-16LE BOM bytes, but this
  edge should be explicitly tested for UTF-16LE edit preservation.

Missing tests:

- Editing UTF-16LE with BOM should preserve UTF-16LE BOM and content.
- Editing a file with lone CR should normalize according to policy and not
  produce double CR.

### B05: `Read` now marks partial views and records registry sequence

Old behavior at `b59a`:

- Text reads stored content, timestamp, offset, and limit.
- Notebook reads stored content, timestamp, offset, and limit.
- Ordinary range reads did not set `isPartialView`.
- There was no process-local read/write sequence.

New behavior:

- Text reads set `isPartialView` when `offset !== 1` or `limit !== undefined`.
- Text and notebook reads call `recordFileRead`.
- `recordFileRead` stamps the current cache entry with `registrySequence`.

Decision status:

- Intended.

Current tests:

- `fileWrite.behavior.test.ts` and `fileEdit.behavior.test.ts` assert partial
  range read behavior indirectly.
- `fileRead.metadata.test.ts` covers BOM stripping for read results.
- `fileStateRegistry.test.ts` covers reminder queries and sequence logic.

Review result:

- Keep behavior.

Missing tests:

- Offset boundary: `offset=0` is accepted by schema and is treated as partial by
  `isPartialRead`. This should be explicitly pinned.
- Notebook read partial/full semantics should be reviewed; notebook reads store
  offset/limit but the notebook path does not expose partial notebook reads in
  the same way text reads do.

### B06: Repeated unchanged `Read` now escalates guidance

Old behavior at `b59a`:

- Repeated unchanged reads returned `FILE_UNCHANGED_STUB`.
- No `dedupCount` or `dedupLevel` appeared in output schema.
- No escalating model-facing guidance was appended.

New behavior:

- `file_unchanged` output includes optional `dedupCount` and `dedupLevel`.
- Model-facing tool result appends guidance after repeated unchanged reads.
- Third and later repeated unchanged reads append a `STOP` hint.
- Dedup is skipped after same-process sibling writes.

Decision status:

- Intended, but externally visible.

Current tests:

- `fileRead.dedup.test.ts`
  - first dedup returns `file_unchanged`
  - repeated dedup escalates
  - different offset/limit does not dedup
  - post-edit/post-write state does not dedup
  - sibling write suppresses stale dedup
- `fileReadDedupEscalation.test.ts` covers tracker utility.

Review result:

- Keep behavior unless model-quality review shows the STOP wording causes
  undesirable loops.

Compatibility risk:

- SDK consumers using the output schema now see optional fields.
- Model-facing text is materially different from `b59a`.

Missing tests:

- Dedup reset after actual full reread following escalation.
- Dedup behavior after `offset=0`.

### B07: Same-process sibling writes are detected

Old behavior at `b59a`:

- Cross-context writes were only detected if mtime/content checks caught them.
- If a subagent restored mtime, parent could miss the change.

New behavior:

- `fileStateRegistry.ts` tracks process-local owner identity and write
  sequence by normalized path.
- Structured writes call `noteFileWrite`.
- Parent/child contexts detect writes by another owner after their read.
- Subagents clone parent `readFileState` including `registrySequence`.

Decision status:

- Intended.

Current tests:

- `fileWrite.behavior.test.ts`, `fileEdit.behavior.test.ts`,
  `notebookEdit.behavior.test.ts`, and `bashSimulatedSed.behavior.test.ts`
  cover sibling writes with restored mtime.
- `fileStateRegistry.test.ts` covers sequence/reminder queries.
- `fileStateCache.test.ts` covers clone preserving registry sequence and
  persistence omitting it.

Review result:

- Keep same-process behavior.

Accepted limitations:

- No cross-process registry.
- Separate CLI/tmux/pane processes rely on mtime/content stale checks and
  checkpoint recovery.

Potential concern:

- Registry path identity uses `path.normalize`, not `realpath`.
- Symlink aliases and case differences on case-insensitive filesystems may
  evade sibling detection.

Missing tests:

- Symlink alias behavior should be documented or pinned.
- Windows case-insensitive alias behavior should be reviewed.

### B08: Same-path structured writes are serialized with an async mutex

Old behavior at `b59a`:

- Tool code tried to avoid awaits between stale check and write, but there was
  no shared same-path lock across write tools.

New behavior:

- `withFileStatePathLock` serializes callbacks by normalized path.
- `FileWriteTool`, `FileEditTool`, `NotebookEditTool`, and Bash simulated sed
  use the lock.
- Final stale checks and writes occur inside the lock.

Decision status:

- Intended.

Current tests:

- `fileWrite.behavior.test.ts`
- `fileEdit.behavior.test.ts`
- `notebookEdit.behavior.test.ts`
- `bashSimulatedSed.behavior.test.ts`
- `fileStateRegistry.test.ts`

Review result:

- Keep behavior.

Potential concern:

- The lock is not reentrant. A nested same-path call inside a lock would
  deadlock.
- No current path appears to nest the lock, but this is an invariant reviewers
  should check when adding future structured writers.

Missing tests:

- Explicit non-reentrancy behavior is not tested. It may be better documented
  than tested, since testing deadlock is awkward.

### B09: Atomic write fallback was narrowed

Old behavior at `b59a`:

- `writeFileSyncAndFlush_DEPRECATED` tried temp-file atomic write first.
- On any atomic failure, it cleaned temp and fell back to direct non-atomic
  write.

New behavior:

- Temp write, flush, chmod, and non-lock rename failures clean temp and throw
  `FileHarnessError` with reason `atomic_write_failed`.
- Structured file tools remain strict: they do not opt into direct fallback.
- Config/settings writes explicitly opt into direct fallback, but only for
  rename-stage lock-style errors (`EPERM`, `EACCES`, `EBUSY`) after the temp
  file has already been written and flushed.

Decision status:

- Resolved on 2026-06-01: fallback is accepted as a constrained reliability
  harness for application-owned config/settings, not as a global escape hatch
  for user-file writes.

Current tests:

- `file.test.ts`
  - original file remains intact on rename failure
  - new target is not created on rename failure
  - temp file cleanup
  - metadata/cause/code preservation
  - opt-in fallback succeeds for rename lock failures
  - opt-in fallback does not run for non-lock rename failures
- `settingsWriteFallback.test.ts`
  - `updateSettingsForSource` uses opt-in fallback on settings rename lock
  - failed settings writes do not mark the write as internal

Review result:

- Keep behavior for structured file tools.
- Keep constrained fallback for config/settings.

Compatibility risk:

- This helper is shared by config/settings writes, not only file tools:
  - `agent/src/utils/config.ts`
  - `agent/src/utils/settings/settings.ts`
  - indirect calls through `writeTextContent`
- Config/settings writes no longer fallback on temp write, flush, chmod, or
  non-lock rename failures. This intentionally rejects the highest-risk
  fallback cases while preserving the useful Windows/editor/AV/sync lock case.
- Settings internal-write marks are now recorded only after a successful write,
  so a failed save cannot briefly suppress a real external watcher event.

### B10: Failure taxonomy and metadata were added

Old behavior at `b59a`:

- `ValidationResult` had only `{ result, message, errorCode }`.
- Execution stale failures generally threw plain errors.
- No typed file harness failure taxonomy existed.

New behavior:

- `ValidationResult` can carry `behavior`, `meta`, and
  `fileHarnessFailure`.
- `FileHarnessError` carries reason/phase/path and optional cause/code.
- Reasons currently include:
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

Decision status:

- Intended.

Current tests:

- `failureMetadata.test.ts`
- `fileHarnessFailures.test.ts`
- `toolExecutionValidation.test.ts`

Review result:

- Keep metadata shape.

Potential concern:

- `encoding_unsupported` is catalogued as planned but not enforced by design.
  This should remain documented so later UI/statistics do not imply it is live.
- `path` appears in metadata. Confirm telemetry/log consumers do not export
  this field unsafely.

### B11: FileEdit match failures now escalate guidance

Old behavior at `b59a`:

- `string_not_found` and `multiple_match` returned fixed validation messages.

New behavior:

- Consecutive failures for the same file/reason/read snapshot are tracked.
- Second failure adds reread guidance.
- Third and later failures add `STOP`.
- Telemetry logs reason, count, level, and file extension only.

Decision status:

- Intended.

Current tests:

- `failureMetadata.test.ts`
- `fileEditFailureEscalation.test.ts`
- `toolExecutionValidation.test.ts`

Review result:

- Keep behavior, with wording subject to model-quality review.

Compatibility risk:

- Model-facing validation content changes.

Missing tests:

- Escalation reset after actual reread, not just after valid validation.

### B12: NotebookEdit participates in harness registry and locking

Old behavior at `b59a`:

- NotebookEdit required read-before-edit and mtime stale checks.
- It did not use sibling registry.
- It did not use path lock.
- `FILE_UNEXPECTEDLY_MODIFIED_ERROR` from execution catch would be returned as
  a tool data error payload, not rethrown.

New behavior:

- Validation and execution check sibling registry.
- Execution uses same-path lock.
- Writes preserve BOM/line ending via `readFileSyncWithMetadata` and
  `writeTextContent`.
- `FILE_UNEXPECTEDLY_MODIFIED_ERROR` is rethrown from call.

Decision status:

- Mostly intended, but one behavior needs explicit decision.

Current tests:

- `notebookEdit.behavior.test.ts`
  - unread rejection
  - sibling write guard
  - lock wait
  - UTF-8 BOM preservation
- `failureMetadata.test.ts`
  - execution sibling metadata

Review result:

- Keep registry and lock behavior.

Decision result:

- HR3 resolved on 2026-06-01: NotebookEdit now uses a content fallback for
  full-read mtime-only drift.
- The comparison uses the same processed notebook cell JSON that FileReadTool
  stores in `readFileState`, not the raw full `.ipynb` JSON. This matches what
  the model actually read.
- Partial read state still does not get the fallback and remains stale on mtime
  drift.
- The throw-vs-error-payload behavior for execution stale changed. This may be
  correct for consistency with FileEdit/FileWrite, but it is a user-visible
  behavior change and should be approved explicitly.

Current tests:

- Notebook mtime-only drift with identical content is allowed after full Read.
- Notebook mtime drift after partial read state is still rejected.

Remaining missing tests:

- Notebook UTF-16LE/BOM preservation if supported or intentionally unsupported.

### B13: Bash `_simulatedSedEdit` now preserves format, locks, and records writes

Old behavior at `b59a`:

- Simulated sed detected encoding and line endings separately.
- It wrote the provided new content.
- It updated local `readFileState`.
- It did not use path lock.
- It did not record sibling registry writes.

New behavior:

- Simulated sed uses `readFileSyncWithMetadata`.
- It preserves BOM and line endings.
- It serializes by path.
- It normalizes cached content to LF.
- It calls `noteFileWrite`.

Decision status:

- Format preservation, lock, and registry recording are intended.

Current tests:

- `bashSimulatedSed.behavior.test.ts`
  - sibling parent write blocked after simulated sed
  - lock wait
  - UTF-8 BOM and CRLF preservation

Review result:

- Keep implemented improvements.

Decision needed:

- Simulated sed still does not enforce read-before-write or stale-read checks
  before writing. This is different from `FileEditTool`, but it may be
  acceptable because `_simulatedSedEdit` is internal-only and permission-preview
  generated.
- Need decide whether simulated sed is part of the structured file harness
  guard surface or remains a permission-approved shell edit that only reports
  writes after the fact.

Missing tests:

- Simulated sed on a file not read in current context.
- Simulated sed after stale parent read.
- Simulated sed after sibling write.

### B14: Arbitrary shell writes remain outside the registry

Old behavior at `b59a`:

- Bash/PowerShell arbitrary writes were not parsed into file state.

New behavior:

- Same, except internal `_simulatedSedEdit` participates in registry/lock.

Decision status:

- Accepted limitation.
- Rationale: parsing all shell write behavior requires a checkpoint-level or
  filesystem-monitor-level system and is too heavy for this harness phase.

Review result:

- Keep limitation, document clearly.

Risk:

- Same-process registry cannot detect arbitrary shell writes if mtime is
  restored or filesystem resolution is coarse.
- Cross-process shell writes rely only on mtime/content and checkpoint recovery.

Required follow-up:

- Ensure docs state this clearly so users do not overestimate harness coverage.

### B15: Subagent completion reminders were added

Old behavior at `b59a`:

- Parent context was not explicitly warned when subagent modified a file the
  parent had read.

New behavior:

- Parent captures known read paths and registry sequence before subagent work.
- On sync, async, backgrounded, and resumed subagent completion, parent result
  can include:
  - `[NOTE: subagent modified files the parent previously read. Re-read before editing: ...]`

Decision status:

- Intended.

Current tests:

- `fileStateReminder.test.ts`
  - result reminder
  - no reminder for parent-unread path
  - notification text reminder
- `fileStateRegistry.test.ts` covers reminder query utilities.

Review result:

- Keep behavior.

Potential concern:

- Reminder text is model-facing and appended to agent result content.
- Killed/failed async agents do not appear to append the reminder; check if this
  is intended. A killed agent may still have modified files.

Missing tests:

- Backgrounded sync-to-async path integration.
- Resumed background agent reminder integration.
- Killed/failed agent with file modifications.

### B16: Cross-process registry remains unsupported

Old behavior at `b59a`:

- No cross-process registry.

New behavior:

- Same.
- New registry is process-local only.

Decision status:

- Accepted limitation.

Review result:

- Keep no cross-process registry.

Required documentation:

- Separate tmux panes, separate CLI processes, and possibly Worker/process
  boundaries rely on mtime/content checks and checkpoint recovery.

### B17: Read/notebook content normalization expanded

Old behavior at `b59a`:

- `readFileSyncWithMetadata` normalized CRLF to LF but not lone CR.
- It did not strip BOM from returned content.
- `readNotebook` read UTF-8 string directly.

New behavior:

- `readFileSyncWithMetadata` strips leading BOM and normalizes CRLF and lone CR
  to LF.
- `readNotebook` uses `normalizeContentToLf`, so notebook reads strip UTF-8 BOM
  and normalize line endings before JSON parse.

Decision status:

- Intended.

Current tests:

- `fileRead.metadata.test.ts`
  - BOM stripping
  - CRLF normalization
  - UTF-16LE metadata read
- `notebookEdit.behavior.test.ts`
  - BOM notebook edit preservation

Review result:

- Keep behavior.

Compatibility risk:

- Model-visible file contents from `Read` no longer include leading BOM.
- Lone-CR files are normalized to LF.

Missing tests:

- Notebook read with leading BOM and CRLF, not just notebook edit.

### B18: Internal `FILE_UNCHANGED_STUB` write guard added

Old behavior at `b59a`:

- A model could write the read-dedup stub text back into a file.

New behavior:

- `FileWriteTool.validateInput` and `call` reject exact stub text and short
  wrapper text around it.
- Larger real documents that quote the stub are allowed.

Decision status:

- Intended.

Current tests:

- `fileWrite.behavior.test.ts`

Review result:

- Keep behavior.

Potential concern:

- Heuristic uses length <= 2x stub length. This is intentionally narrow.

### B19: Checkpoint/fileHistory tests were stabilized

Old behavior at `b59a`:

- Some git-backed tests created more commits than needed and used default
  timeout/cleanup behavior.
- Windows cleanup and git runtime could produce flaky timeouts.

New behavior:

- Git-backed tests use 30s helpers.
- Some fixture commit counts were reduced where semantics did not require large
  histories.
- Temp cleanup uses `maxRetries`/`retryDelay` in several tests.

Decision status:

- Intended test-only change.

Current tests:

- The changed tests themselves are the coverage.

Review result:

- Keep test-stability changes.

Required caution:

- These are test-only changes and should not be mixed with runtime behavior
  conclusions.

## High-Risk Review Matrix

| ID | Area | Risk | Current conclusion | Action |
| --- | --- | --- | --- | --- |
| HR1 | `Write` canonicalization + transcript resume | Resumed `readFileState` used to risk raw tool input while disk contained canonical content | Fixed and tested | Keep no JSONL mutation; monitor focused resume tests |
| HR2 | Atomic helper shared callers | Global strict atomic would break config/settings fallback semantics | Fixed and tested | Keep file tools strict; allow config/settings constrained rename-lock fallback |
| HR3 | NotebookEdit mtime-only drift | False stale rejection unlike FileEdit/FileWrite | Fixed and tested | Keep FileReadTool cell-view comparison |
| HR4 | NotebookEdit stale throw behavior | Tool result error payload changed to thrown error | Needs decision | Decide consistency vs compatibility |
| HR5 | Bash simulated sed stale/read-before-write | Internal shell edit can write without read guard | Needs decision | Decide if simulated sed is structured harness writer |
| HR6 | UTF-16LE BOM preservation | `UTF8_BOM` char with `utf16le` encoding likely works but unpinned | Needs test | Add UTF-16LE edit test |
| HR7 | Registry path identity | `path.normalize` misses realpath/symlink/case aliases | Accepted or fix | Decide before adding complexity |
| HR8 | Lock non-reentrancy | Nested same-path lock would deadlock | Accepted invariant | Document for future writers |
| HR9 | Subagent killed/failed reminders | File changes may happen but no completion reminder | Needs review | Inspect lifecycle and decide |
| HR10 | Telemetry/privacy | Metadata contains paths; escalation telemetry avoids paths | Needs audit | Verify all logging/export paths |

## Test Coverage Map

| Behavior | Current tests | Coverage quality | Missing |
| --- | --- | --- | --- |
| Write unread/full-read guard | `fileWrite.behavior`, `failureMetadata`, `queryHelpers.fileStateResume` | Strong | None obvious |
| Write partial-read reject | `fileWrite.behavior`, `failureMetadata` | Strong | None obvious |
| Write canonical LF/no BOM | `fileWrite.behavior`, `queryHelpers.fileStateResume`, `fileStateCache` | Strong | None obvious |
| Edit partial-read allow | `fileEdit.behavior` | Good | mtime-only same-content partial case |
| Edit stale reject | `fileEdit.behavior`, `failureMetadata` | Strong | None obvious |
| Edit format preservation | `fileEdit.behavior`, `fileRead.metadata` | Good | UTF-16LE edit |
| Edit resume reconstruction | `queryHelpers.fileStateResume` | Good | More quote-style replay edge cases only if bugs appear |
| Read dedup escalation | `fileRead.dedup`, `fileReadDedupEscalation` | Good | reset after reread; offset=0 |
| Registry sibling writes | FileHarness tests + `fileStateRegistry` | Good | symlink/case alias |
| Path lock | FileHarness tests + `fileStateRegistry` | Good | nested lock invariant |
| Atomic failure | `file.test` | Good for helper | non-file-tool caller effects |
| Failure metadata | `failureMetadata`, `fileHarnessFailures` | Strong | telemetry export audit |
| FileEdit escalation | `failureMetadata`, utility tests, toolExecution test | Good | reset after reread |
| NotebookEdit | `notebookEdit.behavior`, `failureMetadata` | Good | stale throw decision, UTF-16LE |
| Bash simulated sed | `bashSimulatedSed.behavior` | Partial | read-before-write/stale decision |
| Subagent reminders | `fileStateReminder`, registry tests | Partial | killed/failed/resume integration |
| Checkpoint test stability | Changed tests | Adequate | full-suite soak over time |

## Review Execution Plan

### Phase A: Static diff audit

Status: complete for the current static review.

Actions:

- Read all changed runtime files in `b59a..HEAD`.
- Compare critical paths against `git show b59a:<file>`.
- Record old/new behavior in this document.

Remaining:

- Inspect all telemetry/log sinks that might consume `fileHarnessFailure.path`.
- Transcript/resume path for Write canonicalization is fixed and covered by
  `queryHelpers.fileStateResume.test.ts`.

### Phase B: Behavior contract review against tests

Status: complete for the current static review.

Actions:

- Map every behavior change to tests.
- Distinguish strong coverage from merely adjacent coverage.

Remaining:

- Add proposed test list, but do not implement until decisions are made.

### Phase C: Adversarial/manual probes

Status: not started.

Candidate probes:

- Re-run Write CRLF+BOM resume/cold-start extraction if future query history
  parsing changes.
- Notebook mtime-only drift with identical content.
- Bash simulated sed after stale read.
- Symlink path read via symlink, write via realpath.
- UTF-16LE edit with BOM.

### Phase D: Full-suite stability check

Status: original static review did not run a full-suite stability pass. The
2026-06-01 HR1 follow-up ran focused resume/cache/write/edit tests and type
checking.

Known stable commands from prior run:

```powershell
pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness --no-file-parallelism --hookTimeout 120000 --testTimeout 30000
pnpm run build:types
pnpm run test
```

2026-06-01 focused verification:

```powershell
pnpm --filter ./agent exec vitest run src/__tests__/unit/utils/queryHelpers.fileStateResume.test.ts src/__tests__/unit/utils/fileStateCache.test.ts
pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness/fileWrite.behavior.test.ts
pnpm --filter ./agent exec vitest run src/__tests__/unit/tools/FileHarness/fileEdit.behavior.test.ts
pnpm --filter ./agent run build:types
```

Important:

- Focused FileHarness runs should use `--no-file-parallelism`; import mocks in
  this area have been flaky in parallel file mode.

### Phase E: Decision review

Status: HR1, HR2, and HR3 resolved; 4 user/product decisions remain.

Decisions to review before runtime changes:

1. Should NotebookEdit execution stale failures throw or return tool data error?
2. Should Bash simulated sed enforce read-before-write/stale guards?
3. Should registry path identity move from `normalize` to `realpath`/casefold?
4. Should killed/failed subagents append file-state reminders?

## Decision Checklist

| Decision | Current implementation | Recommended review stance |
| --- | --- | --- |
| `Write` requires full read | Yes | Keep |
| `Write` canonicalizes UTF-8/LF/no BOM | Yes | Keep; resume reconstruction now canonicalizes without reading disk |
| `Write` normalization metadata | Runtime only when BOM/CR existed | Keep out of JSONL/persisted cache |
| `Edit` resume reconstruction | Replays against full-known transcript state only | Keep; no current-disk seeding |
| `Edit` allows partial read | Yes | Keep |
| `Edit` preserves source format | Yes | Keep, add UTF-16LE test |
| Unsupported encoding hard reject | No | Keep no-reject for now |
| Cross-process registry | No | Keep no cross-process registry |
| Shell write parsing | No | Keep no arbitrary shell parsing |
| Bash simulated sed stale guard | No | Needs explicit decision |
| Notebook mtime content fallback | Yes | Resolved: compare FileReadTool cell-view content |
| Atomic fallback removal globally | No | Resolved: file tools strict; config/settings constrained fallback for rename lock |
| Registry realpath/case aliasing | No | Needs explicit decision |
| Subagent killed/failed reminder | Probably no | Needs explicit decision |

## Current Review Conclusion

The core FileRead/FileWrite/FileEdit harness behavior is mostly coherent and
well tested:

- `Write` is full replacement and now requires full prior read.
- `Edit` is precise replacement and can proceed after partial read if current
  disk state is fresh.
- Full-read mtime-only drift uses content fallback for FileEdit/FileWrite and
  NotebookEdit.
- Same-process sibling writes and same-path write interleavings are guarded.
- FileEdit/FileWrite format policy matches the decided split.

The static behavior review is complete, and the highest-risk resume
reconstruction issue, atomic-helper scope, and NotebookEdit mtime fallback have
been fixed. The series should still not be treated as fully signed off until
the remaining 4 decision
items are resolved. The serious
unresolved items are outside the narrow happy path:

- NotebookEdit behavior consistency with FileEdit/FileWrite;
- Bash simulated sed's guard level;
- registry alias limitations;
- reminder behavior for killed/failed subagents.

These items need decision before any further harness UI/statistics work, because
UI and telemetry would otherwise expose or solidify behavior that may still be
wrong.
