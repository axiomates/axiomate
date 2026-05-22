# Hermes ↔ Axiomate Checkpoints Audit

**Cutoff**:
- Axiomate commit `7351eedc` (2026-05-22)
- Hermes HEAD `edb2d910` (2026-05-20, *not* a checkpoint commit)
- Hermes last checkpoint-touching commit `2ec8d2b4` (2026-05-11, ruff auto-fix
  on `tools/checkpoint_manager.py`)
- Hermes `tools/checkpoint_manager.py` ~1638 lines
- Hermes path on disk: `C:\public\workspace\hermes-agent`

Hermes ships fast (often hundreds of commits/day across the repo), so the
checkpoint subsystem itself can shift weekly even when the audit cutoff
above looks fresh. Re-run `git -C C:\public\workspace\hermes-agent log
--since=2026-05-11 -- tools/checkpoint_manager.py hermes_cli/checkpoints.py`
to see what has changed since this audit and whether any of it warrants
re-categorizing items in section C.

This audit compares the production checkpoint system in Hermes against axiomate's port, categorizing the differences into absorbed features, deliberate divergences, and real gaps that warrant a decision.

---

## A — Already absorbed

✓ **Orphan/stale/size-cap prune passes** — three passes in order, same logic. Orphan drops refs whose workdir vanished; stale drops refs older than retention window; size-cap round-robins oldest commits per ref until under cap or no progress.

✓ **Per-project ring-buffer prune** — max 100 snapshots per project ref, oldest commits dropped when exceeded. Happens inside `createSnapshot` step 12.

✓ **24-hour auto-prune throttle** — `.last_prune` marker prevents repeated runs within 24h. `forceNow` flag bypasses for CLI.

✓ **Unconditional intermediate + final gc** — `git reflog expire --expire=now --all` + `git gc --prune=now --quiet` run after orphan/stale passes and at end of size-cap.

✓ **Per-project metadata tracking** — `projects/<hash16>.json` with `workdir`, `created_at`, `last_touch`. Touched on every snapshot (even skipped ones) for orphan detection.

