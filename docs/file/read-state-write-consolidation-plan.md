# File Harness Read-State Write Consolidation — Plan

Status date: 2026-06-17

Author context: follow-up to the 2026-06-17 false-rejection fixes (plan
attachment, ExitPlanMode write, nested-memory injection — all the same bug
class). This document plans whether and how to consolidate read-state write
points so that bug class cannot recur, WITHOUT trading one smelly architecture
for another.

## The bug class being closed

`FileState.content` in `agent/src/utils/fileStateCache.ts` records "what the
model saw" for a file. The Write/Edit gates (`isReadStateStaleForWrite`,
`wasFileModifiedAfterReadByAnotherContext`) reject a write when the recorded
content no longer matches disk. Roughly 10 production write points populate
this cache. They share ONE implicit, type-unenforced invariant:

> The stored `content` MUST be canonicalized with the SAME function the
> matching gate uses to canonicalize the current disk content before comparing.

For text files that canonicalizer is `normalizeContentToLf` (strip BOM,
CRLF→LF). For notebooks it is `notebookCellsToReadStateContent` (a cell-JSON
read-state shape, NOT line-ending normalization). Any write point that stores
raw bytes instead breaks the invariant: while the read is unstamped and mtime
is unchanged the mismatch lurks (the content compare is skipped); the moment
mtime advances the compare runs and FALSELY rejects `stale_content` on both
Edit and Write, and `getChangedFiles` falsely reports the file modified.

Three instances were found and fixed point-wise on 2026-06-17 (plan attachment,
ExitPlanMode write, nested-memory). This plan addresses the STRUCTURAL cause:
the invariant lives in 10 scattered call sites instead of one named, tested
boundary.

## Design decision: paired canonicalizer, not a super-entry, not a branded type

Two facts (verified in source, not inferred) shape the design:

### Fact 1 — canonicalization is per-file-type, not one function

- Text gates compare `normalizeContentToLf(disk)`; text read points store the
  same. (`FileEditTool.ts:224`, `FileWriteTool.ts:396/413`, `readFileSyncWithMetadata`
  strips BOM + LF at `fileRead.ts:98`.)
- Notebook gate compares `getNotebookReadStateContent(path)` and stores the
  same (`NotebookEditTool.ts:279/523`, `582`). This is cell-JSON, NOT
  `normalizeContentToLf`.

Therefore a single entry that blindly applies `normalizeContentToLf` to ALL
content would CORRUPT notebook read-state — and no current test would fail
(notebook's stored `FileState.content` string is not asserted anywhere; only
its on-disk round-trip is). The true invariant is "store what the matching gate
compares", which is a per-type pairing, not a universal function.

### Fact 2 — stamping is an orthogonal axis that must NOT be merged

There are two intentional store idioms today:

- STAMPED: `setObservedFileState` → `recordFileRead` assigns a
  `registrySequence`. Used by live observations and plan/memory injection that
  should count as a fresh read.
- DELIBERATELY UNSTAMPED: raw `readFileState.set(...)` in compact preserved-tail
  (`compact.ts:1004/1015`), resume reconstruction (`queryHelpers.ts:702`), and
  speculation. Leaving `registrySequence` undefined makes
  `wasFileModifiedAfterReadByAnotherContext` ABSTAIN and defer to the
  content/mtime gate. This is the crux of the prior ~12-commit registry
  abstention fix; minting a fresh stamp on a rebuilt historical read would order
  it AFTER a real concurrent sibling write and mask it.

Therefore canonicalization (content axis) MUST remain separable from stamping
(ordering axis). A single entry that couples them reintroduces the sibling-write
false-negative/false-positive class that was closed at great cost.

### Why not a branded `FileState.content` type

A branded type (`type CanonicalContent = string & {__canonical: true}`) would
enforce "non-canonical content cannot be stored" at compile time. Rejected
because notebook content, partial-view raw bytes (`isPartialView`, stored raw
for `getChangedFiles` diffing), and reconstructed transcript text are all
LEGITIMATE non-`normalizeContentToLf` content. A brand would force `as`-casts at
every such site, which strips the brand of meaning. The invariant is runtime and
per-type; a runtime paired canonicalizer fits it, a blanket compile-time brand
does not.

### Chosen shape

