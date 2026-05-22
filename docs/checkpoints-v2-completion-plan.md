# Checkpoints v2 — Completion plan

After Phase 1-5 + the post-merge audit cleanups (commits up to `05b9a828`),
the shadow-git checkpoint system is functional and used in production.
But three loose threads keep the port from being "fully absorbed":

1. **Hermes line-number refs rot**. 23 inline source comments and 8 progress-doc
   references point at `tools/checkpoint_manager.py:<line>` or
   `hermes_cli/checkpoints.py:<line>`. Hermes ships ~daily; those numbers
   are already partly stale and will be fully wrong within weeks.
2. **v1-compat framing is stuck in the codebase** even though we resolved
   long ago that axiomate has no v1 — Phase 3's pre-swap file-copy backend
   was unreleased internal scaffolding, not a shipped format.
3. **"Phase 6" is a placeholder**. The original plan punted five items
   to "future work". Two of them are now naturally closed; three are
   real gaps that block calling the port complete.

This plan turns each of those into bounded, verifiable work.

---

## Track 1 — Stable Hermes references

### Problem

Inline comments and progress doc cite Hermes by file + line number:

```ts
// tools/checkpoint_manager.py:830-972
// hermes_cli/checkpoints.py:189-205
```

23 such refs across 19 source files and 8 in `docs/`. Lines drift
constantly. Today, `tools/checkpoint_manager.py:830` lands inside `_take`
(correct), but a single Hermes refactor (rename, extract helper, dead-code
removal) shifts the entire file.

### Strategy

Replace `<file>:<line>` with `<file>::<symbol>` (function/class name) + an
optional snapshot SHA when the line range is load-bearing for the comment's
argument.

- **Function names are stable** across Hermes refactors. `_take`, `_run_git`,
  `_validate_commit_hash`, `clear_all`, `_dir_file_count`, `_prune`,
  `cmd_status`, `cmd_clear`, `_fmt_bytes`, `_fmt_age` — all of these have
  outlived multiple churn cycles.
- **When line range matters** (e.g. "Hermes does X at lines 830-972"), pin
  with `# Hermes @<sha7>` so a future maintainer can `git -C hermes-agent
  show <sha>:<file>` to read the exact code our comment was written against.

### Example transforms

```diff
- * Direct port of Hermes `_take` (`tools/checkpoint_manager.py:830-972`)
+ * Direct port of Hermes `_take` (`tools/checkpoint_manager.py::_take`,
+ * snapshot @edb2d91)

- * matches Hermes `cmd_clear` (`hermes_cli/checkpoints.py:189-205`)
+ * matches Hermes `cmd_clear` (`hermes_cli/checkpoints.py::cmd_clear`)
```

When a comment cites a line range that's narrower than a whole function
(e.g. `:387-493` describing a sequence of helpers), drop the range and
list the helper names instead: `_init_store, _ensure_default_excludes,
_register_project`.

### Scope

- 19 source files under `agent/src/utils/checkpoints/` and
  `agent/src/commands/checkpoints/` and `agent/src/cli/handlers/`
- `docs/checkpoints-v2-progress.md` and `docs/checkpoints-v2-design.md`
- Add a one-line convention note at the top of
  `docs/checkpoints-v2-progress.md`: *"Hermes references use
  `path::function`; line numbers are not portable across Hermes versions."*

### Exit criteria

- `rg 'checkpoint_manager\.py:\d|hermes_cli/[^\s]+\.py:\d'` returns 0 hits
  in `agent/src` and `docs/`.
- Spot-check 3 random comments — the function name they cite still exists
  in Hermes HEAD.

### Cost

~1 hour. Mechanical pass with grep + Edit.

---

## Track 2 — v1-compat purge

### Problem

The codebase still talks about "legacy v1 entries" and "file-copy backend"
as if the swap was a real version transition. It wasn't. Axiomate had no
shipped v1 of checkpoints — the file-copy backend never reached a release.

The remaining traces are misleading: a future contributor reading
`fileHistory.ts:477`'s comment will think "ah, defensive code for old
sessions" and either bloat it ("let's also handle v0 with...") or rip it
out as dead code ("v1 is gone, this is unreachable").

### What's actually in scope

| Site | What it currently says | What it should say |
|---|---|---|
| `fileHistory.ts:474-479` | "Defense: a malformed entry without `gitHash` would crash..." (already neutral) | Keep; this one is fine — it doesn't invoke v1. ✅ |
| `agent/src/utils/__tests__/fileHistory.test.ts:9` | "no `version === N`, no `backupFileName`" | Drop those negatives — they refer to a shape that never shipped. |
| `docs/checkpoints-v2-progress.md:308` | "file-copy directory archived to `file-history.legacy-<ts>/` on first boot via `cleanup.ts`" | **Stale**: the archival shim was never implemented (verified by `rg cleanupLegacyFileHistory` → no match). Strike from doc. |
| `docs/checkpoints-v2-progress.md:824` | T6 row: "feed a legacy-shape JSONL entry" | T6 is already marked closed; rephrase the closure note to drop "legacy-shape" framing. |
| `docs/checkpoints-v2-progress.md:835` | "F1 (legacy-shape resume crash)" | Rename to "F1 (malformed JSONL crash)". |
| `storeStatus.ts:10` (and any other comments referencing `legacy_size_bytes`) | "axiomate has no v1 legacy archives" | Already correct framing — but verify the surrounding context doesn't imply we *would* have them otherwise. |