✓ **File-count guard via fs walk** — abort snapshot if workdir exceeds 50k files. Axiomate honors `.gitignore` during walk (stricter than Hermes' raw `rglob`).

✓ **Oversize file drop** — files >10 MB removed from index before commit via `git rm --cached` in 200-file chunks.

✓ **No-changes detection** — skip empty commits via `git diff-index --cached` against ref tip.

✓ **Commit-tree plumbing** — `write-tree` + `commit-tree` + `update-ref` CAS for atomic ref updates.

✓ **Broad-dir guard** — reject snapshots of `/`, `~`, drive roots.

✓ **Soft-disable on missing git** — probe once per process, cache result, all ops short-circuit to no-op.

✓ **Fail-open contract** — transient errors never throw; logged and skipped, next turn retries.

✓ **Status output** — total size, project count, per-project breakdown (workdir, commit count, last-touch age, live/orphan state).

✓ **Prune report** — orphan/stale/size-cap counters, bytes freed, gc invocation count, error list.

✓ **CLI subcommands** — `status` (default), `list` (alias), `prune`, `clear`.

✓ **Numeric validation on CLI flags** — `--retention-days` and `--max-size-mb` reject non-numeric input with exit 1.

✓ **Bytes/age formatting** — `_fmt_bytes` (B/KB/MB/GB/TB with 1 decimal), `_fmt_age` (Ns/Nm/Nh/Nd ago).

✓ **Workdir canonicalization** — tilde-expand + `path.resolve()` before hashing.

✓ **GIT_CONFIG_GLOBAL muting** — prevents inherited `commit.gpgsign=true` or credential helpers from interfering.

✓ **Per-project index isolation** — `GIT_INDEX_FILE` per project prevents neighboring projects' staged state from leaking.

✓ **Structured commit subjects** — `axiomate:<messageId>:<label>` format, parseable back to structured fields (above Hermes' opaque `reason: str`).

✓ **Cross-worktree reachability scanning** — when a snapshot hash isn't reachable from the current project's ref, scan all other projects' refs to find it (6B).

✓ **Session-referenced commit anchoring** — `refs/axiomate/_keep/<projectHash>/<sessionId>` namespace preserves commits referenced by active sessions before orphan-pruning their source ref (6C1).

✓ **Orphan reachability warning** — `/checkpoints status` surfaces "N snapshots from K orphan workdirs will be discarded on next prune" (6C2).

✓ **Snapshot metrics** — rolling p50/p95 of `ok` snapshot durations, failure/no-changes/skipped counters over last ≤100 snapshots (6E).

✓ **Resume rewind hint** — after `/resume`, REPL surfaces reachability status as a system message (6A).

---

## B — Deliberately not absorbed

| Hermes feature | Reason axiomate skipped | Where documented |
|---|---|---|
| `clear_legacy` subcommand | Axiomate has no v1 store to migrate. Pre-Phase-3 file-copy backend was unreleased internal scaffolding. | `docs/checkpoints-v2-completion-plan.md` |
| Legacy archive cleanup on startup | No v1 archives exist on any real axiomate install. | `docs/checkpoints-v2-progress.md:309` |
| `legacy_size_bytes` / `legacy_archives` fields in status output | Dropped from `StoreStatusReport` schema. | `agent/src/utils/checkpoints/storeStatus.ts:8-13` |
| Cross-machine snapshot sharing | Out of scope. Hermes has no equivalent either. | `docs/checkpoints-v2-completion-plan.md` |
| Snapshot encryption-at-rest | Out of scope. | Same |
| Per-snapshot signing | Out of scope. | Same |
| `checkpoints export` / `import` flow | Out of scope. | Same |
| Snapshot retention policies beyond `retentionDays` + `maxTotalSizeMb` | Out of scope. | Same |

---

## C — Real gaps that warrant a decision

### 1. CLI `--rows` flag on `status` / `list` ✅ landed (2026-05-22)

**What Hermes does** (`hermes_cli/checkpoints.py::cmd_status` line 206-207): accepts `--limit` (int, default 20) to cap the per-project breakdown rows printed.

**What axiomate does now**: a new `globalConfig.checkpointsStatusRows: number` (default 20, range 1..500) sets the persistent default, surfaced as a Settings UI row (preset cycle: 10/20/50/100/200/500) and writeable via `/config checkpointsStatusRows N`. Both the CLI subcommands (`axiomate checkpoints status --rows N`, `axiomate checkpoints list --rows N`) and the slash command (`/checkpoints status --rows N`, `/checkpoints list --rows N`) accept a per-call override that beats the config. Resolution happens in `commands/checkpoints/resolveStatusRows.ts` with priority `flag > config > 20`; out-of-range or non-integer config values fall back to 20 to defend against hand-edited `~/.axiomate.json`.

**Why we renamed `--limit` → `--rows`**: `--limit` is overloaded across CLIs (queries, rate limits, time windows). `--rows` is concrete and matches what the flag actually controls — the row count of the rendered table.

**Test coverage**: `resolveStatusRows.test.ts` 9 cases (precedence + clamping); `parseSub.test.ts` 15 cases (slash subcommand parser + `parseRowsToken`); 5 new cases in `cli/handlers/__tests__/checkpoints.test.ts` covering range validation and end-to-end plumbing.

---

### 2. Hermes' `--keep-orphans` flag on `prune` ✅ landed (2026-05-22)

**What Hermes does** (`hermes_cli/checkpoints.py::cmd_prune` line 226-227): `--keep-orphans` action="store_true" skips the orphan pass entirely.

**What axiomate does now**: `pruneCheckpoints({ keepOrphans: true })` short-circuits the orphan branch before anchor/drop. CLI exposes `axiomate checkpoints prune --keep-orphans`; slash command exposes `/checkpoints prune --keep-orphans`. Skipped orphans surface as `Orphan refs skipped: N` in the prune output (line hidden when zero).

**Why we shipped it after originally deferring**: the safety valve is cheap (~30 lines incl. CLI plumbing) and the use case is concrete — temporarily-disconnected external drives, in-flight workdir renames, planned re-clones. Better to land the lever than wait for the user incident.

**Test coverage**: `prune.keepOrphans.test.ts` 3 cases (skip orphan + follow-up drops; stale unaffected; default unchanged) + 1 CLI handler plumbing test + 2 view tests for the conditional output line.

---

### 3. Hermes' `delete_orphans` parameter in `prune_checkpoints` function ✅ landed (2026-05-22)

**What Hermes does** (`tools/checkpoint_manager.py::prune_checkpoints` line 1223): accepts `delete_orphans: bool` parameter (default True) to gate the orphan pass.

**What axiomate does now**: `PruneOptions.keepOrphans?: boolean` (default `false`, i.e. drop orphans — same default as Hermes' `delete_orphans=True`). Landed together with #2 since they're the same lever at two layers.

---

### 4. Hermes' `_fmt_bytes` edge case: very small numbers

**What Hermes does** (`hermes_cli/checkpoints.py::_fmt_bytes` line 31-40): returns `"0 B"` for 0, `"1 B"` for 1, etc. (integer format for bytes). For KB and above, uses 1 decimal place.

**What axiomate does** (`agent/src/commands/checkpoints/format.ts`): delegates to `formatFileSize` from `utils/format.ts:9`, which may have different rounding/pluralization rules.

**Why this might matter**: cosmetic — output formatting differs slightly. Hermes prints `"1 B"`, axiomate might print `"1B"` (no space).

**Recommendation**: **Drop**. Axiomate's house style is no space (consistent with rest of codebase). Not worth a divergence fix.

---

### 5. Hermes' `_dir_file_count` counts files AND directories

**What Hermes does** (`tools/checkpoint_manager.py::_dir_file_count` line 515-525): `Path.rglob('*')` yields both files and directories; `count += 1` for each.

**What axiomate does** (`agent/src/utils/checkpoints/countFiles.ts` line 89-96): counts files only (`!entry.isDirectory()`). Directories are traversed but not counted.

**Why this might matter**: effective `MAX_FILES` threshold is higher in axiomate. Axiomate's behavior is intentional — we cap what `git add -A` actually pays for, not the directory tree structure.

**Recommendation**: **Drop**. Already documented in `countFiles.ts` JSDoc as intentional. Axiomate's approach is better. No change needed.

---

### 6. Hermes' `_enforce_size_cap` called per-snapshot

**What Hermes does** (`tools/checkpoint_manager.py::_take` line 970): calls `_enforce_size_cap` inside every `_take` (snapshot creation), touching every ref and every commit per project on every turn.

**What axiomate does**: size-cap pass is deferred to Phase 4 startup hook (`pruneCheckpoints`), not run on every snapshot.

**Why this might matter**: Hermes pays O(P × C) cost per snapshot (P = project count, C = commits per project). Axiomate pays it once per boot.

**Recommendation**: **Drop**. Axiomate's deferral is intentional (Decision #19 in progress doc). Per-project ring buffer + cross-project size cap keep the hot snapshot path predictable. Already documented. No change needed.

---

### 7. Hermes' `maybe_auto_prune_checkpoints` integration point

**What Hermes does** (`tools/checkpoint_manager.py::maybe_auto_prune_checkpoints` line 1462-1526): called from a startup hook, checks the 24h marker, calls `prune_checkpoints` if needed.

**What axiomate does** (`agent/src/utils/backgroundHousekeeping.ts`): `pruneCheckpoints` is called from `runVerySlowOps`, which gates on user idle ≥1 minute + ≥10 minutes after boot.

**Why this might matter**: timing differs. Hermes runs on every boot (subject to 24h marker). Axiomate runs once the user has been idle for a minute, and not before 10 minutes after boot. Axiomate's approach avoids blocking REPL TTFR.

**Recommendation**: **Drop**. Axiomate's integration is intentional (Decision #17 in progress doc). Better UX (no boot-time latency). Already documented. No change needed.

---

### 8. Hermes' `_run_git` error classification

**What Hermes does** (`tools/checkpoint_manager.py::_run_git` line 273-316): returns `(ok: bool, stdout: str, stderr: str)`. Exit code 0 → `ok=True`; non-zero → `ok=False`. Allowed exit codes are checked but don't flip `ok` to True.

**What axiomate does** (`agent/src/utils/checkpoints/git.ts::runCheckpointGit`): if the exit code is in `allowedExitCodes`, `ok` is promoted to `True`.

**Why this might matter**: ergonomic divergence. Axiomate's approach reduces boilerplate at call sites.

**Recommendation**: **Drop**. Axiomate's approach is an intentional improvement. Already documented in `git.ts:75` JSDoc. No change needed.

---

## Recommendations summary

**Status as of 2026-05-22 (post-rows):**

1. ✅ **`--rows` flag on CLI `status` / `list`** (renamed from Hermes' `--limit`) — landed. Includes a persistent `globalConfig.checkpointsStatusRows` plus Settings UI row and `/config` integration.
2. ✅ **`--keep-orphans` flag on `prune`** — landed.
3. ✅ **`delete_orphans` function parameter (`PruneOptions.keepOrphans`)** — landed with #2.
4. **No action needed on formatting, edge cases, or architectural choices** — axiomate's `formatBytes`, `countFiles`, size-cap deferral, and integration point are all intentional improvements or documented divergences.

**Full Hermes-parity slate from this audit is now closed.** Re-run the `git log --since=...` recipe at the top of the doc when revisiting Hermes upstream.