1. Introduce a single named text canonicalizer boundary for read-state, e.g.
   `recordObservedTextReadState(context, path, {content, timestamp, ...}, {stamp})`
   OR a thinner `canonicalizeTextForReadState(content) = normalizeContentToLf`
   that EVERY text side-channel write point must call. The point: make "store
   text read-state" a named operation that normalizes internally, so a future
   caller physically cannot forget. The `stamp` option keeps the stamping axis
   explicit and orthogonal.
2. Notebook write points keep their own `getNotebookReadStateContent` path
   (already correct) — documented as the notebook arm of the same invariant,
   and newly TEST-ANCHORED on stored `FileState.content`.
3. Reconstruction paths keep raw `.set()` (unstamped) — they already store
   canonicalized text (reconstructed from transcript, which is model-visible LF)
   and must stay unstamped. The new boundary's `stamp:false` option may be
   adopted here for readability but must not change the unstamped semantics.

This raises the implicit convention to one named, unit-testable function per
axis without fusing the three orthogonal concerns (normalization, stamping,
partial-view). That is the difference between fixing the smell and relocating it.

## Test anchoring required BEFORE refactor (break-and-reproduce)

Per `feedback_unit_tests_mock_the_bug_away`: anchor current correct behavior
with real-path tests first, confirm they pass on today's code, THEN refactor and
require them to still pass. Blind spots identified in the coverage map that must
be closed first:

- B1. Notebook stored `FileState.content` shape — assert the cached string after
  a real NotebookEdit equals `getNotebookReadStateContent(disk)` (NOT
  `normalizeContentToLf`). This is the guardrail that catches a refactor
  corrupting notebooks. HIGHEST PRIORITY.
- B2. print.ts `seed_read_state` (`2644`) and `pendingSeeds` drain (`1849`) —
  no test exists. Add one seeding a CRLF/UTF-16LE file and asserting a
  subsequent Edit is NOT falsely stale.
- B3. CRLF/BOM through compact preserved-tail and sessionMemory plan — current
  fixtures are LF-only, so dropping normalization there would not fail. Add
  CRLF fixtures.
- B4. ExitPlanMode write point — already anchored by
  `exitPlanModeReadStateSync.test.ts` (added 2026-06-17). ✅
- B5. nested-memory injection (`attachments.ts:1471`) and REPL startup
  (`REPL.tsx:3435`) — only the relevant-memory sibling (2244) has a CRLF test.
  Add a direct nested-memory CRLF test (REPL.tsx is TUI-untested; cover the
  shared logic via the attachments path).

Well-covered, safe to refactor as-is: all four FileHarness `*.behavior.test.ts`
(real disk + real gate), `fileStateRegistry.test.ts` (abstention pair),
`queryHelpers.fileStateResume.test.ts` (reconstruction normalization +
unstamped), `attachmentsFileStateRegistry.test.ts` (CRLF relevant-memory).

## Phased execution

- Phase 0 (this doc): design + coverage decided. ✅
- Phase 1 — Anchor: add B1, B2, B3, B5 real-path tests; confirm green on current
  HEAD. No production change. ✅ DONE 2026-06-17 (commit 33434ea9): B1 (notebook
  stored-content) + B5 (nested-memory CRLF) with break-and-reproduce; B3
  sessionMemory switched to CRLF; B2 + preserved-tail verified-not-needed and
  documented (no fake-pass).
- Phase 2 — Introduce boundary: add the named text canonicalizer entry; migrate
  text side-channel write points (plan ×2, nested-memory ×2, relevant-memory,
  ExitPlanMode, print seed) to call it. ✅ DONE 2026-06-17: added
  `canonicalizeTextForReadState` + `recordObservedTextReadState` (4 boundary unit
  tests: canonicalization, stamp 'live', stamp 'reconstructed' abstention, VIEW
  pass-through). Migrated all 7 sites (all stamp:'live' per NOTE A).
  `setObservedFileState` now has no production caller outside the boundary. 173
  affected tests green; types clean.
- Phase 3 — Document the notebook arm + reconstruction unstamped contract inline.
  ✅ DONE 2026-06-17: notebook arm comment + explicit "do NOT route through
  recordObservedTextReadState" warning naming the anchor test. Reconstruction
  sites already carry unstamped-contract comments — left as-is. Optional cosmetic
  folds (BashTool sed; stamp:'reconstructed' adoption) SKIPPED as pure churn.