### What to leave alone

- `clearAll.ts` divergence note "Hermes' `clear_legacy` not ported because
  axiomate has no v1" — this is a *correct* explanation of a deliberate
  divergence from Hermes, and a future port-auditor will need it.
- The audit history in `docs/checkpoints-v2-progress.md:324` ("dropped
  Hermes' v1/v2 framing") — this is a record of past work, not active code.

### Exit criteria

- `rg -i 'legacy.*shape|legacy.*entry|legacy.*backup|v1.*compat|file-copy.*backend|trackedFileBackups|legacy-shape'`
  in `agent/src/utils/**/*.ts` and `agent/src/commands/checkpoints/**`
  returns only the explanatory clearAll.ts divergence note.
- Progress doc line 308 either deleted or rewritten to reflect that no
  archival shim exists.
- F1 narrative renamed to "malformed JSONL crash" everywhere it appears.

### Cost

~30 minutes. Three or four targeted Edits.

---

## Track 3 — Phase 6 reification (the actual remaining work)

The original plan listed Phase 6 as five items "out of scope". Two are
now closed by reality, three remain real:

| # | Original Phase 6 item | Status | This plan |
|---|---|---|---|
| 6.1 | `/resume`↔rollback union — join transcript resume with worktree rewind | **Real gap**, still | Address as **6A** below |
| 6.2 | Cross-worktree resume reachability (Decision 6B) | **Real gap** | Address as **6B** below |
| 6.3 | Cross-worktree GC reachability | **Real gap** | Address as **6C** below |
| 6.4 | File-copy → new store force-migration | ✅ Closed (no v1 to migrate) | Drop |
| 6.5 | Change `fileCheckpointingEnabled` default | ✅ Closed (kept opt-in) | Drop |

Plus three items from elsewhere in the progress doc that were promised
but not delivered:

| # | Item | Source |
|---|---|---|
| 6D | T1 / T2 / T5 test gaps | `progress.md:test-gap table` |
| 6E | Observability — snapshot p50/p95, store-size telemetry | `plan.md:End-to-end verification` |
| 6F | One-week dogfood metrics report | Same |

### 6A — `/resume`↔rollback union ✅ landed

**Problem.** `/resume` rebuilds transcript state from JSONL. `/rewind`
rolls the worktree back. Today they're independent. If a user resumes
session A and then wants the worktree at turn N of A, they have to do
two commands; if turn N's `gitHash` was orphan-pruned in the meantime,
`/rewind` fails.

**Shipped.** Helper `findReachableSnapshot` + `computeResumeRewindHint`
in `agent/src/utils/checkpoints/`. Tri-state reachability probe (cat-file
-e then merge-base --is-ancestor); REPL pushes a one-line system message
right before `setMessages(() => messages)` after `/resume` finishes —
info on reachable, warning on unreachable, silent on `unknown` /
disabled / no snapshots. 11 vitest cases (6 helper + 5 hint).

### 6B — Cross-worktree resume reachability ✅ landed

**Problem.** Two absolute paths to the same git repo (e.g.
`~/proj/main` and `/tmp/build/proj`) hash to different `<hash16>` →
different refs → user resumes a session captured in path A while sitting
in path B and the snapshot ref isn't reachable.

**Approach (smallest fix).** When `findReachableSnapshot` (6A) doesn't
find the hash under the current project's ref, scan all `projects/*.json`
and try `git rev-parse <hash>` against each ref tip's history. If found,
inform the user the hash exists but under a different worktree.

**Shipped.** `Reachability` switched from string union to discriminated
union; new `'reachable-other-worktree'` branch carries the foreign
`workdir`. Scan walks `projects/*.json` capped at 50 most-recently-touched
candidates. `computeResumeRewindHint` adds a fourth branch — warning
naming the foreign workdir so the user knows where to `cd`. 13 vitest
cases (7 helper + 6 hint) pin the new contract.

### 6C — Cross-worktree GC reachability

**Problem.** `/rewind` to `<hash>` from a resumed session works only if
`<hash>` is reachable from *some* current ref. Once orphan-prune drops
the source worktree's ref, the hash becomes unreachable across every
worktree (single object DB, no anchoring ref).

**Approach.** Two options on the table:

- **C1 (preferred)**: Before orphan-pruning a project ref, scan the
  active sessions index (`projects/<hash16>.json` last_touch within last
  N days) for any pinned `gitHash`es from that ref's history; if found,
  rewrite a `refs/axiomate/_keep/<sessionId>` ref to anchor them.
- **C2 (fallback)**: Skip 6C entirely and document the failure mode in
  `/checkpoints status` ("X snapshots from session Y are no longer
  reachable; will be GC'd next prune"). User-facing only.

**Cost.** C1 is ~1 day with tests; C2 is 1 hour. Recommendation: ship
**C2 now, defer C1 until a user reports the loss**. Hermes ran with the
same hole for 2 years uneventfully.

**6C2 ✅ landed.** `/checkpoints status` now appends a one-line warning
when any registered project's workdir no longer exists on disk and
still has commits anchored under `refs/axiomate/<hash>`: *"N snapshots
from K orphan workdirs will be discarded on next prune."* Aggregated by
total commit count + orphan-workdir count rather than per-session, since
the status view is keyed on project ref, not session — surfaces the
right signal (the next prune will drop these) without a session-storage
scan. 4 new test cases in `commands/checkpoints/__tests__/views.test.ts`.

### 6D — Test gaps T1 / T2 / T5

| ID | Gap | Approach |
|---|---|---|
| T1 | `bytesFreed > 0` only asserted `>= 0` due to tmpfs noise | Add a fixed-content snapshot harness: write N bytes of random data, snapshot, prune to 0, assert `bytesFreed >= N`. ~half day. |
| T2 | Concurrent prune (two processes, marker race) | Use `child_process.spawn` to fork two prune workers → assert `.last_prune` ends in a consistent state, no double-gc. ~half day. |
| T5 | `createSnapshot` race + transient injection | Stub `runCheckpointGit` to inject `EBUSY` and code-not-in-{0,128} on `rev-parse` → assert fail-open. ~half day. |

### 6E — Observability

**Problem.** Plan promised "snapshot p50/p95 latency, prune frequency,
failures" telemetry. None landed.

**Approach (minimum viable).**
- Add `axiomate.checkpoints.snapshot.duration_ms` to the existing
  `logForDebugging` channel (one line per snapshot) — already structured,
  already grep-able.
- Surface aggregate in `/checkpoints status`: rolling p50/p95 of the
  last 100 snapshots, rolling failure count.
- One test: feed 100 fake durations → assert p50/p95 calc.

**Cost.** ~half a day.

### 6F — Dogfood metrics

**Problem.** Plan said "one-week dogfood: total store size, snapshot
latency, prune frequency, any failures logged". Nobody collected.

**Approach.** Once 6E lands, run `/checkpoints status` weekly for two
weeks; record p50/p95, store size, failure count in the progress doc as
a closing observation. No code work — just discipline.

**Cost.** Nothing now; ~10 minutes per check-in for two weeks.

---

## Suggested ordering

1. **Track 1** (Hermes refs) — purely mechanical, lowest risk, prevents
   further rot. Do first.
2. **Track 2** (v1-compat purge) — clarifies framing for everything
   downstream. Quick.
3. **6E observability** — landing this before 6A/6B/6C means we have
   metrics to evaluate the additions.
4. **6A resume↔rollback union** — the highest user value among the
   remaining gaps.
5. **6C2** (status-line warning) — 1 hour, ship now.
6. **6B cross-worktree resume** — addresses a real but rare case.
7. **6D test gaps** — landing all three together as a "test tightening"
   PR is cleaner than dripping them in.
8. **6F dogfood** — passive; runs while everything else is in flight.
9. **6C1** (anchor-ref keep) — defer until user reports a loss.

Estimated total: **3-4 working days** plus the passive dogfood window.

---

## Risks

| Risk | Mitigation |
|---|---|
| Track 1 mechanical pass introduces typos in comments | Edit-only; no code change. tsc + tests still gate. |
| 6A surfacing "rewind available" creates expectation that `/rewind` always works post-resume | Wording: "if still rewindable" — and 6C2 status-line warning gives the user a way to see when it's not. |
| 6B's all-projects scan slows resume on users with hundreds of projects | Cap scan at 50 projects ranked by `last_touch`. |
| 6E's percentile calc on 100 samples is statistically thin | Document as "rolling sample"; don't oversell as SLO. |
| Deferring 6C1 leaves a real reachability hole | Hermes has run with this hole 2 years; ship C2 (visibility) and revisit on report. |

---

## Out of scope (genuinely)

- Cross-machine snapshot sharing
- Snapshot encryption-at-rest
- Per-snapshot signing
- A `checkpoints export` / `import` flow
- Snapshot retention policies beyond `retentionDays` + `maxTotalSizeMb`

These weren't in Hermes either; lifting them would be a new feature, not
completion of the port.