- Phase 4 — Full suite (`pnpm run test`), `build:types`, and a real-app smoke
  (`--print --permission-mode plan` editing a CRLF plan + a notebook) before
  pushing to main.

## Non-goals

- No telemetry/dashboard (HR10/R7 already decided against).
- No change to the stamping/abstention semantics — only made more explicit.
- No branded types.
- No merging of notebook content handling into the text canonicalizer.

## Risk register

- R1 Notebook corruption by over-normalization — mitigated by B1 anchor + keeping
  notebook arm separate. HIGH if ignored, LOW with B1.
- R2 Reintroducing sibling-write masking by coupling stamp+normalize — mitigated
  by keeping axes orthogonal (`stamp` option explicit). Covered by
  `fileStateRegistry.test.ts` + `preservedTailReadState.test.ts`.
- R3 Untested seed path regressing — mitigated by B2.
- R4 Behavior drift during migration — every Phase 2 migration is content-equal
  to current code; Phase 1 tests are the diff detector.

## Detailed Refactor Design (the sensitive core)

This section specifies the exact API, every call-site rewrite, and the
invariants each must preserve. The whole point is that the new boundary is
content-EQUIVALENT to today at every site (they already normalize), so behavior
does not move — only the place the invariant is enforced moves.

### Where the new code lives

`agent/src/utils/fileStateRegistry.ts` already owns the three store idioms
(`setObservedFileState`, `setObservedFileStateIfNewer`, `recordFileRead`/
`noteFileWrite`) and the `FileStateContext = Pick<ToolUseContext, 'agentId' |
'readFileState'>` type. The new boundary belongs here, beside them, importing
`normalizeContentToLf` from `./file.js`. No new module — adding one would split
the read-state vocabulary across two files.

### The three axes, kept orthogonal

Every read-state write is the product of three independent decisions. The bug
class came from one axis (canonicalization) being implicit. The fix makes it
explicit WITHOUT fusing it to the other two:

1. CANONICALIZATION (content axis) — text → `normalizeContentToLf`; notebook →
   `getNotebookReadStateContent`. This is what we are centralizing.
2. STAMPING (ordering axis) — stamped (live read, counts for sibling-write
   ordering) vs unstamped (reconstructed/seeded, registry abstains). Caller
   decides; boundary must not force it.
3. VIEW (completeness axis) — full vs `isPartialView` (raw bytes stored for
   getChangedFiles diffing, gate treats as insufficient for overwrite). Caller
   supplies; boundary must pass through untouched.

### API

```ts
// fileStateRegistry.ts

/**
 * Canonicalize a TEXT file's content to the read-state form the text
 * Write/Edit gates compare against (normalizeContentToLf: BOM-stripped,
 * CRLF→LF). This is the single text arm of the read-state canonicalization
 * invariant. Notebooks use getNotebookReadStateContent instead and must NOT
 * pass through here.
 */
export function canonicalizeTextForReadState(content: string): string {
  return normalizeContentToLf(content)
}

/**
 * Record an observed TEXT read into read-state with canonical content.
 * Centralizes the "store text the gate can compare" invariant so no caller
 * can forget to normalize.
 *
 * - Canonicalizes `fileState.content` via canonicalizeTextForReadState.
 * - `stamp` selects the ORTHOGONAL ordering axis:
 *     'live'        → setObservedFileState semantics (recordFileRead stamps it)
 *     'reconstructed' → raw set, left UNSTAMPED so the registry abstains
 *   Default 'live'. Reconstruction/seed/compact callers pass 'reconstructed'.
 * - All other FileState fields (offset, limit, totalLines, isPartialView,
 *   toolNormalization) pass through verbatim — the VIEW axis is the caller's.
 */
export function recordObservedTextReadState(
  context: FileStateContext,
  filePath: string,
  fileState: FileState,
  opts?: { stamp?: 'live' | 'reconstructed' },
): void {
  const canonical: FileState = {
    ...fileState,
    content: canonicalizeTextForReadState(fileState.content),
  }
  if ((opts?.stamp ?? 'live') === 'live') {
    setObservedFileState(context, filePath, canonical) // stamps
  } else {
    context.readFileState.set(normalize(filePath), canonical) // unstamped
  }
}
```

Design notes:

- `canonicalizeTextForReadState` is exported separately so the GATES can use the
  exact same function name on the read side, making the pairing greppable and a
  future line-ending policy change a one-liner. (It wraps `normalizeContentToLf`
  rather than replacing it, so the 50+ existing `normalizeContentToLf` callers
  are untouched; this is the read-state-specific alias.)
- The `stamp` option is the ONLY way the boundary touches the ordering axis, and
  it is explicit at every call. There is no hidden stamping. This is what keeps
  axis 2 from regressing the abstention fix.
- The boundary deliberately does NOT accept notebook content. Notebook write
  points keep calling `getNotebookReadStateContent` + raw `.set()`/
  `setObservedFileState`. Forcing notebooks through a text canonicalizer is the
  R1 corruption risk; the type/name boundary makes that misuse visible in review.
- `noteFileWrite` is NOT folded in. Write tools (FileWrite/FileEdit/sed/Notebook)
  do `set(...)` then `noteFileWrite(...)` to register themselves as last writer.
  That is the writer-registration concern, distinct from observation. They keep
  their existing two-call pattern; only their `content` value is already
  canonical (they derive from a normalized read), so they need no migration.

### Call-site migration table

Legend: MIGRATE = route through `recordObservedTextReadState`; KEEP = leave as
is (with reason); each MIGRATE is content-equivalent to today.

| # | Site | Today | Action | stamp | Why content-equal |
|---|---|---|---|---|---|
| 1 | `compact.ts:1037` addPlanAttachmentIfNeeded | `setObservedFileState(ctx, p, {content: normalizeContentToLf(planContent), ...})` | MIGRATE | live | already normalizes; boundary does the same |
| 2 | `sessionMemoryCompact.ts:478` plan | same as #1 | MIGRATE | live | same |
| 3 | `attachments.ts:1471` nested-memory | `setObservedFileState(ctx, p, {content: normalizeContentToLf(...), isPartialView, ...})` | MIGRATE | live | normalize moves into boundary; `isPartialView` passes through (VIEW axis) |
| 4 | `attachments.ts:2244` relevant-memory | same shape as #3 (limit/isPartialView) | MIGRATE | live | same; `limit`+`isPartialView` pass through |
| 5 | `REPL.tsx:3435` startup memory | `setObservedFileState({readFileState}, p, {content: normalizeContentToLf(...), isPartialView, ...})` | MIGRATE | live | same as #3; context has no agentId (optional) |
| 6 | `ExitPlanModeV2Tool.ts:281` plan write | `setObservedFileState(ctx, p, {content: normalizeContentToLf(inputPlan), ...})` + `noteFileWrite` | MIGRATE the set; KEEP `noteFileWrite` | live | boundary handles the set; noteFileWrite stays (writer registration) |
| 7 | `print.ts:2644` seed_read_state | `setObservedFileState(seedCtx, p, {content: readFileSyncWithMetadata(p).content, ...})` | MIGRATE | reconstructed | content already BOM/LF-normalized by reader; switch to unstamped boundary preserves seed = re-confirmation, not a fresh live stamp. SEE NOTE A. |
| 8 | `print.ts:1849` pendingSeeds drain | `setObservedFileStateIfNewer({readFileState}, p, seed)` | KEEP | — | drains an already-built seed; the `IfNewer` timestamp guard is its real job, not canonicalization. Seed content already canonical from #7. SEE NOTE A. |
| 9 | `FileReadTool.ts:1044/867` | `readFileState.set(...)` from `readFileInRange`/`readFileSyncWithMetadata` + `recordFileRead` | KEEP | — | reader already strips BOM+LF; this IS the canonical source. Migrating buys nothing and risks double-normalize noise. |
| 10 | `FileEditTool.ts:592` | `set({content: updatedFile, ...})` + `noteFileWrite` | KEEP | — | `updatedFile` derived from normalized read; canonical by construction |
| 11 | `FileWriteTool.ts:412` | `set({content: canonicalContent, toolNormalization, ...})` + `noteFileWrite` | KEEP | — | already explicitly `canonicalContent`; has `toolNormalization` payload |
| 12 | `BashTool.tsx:443` sed | `set({content: newContent.replaceAll(CRLF→LF), ...})` + `noteFileWrite` | KEEP (Phase 3 optional) | — | inline normalize is BOM-equivalent (newContent already BOM-less). Optional cosmetic fold in Phase 3, guarded by sed behavior suite. |
| 13 | `NotebookEditTool.ts:522` | `set({content: getNotebookReadStateContent(p), ...})` + `noteFileWrite` | KEEP (NOTEBOOK ARM) | — | MUST NOT go through text boundary (R1). Add anchor test B1 + a comment naming it the notebook arm of the invariant. |
| 14 | `compact.ts:1004/1015` preserved-tail | raw `set({...fileState})`, deliberately unstamped | KEEP | — | reconstructed text already canonical (from transcript). Could adopt `stamp:'reconstructed'` for readability in Phase 3, but MUST keep unstamped semantics (R2). |
| 15 | `queryHelpers.ts:702` resume reconstruction | raw `set({...fileState})`, unstamped | KEEP | — | same as #14 |

NOTE A (print seed stamping): today #7 uses `setObservedFileState` (which
STAMPS via recordFileRead), while #14/#15 reconstruction stay unstamped. The seed
is a current-disk re-confirmation (client passes observed mtime, applied only if
disk not newer), so a live stamp is arguably correct today. Switching #7 to
`stamp:'reconstructed'` would change it to unstamped. THIS IS A BEHAVIOR
DECISION, not a pure refactor — it must be made explicitly and covered by B2,
NOT silently changed. Default recommendation: keep #7 as `stamp:'live'` to
preserve exactly today's semantics; revisit only with a real report. The table
lists 'reconstructed' as the candidate but Phase 2 ships 'live' unless B2 shows
otherwise.

### What does NOT change (explicit non-migration)

- The four write tools (#9–13) keep their write-back `set` + `noteFileWrite`.
  Their content is canonical by construction; touching them is churn with no
  invariant gain and notebook (#13) would be actively harmed.
- Stamping/abstention semantics (#14/#15) are unchanged. The boundary's
  `stamp:'reconstructed'` is offered for readability only and must reproduce raw
  unstamped `.set()` exactly.
- `isPartialView` / `toolNormalization` / `limit` / `totalLines` semantics — the
  VIEW axis — are pass-through. The boundary never sets or clears them.
- `getChangedFiles` diffing — once all observed content is canonical, the diff
  (fileState.content vs FileRead's normalized output) is apples-to-apples, which
  is the same property the gate relies on. No change needed there.

### Phase 1 anchor-test specifications (write these FIRST, must be green on HEAD)

Each is real-path (real disk + real tool/registry, per
`feedback_unit_tests_mock_the_bug_away`). They must pass on CURRENT code before
any production change, then still pass after Phase 2 — that is the proof of
content-equivalence.

B1 — Notebook stored read-state shape (HIGHEST PRIORITY; guards R1).
- File: `__tests__/unit/tools/FileHarness/notebookEdit.behavior.test.ts` (extend).
- Setup: write a real `.ipynb`, real `FileReadTool` (or NotebookRead path) then
  real `NotebookEditTool.call`.
- Assert: `context.readFileState.get(path)?.content === getNotebookReadStateContent(path)`
  AND it is NOT equal to `normalizeContentToLf(rawDiskBytes)`. This pins that
  notebook content is the cell-JSON shape, so a refactor that routes notebooks
  through the text canonicalizer FAILS here.
- Break-and-reproduce: temporarily swap the store to `normalizeContentToLf` →
  test must go red.

B2 — print.ts seed path (guards R3; covers untested #7/#8).
- File: new `__tests__/unit/cli/printSeedReadState.test.ts` (or nearest existing
  print/seed test harness — confirm none exists first).
- Setup: drive the `seed_read_state` control-request handler (or the smallest
  callable seam around `print.ts:2644`) for a CRLF file and a UTF-16LE file.
- Assert: stored content has no `\r` and no BOM; a subsequent real
  `FileEditTool.validateInput` after an mtime advance is NOT falsely stale.
- If the handler is not unit-callable without a full print harness, fall back to
  asserting at the smallest extracted function and note the integration gap
  explicitly (do not fake-pass).
- VERIFIED 2026-06-17 during Phase 1: the `seed_read_state` handler is deeply
  nested in print.ts's control-request message loop with no exported seam, and
  it has NO normalization logic of its own — it is literally
  `setObservedFileState(ctx, p, {content: readFileSyncWithMetadata(p).content, ...})`.
  The normalization risk lives entirely in `readFileSyncWithMetadata`, which is
  already fully anchored by `fileRead.metadata.test.ts` (CRLF→LF line 34, BOM
  strip line 45, UTF-16LE decode line 77). Decision: do NOT build a heavy,
  brittle print-stream integration test to re-prove an already-anchored helper;
  the seed path's only Phase-2 migration concern is the STAMP axis (NOTE A:
  keep 'live'), which is a one-line behavior-preserving change reviewable by
  reading. Integration-level coverage of the full seed control-request remains
  an acknowledged gap (no fake-pass added). If #7 ever grows its own
  normalization/transform, add the seam + test then.

B3 — CRLF/BOM through compact preserved-tail + sessionMemory plan.
- Files: `__tests__/unit/services/compact/preservedTailReadState.test.ts` and
  `sessionMemoryPlanReadState.test.ts` (extend; both currently LF-only).
- Setup: feed a CRLF plan/transcript fixture through the existing real paths.
- Assert: restored `FileState.content` has no `\r`; offset/limit/stamp semantics
  unchanged (preserved-tail stamped-vs-unstamped pair still holds).
- VERIFIED 2026-06-17 during Phase 1: only the sessionMemory plan half is a real
  risk (its content comes from `getPlan()` raw disk read) — done, CRLF fixture
  added. The preserved-tail / resume reconstruction half is NOT a CRLF risk: its
  content source is the transcript tool_result text (already model-visible LF,
  line-number-prefixed and stripped during reconstruction), never raw disk
  bytes — a CRLF can't occur on that input, so no CRLF fixture is meaningful
  there. Left as-is (LF). Documented so a future reader doesn't "fix" a non-bug.

B5 — nested-memory injection CRLF (guards #3/#5).
- File: `__tests__/unit/utils/attachmentsFileStateRegistry.test.ts` (extend; it
  already has the relevant-memory CRLF test) OR a focused test on the nested
  path in `attachments.ts`.
- Setup: invoke the nested-memory injection with a CRLF memory whose
  finalContent === rawContent (no frontmatter/comment/truncation), the exact
  case the 2026-06-17 fix addressed.
- Assert: stored content LF-normalized; `isPartialView` false (full read);
  a later Edit/Write after mtime advance is NOT falsely stale.

Already done: B4 ExitPlanMode — `exitPlanModeReadStateSync.test.ts` (2026-06-17). ✅

### Execution checklist

Phase 1 (no production change):
- [ ] B1 notebook stored-content anchor + break-and-reproduce
- [ ] B2 print seed CRLF/UTF-16LE anchor
- [ ] B3 compact preserved-tail + sessionMemory plan CRLF anchors
- [ ] B5 nested-memory CRLF anchor
- [ ] All green on current HEAD; commit "test(file-harness): anchor read-state
      normalization across injection points" — this commit alone has value even
      if Phase 2 is deferred.

Phase 2 (introduce boundary, migrate text sites #1–7):
- [ ] Add `canonicalizeTextForReadState` + `recordObservedTextReadState` to
      fileStateRegistry.ts with unit tests (stamp axis, view pass-through).
- [ ] Migrate #1–6 (stamp:'live'); migrate #7 (stamp:'live' per NOTE A).
- [ ] Confirm #8 (IfNewer drain) unchanged; confirm Phase 1 + full suite green.
- [ ] Commit.

Phase 3 (documentation + optional cosmetic folds):
- [ ] Inline comment at #13 (notebook arm) and #14/#15 (unstamped contract)
      linking the single invariant statement.
- [ ] Optional: fold BashTool sed (#12) inline normalize into
      `canonicalizeTextForReadState`; optional `stamp:'reconstructed'` adoption
      at #14/#15 (behavior-identical, readability only).
- [ ] Commit.

Phase 4 (verify + ship):
- [ ] `pnpm run build:types`, `pnpm run test` (full suite).
- [ ] Real-app smoke: `--print --permission-mode plan` editing a CRLF plan, and
      a NotebookEdit on a real `.ipynb`, confirming no false stale rejection and
      no notebook corruption.
- [ ] Push to main (per `feedback_push_to_main_directly`).

### Acceptance criteria

- Every text side-channel write point routes through one named boundary; the
  "forgot to normalize" failure mode is structurally impossible for new text
  callers.
- Notebook and reconstruction paths remain on their own arms, test-anchored.
- Stamping/abstention and partial-view semantics are byte-for-byte unchanged
  (proven by the pre-existing registry/abstention suites staying green).
- No behavior change ships silently: the only candidate behavior change (#7 seed
  stamping) is called out and defaulted to current semantics.



