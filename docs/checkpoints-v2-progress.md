# Axiomate Checkpoints v2 — Implementation Progress

> Long-running task. **Resume by reading "Immediate next action" below.**

- **Plan (full design + decisions)**: `C:\Users\kiro\.claude\plans\typed-discovering-brook.md`
- **Reference implementation**: `C:\public\workspace\hermes-agent\tools\checkpoint_manager.py` + `C:\public\workspace\hermes-agent\hermes_cli\checkpoints.py`
- **Started**: 2026-05-20

---

## Immediate next action

→ **Phase 5 in progress (step 2 done)**: `storeStatus` + `clearAll` helpers ported from Hermes, with anchor + behavior tests. Step 3 (`/checkpoints` slash command) is next; tasks #69–#71 pending. Step-by-step plan in section "Phase 5 implementation plan" below.

Phase 5 step 3 design lock-in (2026-05-21):
- `/checkpoints list` is **read-only**. Hermes' CLI list is also read-only (`hermes_cli/checkpoints.py:106-108` aliases `cmd_list = cmd_status`). The interactive selector that picks a snapshot and rolls the worktree back already exists in axiomate as `/rewind` — it operates on the in-session `appState.fileHistory.snapshots` array (REPL.tsx:4007-4013) and would desync if a slash command rewound at the store level. So `/checkpoints list` shows the store-level commit list with reasons; users wanting to actually roll back are pointed at `/rewind`.
- One `local-jsx` command, sub-arg dispatch — same shape as `commands/sandbox-toggle/sandbox-toggle.tsx`. `status`/`list`/`prune` render static text views; `clear` renders a `Dialog` + `Select` confirm.

Phase 5 step 2 (2026-05-21):
- New `agent/src/utils/checkpoints/storeStatus.ts` — read-only summary backing `/checkpoints` and CLI `status`. Port of Hermes `store_status` (`tools/checkpoint_manager.py:1533-1597`). Divergence: drops `legacy_size_bytes` / `legacy_archives` fields; axiomate has no v1, see "`clear-legacy` is NOT ported".
- New `agent/src/utils/checkpoints/clearAll.ts` — destructive helper backing `/checkpoints clear`. Port of Hermes `clear_all` (1600-1616). Adds `errors[]` to the report so the UI can surface the reason if `rm` partially fails (Windows AV/locked file). Hermes silently swallows.
- Refactor: `loadProjectMetas` extracted from `prune.ts` into shared `agent/src/utils/checkpoints/projectMetas.ts` so `prune` and `storeStatus` read `projects/<hash16>.json` through the same code path.
- `dirSizeBytes` exported from `prune.ts` (was unexported) so `storeStatus` and `clearAll` reuse it.
- 7 storeStatus + 5 clearAll tests added. Tests 1349/1349 passing. `tsc --noEmit` clean.

Phase 1-4 audit follow-up (2026-05-21): the codebase had three places carrying Hermes-style "pre-Phase-3 file-copy backend" framing. axiomate has no v1 release, so no real user can have any legacy file-copy directory. Fixed: (F1) `fileHistory.ts` `droppedLegacy` filter reframed as defensive malformed-entry skip, log+counter dropped; (F2) `__tests__/fileHistory.test.ts` T6 deleted (premise was false); (F3) `cleanup.ts` `cleanupOldFileHistoryBackups()` deleted entirely along with its caller. JSDoc tightened in `fileHistory.ts:15-30, 128-133` and `store.ts:10-19`.

Phase 1 done (2026-05-20):
- 4 source files: `paths.ts` (with `DEFAULT_EXCLUDES` covering VS C++/C#, Python, JS/Bun, Rust, Java, iOS, Android), `validate.ts` (commit-hash + path-traversal guards), `gitEnv.ts` (GIT_DIR/WORK_TREE/INDEX_FILE + mute global/system gitconfig), `git.ts` (typed `runCheckpointGit` wrapper, never throws).
- 3 test files: 44/44 passing in 2.4s. `tsc --noEmit` clean.
- Honest scope: Phase 1 tests are pure-function (env composition, validation, paths). Real git-spawn behavior is exercised end-to-end in Phase 2 against a real on-disk store.

Phase 1 follow-up #1 (2026-05-21, after Hermes deep-read):
- Added `normalizePath(value)` to `paths.ts` — direct port of Hermes' `_normalize_path` (`tools/checkpoint_manager.py:193-195`). Tilde-expand (`~`, `~/foo`, `~\foo`) + `path.resolve()`. **This is the canonical workdir hygiene function**; Phase 2 store API routes every workdir-shaped input through it before hashing/comparing/persisting.
- `validateRelativePath` now calls `normalizePath` on its `workingDir` arg, matching Hermes' `_validate_file_path:180`.
- Added `infoExcludePath()` helper to `paths.ts` (Phase 2 will write `info/exclude` here).
- Added `GIT_TERMINAL_PROMPT=0` to both `checkpointGitEnv` and `checkpointInitEnv` — defense in depth against auth/askpass hangs. **Hermes does not set this**; we go one step further than parity here, costing one line.
- Documented `projectHash` JSDoc contract: function stays pure, callers canonicalize via `normalizePath`. Test asserts noisy/clean inputs produce different hashes (so silent-canonicalization can't sneak in later); paired test asserts `projectHash(normalizePath(noisy))` equals `projectHash(normalizePath(clean))` so the layered approach actually delivers dedup.
- Tests 55/55 passing. `tsc --noEmit` clean.

Phase 1 follow-up #2 (2026-05-21, second-pass review of `_run_git`):
- `runCheckpointGit` now pre-flights `workTree`: must exist, must be a directory. Returns typed `spawn-error` with `working directory not found` / `not a directory` message — better diagnostics than letting git fail with "fatal: not a git repository". Mirrors Hermes `_run_git:287-295`. Catches the case where workdir was deleted between calls (`rm -rf` from BashTool against agent's own cwd).
- Switched from `execFileNoThrow(useCwd: false)` to `execFileNoThrowWithCwd(cwd: workTree)` for non-init invocations. **Aligns cwd with `GIT_WORK_TREE`** so cwd-relative git operations (some hooks, plumbing edge cases) see the same directory the env points at. Mirrors Hermes `_run_git:307`. Init still passes `cwd: undefined` (operates on bare store, parent cwd irrelevant).
- New `git.test.ts` (3 tests): missing-workdir, regular-file-as-workdir, fail-open contract on bogus paths.
- Tests now 58/58 passing. `tsc --noEmit` clean.

Phase 0 review answers (locked):
- Snapshot only state affecting agent continuity; exclude build artifacts and dependency locks. Specifically include `agent/.axiomate/settings.local.json` (anchored `/.axiomate/` exclusion). Cargo.lock kept (binary-crate reproducibility).
- Defaults `retentionDays = 14`, `maxTotalSizeMb = 500`. Match Hermes.
- Phase sequencing 1→2→3→4→5 confirmed.
- User `.gitignore` honored automatically (`git add -A` default behavior); global gitconfig muted by `GIT_CONFIG_GLOBAL=/dev/null`.

---

## Phase tracker

| # | Phase | Status | Output |
|---|-------|--------|--------|
| 0 | Design memo | ✅ done | `docs/checkpoints-v2-design.md` |
| 1 | Git isolation primitives | ✅ done | `agent/src/utils/checkpoints/{gitEnv,git,validate,paths}.ts` + tests (44 passing) |
| 2 | Store API (snapshot / list / rollback) | ✅ done | `agent/src/utils/checkpoints/store.ts`, `createSnapshot.ts`, `listSnapshots.ts`, `rollback.ts` + tests |
| 3 | Backend swap behind fileHistory.ts (load-bearing) | ✅ done | `8b45c627` swap; `8377acab` + `a4bf49d2` Phase 3.1 review cleanup |
| 4 | Auto-prune (orphan / stale + size-cap + gc) | ✅ done | `agent/src/utils/checkpoints/prune.ts` + tests; commits `c972dbaa` (skel), `feat(checkpoints): orphan + stale passes`, `16e5fa21` (size cap), `5569f631` (housekeeping wire) |
| 5 | `/checkpoints` slash + CLI subcommand | ⬜ | `agent/src/commands/checkpoints/*` + main.tsx wiring |
| 6 | Out of scope (placeholder) | — | resume↔rollback union, file-copy migration |

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked

---

## Decisions already locked (don't re-litigate)

1. **Granularity**: turn-level, keyed by `messageId`. `fileHistory.ts:189` already does this.
2. **Config**: reuse existing `fileCheckpointingEnabled` global config + `AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING` env. **No new flag.**
3. **Missing git** (Hermes-style soft-disable, not hard-exit): probe `gitExe()` lazily; if absent, set internal `_gitAvailable=false`, log `Checkpoints disabled: git not found` at debug level once, all checkpoint ops short-circuit to no-op. Agent boots and runs normally. `/checkpoints` surfaces the disabled state with an install hint.
4. **Do not touch the existing Windows `findGitBashPath()` hard-exit** at `utils/windowsPaths.ts:98-125`. That's BashTool's POSIX-shell requirement (grep/sed/find/cat), not ours. Leave it alone.
5. **Spawn pattern**: direct `execFileNoThrow(gitExe(), [...])` with array args — never via shell. Same pattern as `context.ts:50` and `hooks/fileSuggestions.ts:267`.
6. **Storage root**: `~/.axiomate/checkpoints/store/`. Sibling to existing `shell-snapshots/`, `plans/`, `debug/`, `teams/`, `projects/`. Verified clean — no collision.
7. **Backend swap, not parallel layer**: keep all six exported `fileHistory*` functions; swap implementation below `recordFileHistorySnapshot()`. **Zero call-site changes** in `FileEditTool`, `FileWriteTool`, `BashTool`, `NotebookEditTool`, `QueryEngine`, `REPL`, `cli/print`, `handlePromptSubmit`.
8. **Cross-session shared store**: single repo, per-project `refs/axiomate/<sha256(absWorkdir).slice(0,16)>` + per-project `indexes/<hash16>` + `projects/<hash16>.json`. Git's content-addressable object DB does dedup for free. This is the whole point of v2 vs v1.
9. **Old file-copy backups**: read-only compat, no force-migration. They age out via existing session GC.
10. **`/rewind` UX**: untouched.
11. **Fail-open**: snapshot failure (transient: AV scan / EBUSY / timeout) never blocks tool execution. Skip the snapshot for that turn, log via `logForDebugging`, next turn retries fresh.
12. **Phase 2 test isolation = env override on `getCheckpointBase()`** (Decision 1A, 2026-05-21). Tests set `AXIOMATE_CHECKPOINT_BASE` (paths.ts honors it) to a tmpdir in `beforeAll`. No DI thread-through, no surprise contamination of real `~/.axiomate/checkpoints/`. Mirrors Hermes' `CHECKPOINT_BASE` override pattern. Production path unchanged when env unset.
13. **File-count guard via pre-stage fs walk** (Decision 2A, 2026-05-21). Walk workdir respecting `DEFAULT_EXCLUDES` + `.gitignore`, abort once count > `MAX_FILES`. Matches Hermes `_dir_file_count` (515-525). Avoids paying `git add -A` cost on a 100k-file monorepo before bailing.
14. **Commit message shape: typed `{messageId, label}`** (Decision 3B, 2026-05-21). `createSnapshot(workdir, { messageId, label })` builds canonical subject `axiomate:<messageId>:<label>`; `listSnapshots` parses it back into structured `{ messageId, label }` fields. Above-Hermes-parity (Hermes uses opaque `reason: str = "auto"` and pays for it with regex parsing in `format_checkpoint_list`). Beneficiaries:
    - **Phase 5 `/checkpoints list` UI** correlates entries with conversation-history messages by `messageId` rather than free-form regex over the subject.
    - **Round-trip tests** assert structured fields (`reason.messageId === passedId`) instead of brittle string equality.
    - **Phase 6 resume↔rollback union** can `find(snap => snap.messageId === targetMsg)` without scanning `projects/<hash16>.json` or stuffing `messageId` into a side index.
    - Cost: ~5 lines (one parser, one formatter), centralized so the format can evolve without rewriting consumers.
15. **`probeGitAvailable` lives in `git.ts`, cached forever per process** (Decision 4A, 2026-05-21). Sits next to `runCheckpointGit` since it's a git-spawning concern. One probe per process (mid-session git installs require restart — rare scenario, accepted). Matches Hermes `_git_available` pattern. Lets `store.ts` *and* any future probe-before-init guard reuse the same cache without circular imports.
16. **Persisted snapshot trackedFiles is delta, folded on read** (Decision 5B, 2026-05-21, supersedes the Phase 3.1 "stays cumulative" version). Each `file-history-snapshot` JSONL entry carries `addedTrackedFiles: string[]` — only paths newly registered since the prior snapshot (`makeSnapshot` emits `[]`; `trackEdit` appends in-turn). `fileHistoryRestoreStateFromLog` folds chronologically. Disk usage is **O(M)** total instead of O(K×M). Invariant: union of all snapshots' `addedTrackedFiles` equals the cumulative `state.trackedFiles` set. **Earlier reasoning was wrong**: I claimed delta-fold would break the messageId-keyed map last-write-wins reader at `sessionStorage.ts:3269`. It does not — that reader operates on per-messageId entry replacement (still last-write-wins on `addedTrackedFiles`); fold happens in the consumer (`fileHistoryRestoreStateFromLog`), which is a different layer. Implementation cost was ~10 lines + zero test changes. Standard event-sourcing / G-Set CRDT pattern.

---

## Phase 2 spec — store.ts (locked from Hermes deep-read 2026-05-20)

Hermes refs use `tools/checkpoint_manager.py` line numbers throughout. The TS port should preserve these behaviors verbatim unless explicitly noted.

### Module-level constants

```ts
const MAX_FILES = 50_000              // working-dir file count cap (Hermes _MAX_FILES)
const MAX_FILE_SIZE_MB = 10           // per-file size cap, configurable later
const MAX_SNAPSHOTS = 100             // per-project ring buffer (port from existing fileHistory cap)
const RM_CACHED_BATCH = 200           // chunk size for `git rm --cached` (Hermes 1011-1018)
const COMMIT_SUBJECT_PREFIX = 'axiomate'  // structured subject: axiomate:<messageId>:<label> (Decision #14)
```

### `probeGitAvailable(): Promise<boolean>` (lives in `git.ts`, not `store.ts` — Decision #15)

- Module-level cached result (`_gitAvailable: boolean | null`) in `git.ts`. Set once, never re-probed. Re-exported through `store.ts` so callers in either layer see the same cache.
- Implementation: dedicated probe — `execFileNoThrow(gitExe(), ['--version'], { timeout: 5000, useCwd: false })`. Bypass `runCheckpointGit` because it requires real `store` + `workTree` paths and pre-flights the worktree, neither of which exists at probe time.
- On `ENOENT` / non-zero / timeout → cache `false`, log `Checkpoints disabled: git not found` once at debug level (Hermes 632-637).

### `ensureStore(): Promise<{ store: string }>`

Idempotent. Order matters.

1. `mkdir -p ~/.axiomate/checkpoints/store/indexes` and `…/projects` (Hermes 407-410).
2. **Idempotency check**: if `<store>/HEAD` exists, return early (Hermes 404-405).
3. `runCheckpointGitInit(['init', '--bare', store], { store })` — note `init --bare` rejects `GIT_WORK_TREE`, so use the init-env variant from Phase 1.
4. Set repo-local config via four separate `runCheckpointGit(['config', K, V], …)` calls (Hermes 412-440):
   - `user.email = axiomate@local`
   - `user.name = Axiomate Checkpoint`
   - `commit.gpgsign = false` ← critical
   - `tag.gpgSign = false`
   - `gc.auto = 0` ← we drive gc manually in Phase 4
5. Write `<store>/info/exclude` from `DEFAULT_EXCLUDES` via `infoExcludePath()` **on first init only** (this whole step lives inside the post-`git init --bare` branch; subsequent `ensureStore` calls early-return at step 2). Matches Hermes (line 445-447 also runs only inside `_init_store`). User edits to `info/exclude` are therefore preserved — if we ever want to roll out new excludes we'll need a versioned bump.
6. **Skip the legacy-archive step** (Hermes 339-384). Axiomate has no v1 store to migrate; we keep file-copy backups read-only via existing session GC. (Decision #9.)

### `createSnapshot(workdir, message): Promise<{ hash } | { skipped: reason }>`

This is the load-bearing function. **Twelve** steps, in order. Step 4 (`_touchProject`) runs *before* the file-count guard so even skipped snapshots register the project — matches Hermes' `_take` (line 849 vs 852).

**Signature** (Decision #14):
```ts
function createSnapshot(
  workdir: string,
  reason: { messageId: string; label: string },
): Promise<CreateSnapshotResult>
```
Internal helper `formatCommitSubject({messageId, label}) = \`axiomate:${messageId}:${label.replace(/[\r\n]/g, ' ')}\`` — newlines stripped (git subject is single-line). Inverse parser in `listSnapshots`.

1. **Soft-disable**: if `!await probeGitAvailable()` → `{ skipped: 'git-missing' }`.
2. **Broad-dir guard**: skip if `workdir` is `/`, `~`, `C:\`, drive root (Hermes 643-648). Return `{ skipped: 'workdir-too-broad' }`.
3. **Per-turn dedup**: caller's responsibility — `fileHistory.ts:189` already keys on `messageId`. We don't reimplement Hermes' `_checkpointed_dirs` set.
4. **Touch project metadata** (Hermes `_touch_project` 849, called *before* file-count guard so even skipped snapshots register the project): write `projects/<hash16>.json` `last_touch = now`, preserve `created_at` if present. **Type guard** (Hermes test `test_non_dict_meta_does_not_raise`): if parsed value is not a plain object, treat as missing. Direct write (no temp+rename — Hermes accepts the corruption risk). Wrap in try/catch; failure logged at debug, snapshot continues.
5. **File-count guard** via fs walk (Decision #13): walk workdir respecting `DEFAULT_EXCLUDES` + `.gitignore` (read once into a `Minimatch` set), abort the walk once count > `MAX_FILES`. If exceeded → `{ skipped: 'too-many-files' }` (Hermes 852-854). Walk is breadth-first with early-abort so the cost is bounded by `MAX_FILES + 1` `readdir` calls, not the full tree.
6. **Set up per-project state**: `hash16 = projectHash(normalizePath(workdir))`; `indexFile = indexPath(hash16)`; `ref = refName(hash16)`. **Canonicalization happens at this boundary** via the Phase-1 `normalizePath` helper (tilde-expand + resolve). `projectHash` itself stays pure.
7. **Seed the index** (Hermes 863-884):
   - `git rev-parse --verify <ref>^{commit}` with `allowedExitCodes: {128}` to detect "ref doesn't exist yet" (`hasRef = ok && stdout.trim() !== ''`).
   - If `hasRef`: `git read-tree <refCommit>` so subsequent `diff-index` only shows real deltas.
   - If `!hasRef`: delete the stale index file if present, let `git add -A` create fresh.
8. **Stage**: `git add -A` with `timeoutMs: DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS * 2` (Hermes 890-896 uses 2× timeout for staging large trees).
9. **Drop oversize files** (`_dropOversizeFromIndex`, Hermes 974-1018):
   - `git ls-files --cached -z` — NUL-separated for spaces/special chars. Parse on `\0`.
   - For each path, `fs.stat(join(workdir, path))`, collect those over `MAX_FILE_SIZE_MB * 1024 * 1024`.
   - If non-empty: chunk into `RM_CACHED_BATCH=200` and call `git rm --cached --quiet -- <paths>` per chunk.
   - Log dropped count at debug level. Don't surface to caller for now.
10. **No-changes detection** (Hermes 904-930):
    - If `hasRef`: `git diff-index --cached --quiet <refCommit>` with `allowedExitCodes: {1}`. Exit 0 = no changes → `{ skipped: 'no-changes' }`. Exit 1 = changes exist → continue.
    - If `!hasRef`: `git ls-files --cached`. Empty stdout → `{ skipped: 'no-changes' }`. Otherwise continue.
    - **Why `diff-index` against ref, not HEAD**: HEAD on a bare store points at a non-existent branch, so `--cached HEAD` would always show every staged path as new. The ref is the only source of truth.
11. **Commit via plumbing** (Hermes 932-962):
    - `git write-tree` → captures `treeSha` from stdout.
    - `subject = formatCommitSubject(reason)`.
    - `git commit-tree <treeSha> [-p <refCommit>] -m <subject> --no-gpg-sign` → captures `newSha`.
      - `-p` only when `hasRef`. First commit is a root commit (no parent).
      - `--no-gpg-sign` overrides any inherited config — belt-and-suspenders to the muted GIT_CONFIG_GLOBAL.
    - `git update-ref <ref> <newSha> [<oldSha>]` (CAS):
      - If `hasRef`: pass `oldSha` for atomic compare-and-swap (Hermes 956-960). If two snapshots race, the loser fails update-ref and returns `{ skipped: 'race' }`.
      - If `!hasRef`: no third arg, just create the ref.
12. **Per-project ring-buffer prune** (Hermes `_prune` 1020-1084, called from `_take` line 967): if `git rev-list --count <ref> > MAX_SNAPSHOTS` (port from existing fileHistory cap = 100), rewrite the ref to the last N commits via the chain-rebuild dance — `rev-list --reverse` → `commit-tree` chain off `keep[0].tree` → `update-ref` → `reflog expire --expire=now --all` → `gc --prune=now --quiet` (3× timeout). **This belongs in Phase 2, not Phase 4.** It's the per-project ring buffer. Phase 4's prune pass is a different concern (cross-project orphan/stale/size-cap). Without per-project prune here, every project's ref grows linearly forever and Phase 4 can't reclaim because reachable commits aren't candidates for `git gc`.
13. **(Deferred to Phase 4)** Cross-project size-cap (`_enforceSizeCap`, Hermes 1086+ at line 970). Spec **deliberately** moves this out of `createSnapshot`'s critical path. Hermes runs it on every snapshot; we run it once at startup hook (Phase 4) because: (a) it touches every ref across every project, expensive in the hot path; (b) Phase 4 already has equivalent size-cap logic; (c) the worst case (rapid-fire snapshots filling disk between startups) is bounded by the per-project ring buffer in step 12. Documented divergence, not oversight.

**Return type**:

```ts
type CreateSnapshotResult =
  | { ok: true; hash: string; ref: string }
  | { ok: false; skipped:
      | 'git-missing' | 'workdir-too-broad' | 'too-many-files'
      | 'no-changes' | 'race' | 'transient-error'; message?: string }
```

**Fail-open contract**: every git step that fails for transient reasons (timeout, EBUSY, AV scan, race) maps to `{ ok: false, skipped: 'transient-error', message }` and is logged via `logForDebugging`. Never throw. Call site (`fileHistory.ts`) treats any non-`ok` result as "no snapshot recorded for this turn, continue with tool execution" (Decision #11).

### `listSnapshots(workdir, limit?): Promise<Snapshot[]>`

(Hermes 657-696.)

```ts
interface Snapshot {
  hash: string         // %H
  shortHash: string    // %h
  timestamp: string    // %aI ISO 8601
  reason: ParsedReason // structured, see below (Decision #14)
}

type ParsedReason =
  | { kind: 'axiomate'; messageId: string; label: string }
  | { kind: 'raw'; subject: string }   // for pre-rollback snapshots, manual writes, or Hermes-style imports
```

- `limit` default = `MAX_SNAPSHOTS` (port from existing fileHistory cap = 100).
- Command: `git log <ref> --format=%H|%h|%aI|%s -n <limit>` with `allowedExitCodes: {128, 129}` (ref may not exist; 129 covers git's "usage error" on malformed refs — Hermes 669).
- If exit 128/129 or empty stdout → return `[]`.
- Parse lines on `|` (3 splits). Reject malformed lines (defensive).
- **Parse `%s` subject**: regex `/^axiomate:([A-Za-z0-9_-]+):(.*)$/`. Match → `{ kind: 'axiomate', messageId, label }`. No match → `{ kind: 'raw', subject }`. Pre-rollback snapshots (`pre-rollback snapshot (restoring to ...)`) deliberately fall through to `kind: 'raw'` — no `messageId` to assign.
- **Skip the diff-shortstat enrichment** Hermes does (lines 688-694). It runs `N` extra git invocations and we don't surface those numbers in the current `/rewind` UX. Add later if Phase 5 `/checkpoints list` needs them.

### `rollback(workdir, hash, paths?): Promise<{ ok: boolean; preRollbackHash?: string; error?: string }>`

(Hermes 761-816.)

1. **Validate** `hash` via `validateCommitHash` — reject invalid before any git call.
2. **Validate paths** if provided: each via `validateRelativePath(path, workdir)`.
3. **Verify hash exists**: `git cat-file -t <hash>` with `allowedExitCodes: {128}`. Non-zero → `{ ok: false, error: 'unknown commit' }`.
4. **Pre-rollback snapshot** (Hermes 787): call `createSnapshot(workdir, { messageId: 'pre-rollback', label: \`restoring to ${hash.slice(0,8)}\` })`. The reserved `messageId: 'pre-rollback'` lets `listSnapshots` consumers identify these without parsing the label. Capture its hash if successful so the user can undo the undo. **Non-optional** — it's the safety net.
5. **Restore**: `git checkout <hash> -- <target>` where `target = paths ?? '.'`. Pass each path as a separate arg (no shell, no glob expansion). **Pass `indexFile = indexPath(hash16)`** (Hermes 796) so checkout updates the per-project index, not a default global one — otherwise the next `createSnapshot` would diff against a contaminated index.
6. **Important**: this updates the working tree only. It does **not** reset `<ref>` — so subsequent `createSnapshot` will diff against the still-newest ref tip and produce a forward commit that "undoes the rollback in the snapshot history." That's intentional: we never lose history, only move the working tree.
7. **Files added since the snapshot but absent from it are left alone** (Hermes behavior). If we ever want "clean restore" semantics, that's a separate flag.

### `currentRef(workdir): Promise<string | null>`

- `git rev-parse --verify <ref>^{commit}` with `allowedExitCodes: {128}`.
- Return trimmed stdout if `ok` and non-empty; `null` otherwise.

### Test plan for Phase 2 (`__tests__/store.test.ts`)

Each test creates a temp workdir under `os.tmpdir()`. `getCheckpointBase()` is redirected to a tmp store via the `AXIOMATE_CHECKPOINT_BASE` env var (Decision #12) — `beforeAll` sets it, `afterAll` clears it. Real git spawned, no mocks of the git binary itself.

**Round-trip**:
- write file → `createSnapshot` → modify file → `rollback` → file content matches snapshot.
- `listSnapshots` returns entries in newest-first order with `reason.kind === 'axiomate'` and matching `messageId`/`label`.
- `currentRef` returns null before first snapshot, the latest hash after.

**Reason parsing** (Decision #14):
- `createSnapshot(workdir, { messageId: 'msg-1', label: 'edit foo.ts' })` → `listSnapshots()[0].reason` is `{ kind: 'axiomate', messageId: 'msg-1', label: 'edit foo.ts' }`.
- A pre-rollback snapshot's reason is `{ kind: 'axiomate', messageId: 'pre-rollback', label: ... }` — discoverable without regex.
- Manually-written commit (subject doesn't match prefix) → `reason.kind === 'raw'`.
- Newlines in label are stripped before commit; round-trip yields single-line label.

**Dedup / sharing**:
- Two workdirs under same store → `git count-objects -v` shows shared blobs when files are identical.
- `projectHash` collisions impossible to test directly; rely on Phase 1 unit test.

**Edge cases**:
- File count > `MAX_FILES` → `{ skipped: 'too-many-files' }`. Synthesize via 100 dirs of 1000 files each.
- Oversize file (>10 MB) is dropped; snapshot succeeds with smaller files only; `git cat-file -p <hash>:big.bin` fails (not in tree).
- No-changes second call → `{ skipped: 'no-changes' }`.
- `rollback('-p')` → rejected by `validateCommitHash`, no git call made.
- `rollback('abc', ['../etc/passwd'])` → rejected by `validateRelativePath`.
- Rollback to unknown hash → `{ ok: false, error: 'unknown commit' }`, working tree untouched.
- Pre-rollback snapshot is created (verify by `listSnapshots` length grows by 2: pre-rollback + previous).

**Per-project ring-buffer prune** (step 12, Hermes `_prune`):
- Create `MAX_SNAPSHOTS + 5` snapshots of changing content.
- Assert `git rev-list --count <ref> === MAX_SNAPSHOTS` post-prune.
- Assert oldest 5 commits are no longer reachable; rollback to one of them returns `{ ok: false, error: 'unknown commit' }`.
- Assert `git fsck` clean post-prune.

**GPG isolation**:
- Set `GIT_CONFIG_GLOBAL` in test process to a fake config containing `[commit]\n    gpgsign = true` → `createSnapshot` still succeeds (env override beats it).

**Idempotency**:
- Call `ensureStore()` twice → second call is a no-op (verify by checking config wasn't reset).

**Soft-disable**:
- Mock `probeGitAvailable` (or use DI on `_gitAvailable`) → all calls return `{ skipped: 'git-missing' }` cleanly, no crash.

**Touch-before-skip** (Hermes ordering):
- Create a directory with > `MAX_FILES` files. Call `createSnapshot`. Assert `projects/<hash16>.json` was written even though the snapshot was skipped — project is registered for prune-pass orphan tracking later.

**Malformed metadata** (Hermes' `test_non_dict_meta_does_not_raise`):
- Pre-write `projects/<hash16>.json` with `[]` → `createSnapshot` succeeds, file gets reset to a valid object.

### Things we deliberately defer past Phase 2

- **Per-snapshot diff stats** (Hermes 688-694) → only if `/checkpoints list` UI needs them.
- **Atomic metadata write** (temp + rename) → only if dogfood shows corruption.
- **Cross-project size-cap** (Hermes `_enforce_size_cap` 1086+, called from `_take` 970) → Phase 4 (startup-hook prune pass). **Documented divergence from Hermes**: Hermes runs it on every snapshot; we don't. Rationale lives in step 13 of `createSnapshot` above.
- **Configurable `MAX_FILE_SIZE_MB`** → for now hard-code 10; expose later if needed.
- **Race retry on `update-ref` CAS failure** → return `{ skipped: 'race' }` for now. Caller can retry next turn.

### What's now *in* Phase 2 that the original spec deferred

- **Per-project ring-buffer prune** (`_prune`, Hermes 1020-1084) — folded back in as step 12 of `createSnapshot`. The original spec's "defer all pruning to Phase 4" was over-simplification; without per-project ring buffer, every project's ref grows linearly forever and Phase 4's cross-project pass can't reclaim because reachable commits aren't `git gc` candidates.

---

## Phase 3 done — backend swap + 3.1 review (2026-05-21)

**Phase 3 (commit `8b45c627`)** swapped fileHistory's storage backend from per-session file copies (`~/.axiomate/file-history/<sid>/<file>@vN`) to one commit per turn in the shared shadow-git store. Public API surface preserved verbatim — `FileEditTool`, `FileWriteTool`, `BashTool`, `NotebookEditTool`, `QueryEngine`, `REPL`, `cli/print`, `handlePromptSubmit` need zero changes. New schema:
```ts
type FileHistorySnapshot = { messageId, gitHash, trackedFiles: readonly string[], timestamp }
```
Old shape (`trackedFileBackups: Record<path, {backupFileName, version}>`) gone, no read-side compat shim. Pre-Phase-3 file-copy directory archived to `file-history.legacy-<ts>/` on first boot via `cleanup.ts`.

**Phase 3.1 review (commits `8377acab` + `a4bf49d2`)** addressed 9 issues raised in post-merge review:

| # | Issue | Resolution |
|---|---|---|
| A1 | `restoreStateFromLog` didn't truncate to MAX_SNAPSHOTS — append-only log could outgrow ring buffer on long resume chains | Cap rebuilt list to MAX_SNAPSHOTS; trackedFiles still unioned over the full log so rewind blast-radius preserved |
| A2 | `maybeShortenFilePath` case-sensitive prefix on Windows — `c:\` vs `C:\` would record same file under two keys | win32 branch lowercase-compares the prefix; relative path keeps tool's original casing |
| B4 | `fileHistoryTrackEdit`'s `_messageId` arg dead post-Phase-3 | Removed from signature; updated 5 call sites (FileEdit, FileWrite, Bash sed-sim, NotebookEdit, tests) |
| B9 | `stats.ts:986` referenced removed `copyFileHistoryForResume` | Reframed comment to describe the actual hazard (embedded nested timestamps) without naming a deleted function |
| C5 | `getDiffStats` ran 3 git invocations | Collapsed to 1 `git diff --numstat` (gives per-file ins/del + path list together); readTree stays for flipped-path detection |
| C6 | Initially flagged `indexFile` as dead in worktree-vs-commit diff | **Reverted with comment**: shared bare store reuses `$GIT_DIR/index` from whichever project last touched it; per-project `GIT_INDEX_FILE` is the isolation boundary even though the diff "doesn't read the index" — without it, neighboring projects pollute results |
| C7 | `fileHistoryTrackEdit` triggered N writes per turn (one per new tracked file); reader takes last-write-wins, so all but the last were wasted IO | Per-messageId latest-pending Map + in-flight latch — N writes collapse to ≤2 round-trips |
| C8 | Per-snapshot cumulative `trackedFiles[]` was O(K×M) on disk | **Reversed Decision 5A → 5B** (decision #16): switched to per-snapshot delta `addedTrackedFiles[]` + fold-on-read. Disk drops to O(M). Standard event-sourcing pattern; ~10 lines of implementation, zero test changes. The original "would break reader semantics" reasoning was wrong — fold happens in the consumer, not the messageId-keyed map reader |
| D3 | Three sites use setter-as-getter (`updater(s => { captured = s; return s })`); fragile if state layer ever becomes async | Documented as a contract in `fileHistory.ts` top-doc rather than refactored. All current consumers honor the synchronous-dispatcher invariant; refactor would change every public signature |

Naming cleanup also folded in: dropped Hermes' "v1/v2" framing from comments across `gitEnv.ts`, `paths.ts`, `store.ts`, `validate.ts`, `cleanup.ts`, `fileHistory.ts`. Hermes had a real production v1; Axiomate's pre-Phase-3 file-copy was unreleased — the v1/v2 dichotomy doesn't apply here. Renamed to neutral terms ("shadow-git checkpoint store", "previous file-copy backend").

Test coverage post-3.1: 1300/1300 passing, including 25 fileHistory behavior tests that survive the backend swap unchanged. Build (`pnpm run build`) clean; bundle 10628 KB.

### Test files now anchoring the new backend

| File | Coverage |
|---|---|
| `agent/src/utils/__tests__/fileHistory.test.ts` | 25 behavior tests: trackEdit, makeSnapshot, rewind, getDiffStats, hasAnyChanges, restoreStateFromLog, MAX_SNAPSHOTS eviction, concurrency latch |
| `agent/src/utils/checkpoints/__tests__/gitEnv.test.ts` | env var composition (NUL on Win32, /dev/null on Unix), GIT_TERMINAL_PROMPT, init vs run env shapes |
| `agent/src/utils/checkpoints/__tests__/paths.test.ts` | normalizePath tilde-expand, projectHash purity (case-sensitive, noisy-vs-clean differs), DEFAULT_EXCLUDES coverage |
| `agent/src/utils/checkpoints/__tests__/validate.test.ts` | hash injection guards (`-p`, `--patch`), path-traversal guards (`../etc/passwd`) |
| `agent/src/utils/checkpoints/__tests__/git.test.ts` | workdir pre-flight (missing / not-a-dir → typed error), fail-open on bogus paths |
| `agent/src/utils/checkpoints/__tests__/store.test.ts` | ensureStore idempotency, GPG-config muting, malformed-metadata recovery |
| `agent/src/utils/checkpoints/__tests__/createSnapshot.test.ts` | round-trip, oversize-file drop, MAX_FILES skip-with-touch, no-changes path |
| `agent/src/utils/checkpoints/__tests__/listSnapshots.test.ts` | ref ordering, limit, empty-ref handling |
| `agent/src/utils/checkpoints/__tests__/rollback.test.ts` | hash + path validation, pre-rollback safety snapshot, unknown-hash error |

---

## Phase 3 architectural review (2026-05-21)

Triggered by user request after Phase 3.1 review fixes landed: "phase 3 modified existing code's architecture, should do a comprehensive review". Walked every existing file Phase 3 touched and verified downstream consumers.

**Files Phase 3 modified (non-checkpoints):**
- `agent/src/utils/fileHistory.ts` — full rewrite (backend swap)
- `agent/src/utils/sessionStorage.ts` — schema additive: `FileHistorySnapshot.gitHash` replaces `trackedFileBackups`; reader at 3268 still keys by messageId
- `agent/src/utils/cleanup.ts` — `cleanupOldFileHistoryBackups` rewritten to archive-rename `~/.axiomate/file-history/` → `file-history.legacy-<ts>/`
- `agent/src/utils/conversationRecovery.ts` — `copyFileHistoryForResume` call removed (dead post-shadow-git)
- `agent/src/screens/REPL.tsx` — same removal
- `agent/src/utils/stats.ts:982` — comment reframed to describe nested-timestamp hazard without naming the deleted helper

**Findings (all four lanes ✅ verified):**

1. **API call sites (8 sites across 4 tools + 2 engines + 2 screens)**: every `fileHistoryTrackEdit` / `fileHistoryMakeSnapshot` / `fileHistoryRewind` / `fileHistoryGetDiffStats` / `fileHistoryHasAnyChanges` / `fileHistoryRestoreStateFromLog` call matches the new signatures. The trackEdit dropped-`messageId` change (B4) propagated cleanly to FileWriteTool, FileEditTool, BashTool (sed-sim path), NotebookEditTool. Confirmed via grep: no orphan call sites.

2. **Schema readers**: `buildFileHistorySnapshotChain` (sessionStorage:1856), `recordFileHistorySnapshot` (1245), `insertFileHistorySnapshot` (940), and the JSONL parse branch (3268) all consume the new `{ messageId, gitHash, trackedFiles, timestamp }` shape. No reader anywhere in the codebase still references `trackedFileBackups` / `FileHistoryBackup` / `backupFileName` (only doc-comment historical mentions remain). Clean break, as intended.

3. **Resume flow without `copyFileHistoryForResume`**: verified the path JSONL → `loadConversationForResume` → `buildFileHistorySnapshotChain` → `useFileHistorySnapshotInit` → `fileHistoryRestoreStateFromLog` is intact. The reason the old physical-copy step is dead: shadow-git is project-keyed by abs path with a shared object DB. Same-cwd resume reads the same ref the prior session wrote. Same-repo-worktree resume (different abs path → different `projectHash` → different ref) still resolves snapshot `gitHash` directly because checkout takes a hash, not a ref — so cross-worktree rewind works as long as the hash is reachable. **Latent risk for Phase 4**: a stale-prune of the original session's ref in a different worktree could orphan the resumed gitHash. Document in Phase 4 spec; not a Phase 3 regression.

4. **Cleanup boot path**: `cleanupOldFileHistoryBackups` is called once from `cleanupOldMessageFilesInBackground` (cleanup.ts:434), itself triggered by the existing background-cleanup hook. It no-ops cleanly when `~/.axiomate/file-history/` doesn't exist (try/catch on `stat`). Archive name `file-history.legacy-<ISO-ts>` cannot collide with the new `~/.axiomate/checkpoints/` (separate sibling). Best-effort error swallowing matches the rest of cleanup.ts.

**Architectural follow-ups (deferred, none blocking):**
- Phase 4 must consider: cross-worktree rewind reachability when source-worktree's ref is pruned. Either (a) keep refs alive across worktrees of the same git repo, or (b) accept that resumed-from-other-worktree rewinds may be lost after retention. Decision deferred to Phase 4 implementation.
- The synchronous-dispatcher invariant (D3) is now contract-bound in `fileHistory.ts` top-doc. If a future state layer becomes async (zustand, redux thunks, etc.), the read-via-identity-updater pattern must be replaced with a separate read API. No refactor needed today.

No code changes from this review — all four lanes pass. Documented here for the Phase 4 author's reference.

---

## Phase 1-3 audit findings (2026-05-21, before Phase 4 implementation)

Read-only audit of Phases 1-3 against `hermes-agent/tools/checkpoint_manager.py`. Five items found; two fixed, three deferred as documented divergences. This section is the single source of truth — if a future reader thinks they've spotted one of these as a bug, the answer is here.

### Fixed (commit `3d9c579c`)

| ID | File | Issue | Resolution |
|---|---|---|---|
| A | `store.ts:70-78` | Top-doc said `info/exclude` is rewritten every `ensureStore` call. Actually only on first init (the whole `mkdir + writeFile` block sits inside the post-`git init` branch, after the HEAD-existence early-return). | Rewrote the docstring to reflect first-init-only and call out the implication: user edits are preserved; new excludes need a versioned bump |
| B | `createSnapshot.ts` top-doc | Stricter-than-Hermes rev-parse handling was undocumented. We return `transient-error` on rev-parse failure (other than allowed 128); Hermes `_take:904-909` falls through to fresh-root commit, silently orphaning prior chain. | Added a "Stricter-than-Hermes behavior — flagged so future maintainers don't read it as a bug" block to the top-doc |

### Deferred (no code change; documented divergences)

**C — `listSnapshots` parallel `git diff --shortstat` fan-out** (`listSnapshots.ts:140-153`)
- Phase 2 fans out N parallel `git diff --shortstat` spawns when computing per-snapshot stats. For `limit=100` that's 100 process creations at once. On Windows process spawn is heavier; cost is user-visible.
- Hermes serializes (line 688).
- **Why deferred**: not a correctness bug; perf tax. Phase 5 `/checkpoints list` UX is the consumer that will surface it.
- **When to revisit**: when Phase 5 work touches `listSnapshots`. Two options at that point — chunk into 8-wide pool, or keep parallel and document the cost. Pick based on actual measurements then.

**D — `countFilesUnder` honors `.gitignore`; Hermes does not** (`countFiles.ts` vs `_dir_file_count` 515-525)
- Hermes uses raw `Path.rglob('*')` — counts every file including ones that would be ignored by `git add -A`. A 100k-file monorepo with 80k inside `node_modules/` would hit the 50k cap and skip the snapshot, despite only ~20k files actually being staged.
- Axiomate counts only what would be staged (post-ignore).
- **Sub-divergence (F3, recorded 2026-05-21)**: even on the same input set, the count differs. Hermes' `rglob('*')` yields both files AND directories and `count += 1` runs for each (`checkpoint_manager.py:519-522`). Axiomate counts files only (`countFiles.ts:91-95`, gated by `!entry.isDirectory()`). On a deeply nested workdir Axiomate's effective threshold is therefore higher — the `MAX_FILES = 50_000` constant is "files" for us and "files + dirs" for Hermes. Same direction as the gitignore divergence (cap what `git add -A` actually pays for), no behavior bug. Recorded only so the parity claim in the JSDoc isn't read as exact.
- **Why deferred**: this is intentional and behaviorally better. Already documented as above-Hermes in `countFiles.ts` JSDoc. Listed here only so the audit trail is complete.
- **When to revisit**: never, unless we decide to match Hermes exactly for some unforeseen reason.

**E — `store.ts:130-135` config writes use `workTree: store`**
- We pass the store path itself as `GIT_WORK_TREE` for `git config` calls. Hermes uses the store's parent dir (`cfg_wd = str(base)`).
- Both work — `git config` doesn't actually touch the worktree. Hermes' choice is more semantic (the store-as-its-own-worktree is technically a misconfiguration that happens to be harmless for this op).
- **Why deferred**: pure cosmetic; behavior identical.
- **When to revisit**: only if a Phase 4 / Phase 5 commit naturally touches `store.ts:130-135` for another reason.

---



Hermes reference: `tools/checkpoint_manager.py` lines **1086–1526**. Three concrete functions to study side by side:

| Hermes | Lines | Role |
|---|---|---|
| `_enforce_size_cap` | 1086–1221 | drop-oldest-commit loop, called per-snapshot in Hermes, deferred to startup in Axiomate |
| `prune_checkpoints` | 1223–1453 | orphan + stale passes, mid-pass gc, then `_enforce_size_cap` again |
| `maybe_auto_prune_checkpoints` | 1462–1526 | 24h `.last_prune` marker, called once per process boot |

Axiomate ships a single exported function `pruneCheckpoints` that bundles all three. The 24h marker lives in the same file because it's load-bearing (without it, every boot pays gc cost).

### Module layout

```ts
// agent/src/utils/checkpoints/prune.ts

export interface PruneReport {
  skipped?: 'recent' | 'git-missing' | 'no-store'
  orphanRefsRemoved: number       // pass 1: workdir gone
  staleRefsRemoved: number        // pass 2: last_touch < cutoff
  sizeCapDropped: number          // pass 3: oldest commits trimmed
  storeBytesBefore: number
  storeBytesAfter: number
  gcInvocations: number           // 0/1/2 — intermediate always runs unless skipped on entry; final runs only when max_total_size_mb > 0
  durationMs: number
  errors: string[]                // collected; never thrown
}

export interface PruneOptions {
  retentionDays?: number          // default 14 (Phase 0 lock)
  maxTotalSizeMb?: number         // default 500 (Phase 0 lock)
  forceNow?: boolean              // bypass 24h marker, used by `/checkpoints prune`
  // Future hooks (Phase 5):
  onProgress?: (msg: string) => void
}

export async function pruneCheckpoints(
  opts?: PruneOptions,
): Promise<PruneReport>
```

**Constants**:
```ts
const DEFAULT_RETENTION_DAYS = 14
const DEFAULT_MAX_TOTAL_SIZE_MB = 500
const PRUNE_MARKER_INTERVAL_MS = 24 * 60 * 60 * 1000   // Hermes 1462: 86400
const SIZE_CAP_MAX_ITERATIONS = 20                     // Hermes 1090: anti-livelock
const GC_TIMEOUT_MULTIPLIER = 3                        // 3× DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS
const KEEP_LAST_N_PER_REF = 1                          // size-cap pass never empties a ref
```

### Top-level algorithm

```
1. probeGitAvailable() → false: return { skipped: 'git-missing', ... }
2. ensureStore() → not ok: return { skipped: 'no-store', ... }
3. unless forceNow: read .last_prune marker; if now − last < 24h: return { skipped: 'recent', ... }
4. measure storeBytesBefore = dirSize(store)
5. PASS 1 — orphan: for each projects/<hash16>.json, if workdir missing → drop ref + index + meta
6. PASS 2 — stale: for each remaining projects/<hash16>.json, if last_touch < now − retentionDays → drop ref + index + meta
7. INTERMEDIATE GC: git reflog expire --expire=now --all  ; git gc --prune=now --quiet (3× timeout)
   — runs unconditionally after pass 1+2 (Hermes 1375-1382, deep-read 2026-05-21)
8. PASS 3 — size cap: while dirSize > cap and iterations < 20:
     droppedThisRound = false  // reset per iteration; stricter than Hermes (see plan)
     for each ref with rev-list count > 1:
       drop oldest commit via commit-tree chain rebuild + update-ref
     if !droppedThisRound: break (avoid livelock when every ref is at 1 commit)
9. FINAL GC: same as intermediate, runs unconditionally inside the size-cap branch
   (i.e. when max_total_size_mb > 0). Hermes 1446-1452.
10. measure storeBytesAfter, write .last_prune = now (timestamp), return report
```

The two gc invocations are **mandatory and ordered**: pass 3's size measurement must reflect pass 1+2's reclamation, otherwise size-cap over-prunes. Hermes does the same sandwich (1335–1453).

### Pass 1+2 — orphan and stale

Both passes share the same per-project teardown. Single helper:

```ts
// helpers private to prune.ts
async function dropProjectRef(hash16: string, store: string): Promise<void> {
  // 1. git update-ref -d <ref> — removes the branch tip
  // 2. fs.unlink(indexPath(hash16)) — best-effort, ENOENT ok
  // 3. fs.unlink(projectMetaPath(hash16)) — best-effort, ENOENT ok
  // Each step try/catch independently; collect errors into PruneReport.errors
}

async function loadProjectMetas(store: string): Promise<ProjectMeta[]> {
  // Read projects/*.json. Type-guard each (matches createSnapshot:_touchProject).
  // Skip non-JSON / wrong-shape files; do not fail the whole prune.
}
```

**Pass 1 (orphan)**:
- For each meta: `fs.access(meta.workdir)`; on ENOENT → `dropProjectRef(meta.hash16)`. Other errors (EACCES, EBUSY) → log and skip — don't drop a ref because the disk is temporarily unreadable.
- Counter: `orphanRefsRemoved`.

**Pass 2 (stale)**:
- For each remaining meta: `if (now - meta.lastTouch > retentionDays * 86_400_000) dropProjectRef`.
- Missing/unparseable `last_touch` → treat as `0` (epoch), i.e. always stale. Matches Hermes 1373 (`last_touch = 0`).
- Counter: `staleRefsRemoved`.

### Intermediate gc

Runs unconditionally after pass 1+2 (Hermes 1375-1382, verified 2026-05-21):

```ts
await runCheckpointGit(['reflog', 'expire', '--expire=now', '--all'],
  { store, workTree: store, timeoutMs: DEFAULT_TIMEOUT })
await runCheckpointGit(['gc', '--prune=now', '--quiet'],
  { store, workTree: store, timeoutMs: DEFAULT_TIMEOUT * 3 })
```

Both calls fail-open (`runCheckpointGit` already returns typed errors, never throws). gc failures push to `errors[]` but don't abort the prune — the next pass will still run, just on un-gc'd objects.

### Pass 3 — size cap (deferred from Phase 2)

This is the cross-project size-cap that Hermes runs inside every `_take` (line 970) but Axiomate defers to startup (Decision in Phase 2 spec, step 13). Algorithm (port of `_enforce_size_cap` 1086–1221):

```
iteration: 0..19
  current = dirSize(store)
  if current ≤ cap * 1024 * 1024: break
  refs = list refs/axiomate/* via git for-each-ref
  droppedThisRound = false
  for each ref:
    count = git rev-list --count <ref>
    if count ≤ KEEP_LAST_N_PER_REF (=1): skip — never empty a ref
    drop oldest commit via the chain-rebuild dance:
      commits = git rev-list --reverse <ref>          // oldest → newest
      keep    = commits.slice(1)                       // drop oldest
      newSha  = root commit using keep[0]'s tree
      for c in keep[1..]:
        tree   = git rev-parse <c>^{tree}
        msg    = git log -1 --format=%s <c>
        newSha = git commit-tree <tree> -p <newSha> -m <msg> --no-gpg-sign
      git update-ref <ref> <newSha>                    // no CAS — we own this
    sizeCapDropped++
    droppedThisRound = true
  if !droppedThisRound: break
```

Reuses the existing `pruneRefToMaxN` helper's chain-rebuild logic but with `n = count - 1` (drop one) instead of `n = MAX_SNAPSHOTS`. **Refactor opportunity**: extract the inner "drop k oldest commits from ref" into `pruneRefToMaxN.ts` and have both Phase 2 ring-buffer and Phase 4 size-cap call it. Worth doing in Phase 4 implementation pass — keeps the chain-rebuild logic in one place.

The 20-iteration cap (Hermes 1090) is anti-livelock: if every ref is at 1 commit and total size still exceeds cap, no further dropping is possible. The cap could only be exceeded when one project's *single retained commit* is huge (e.g., a 600 MB blob). That case is rare and the user can manually run `/checkpoints clear` if it ever happens.

### Final gc

Runs unconditionally inside the `max_total_size_mb > 0` branch (Hermes 1446-1452). Identical shape to intermediate gc — same `reflog expire` + `gc --prune=now`, same 3× timeout. After this, the store is at its post-prune steady state and we measure `storeBytesAfter`.

### `.last_prune` marker

Written **only on successful completion** (any path that returns a `PruneReport` with `skipped` set leaves the marker untouched, so a transient failure doesn't suppress the next attempt for 24h).

```
~/.axiomate/checkpoints/.last_prune   ← contains a single line: <unix-epoch-ms>
```

Read on entry:
- ENOENT or empty → treat as 0, run pass.
- Parse failure (non-numeric, NaN) → treat as 0, run pass. Matches Hermes' "if !validateunixtime: 0" tolerance (1485).
- `now − last < 24h` and `!forceNow` → return `{ skipped: 'recent' }` immediately.

The `forceNow` flag lets `/checkpoints prune` bypass this. The CLI/slash-command path (Phase 5) is the only consumer.

### Integration site — the corrected one

**Original plan said:** wire into `processSessionStartHooks('startup', ...)` at `main.tsx:~1458`.
**That was wrong.** `processSessionStartHooks` runs user-defined hooks (the SessionStart event). Putting our prune there would (a) make it visible to user hook config, (b) couple it to the user's hook execution model, (c) be the wrong layer entirely.

**Correct site:** `agent/src/utils/backgroundHousekeeping.ts:startBackgroundHousekeeping()`.

Rationale (already verified by reading the file):
- `cleanupOldMessageFilesInBackground` already lives there — same shape (long-running, idempotent, deferrable, fail-open). Phase 3's file-history archive cleanup also routes through this neighbor.
- `runVerySlowOps` includes a "user idle ≥ 1 minute" gate before running, then waits 10 minutes after boot before kicking off. Prune inherits both — never blocks REPL TTFR, never runs while the user is actively working.
- `isBareMode()` guard auto-skips bare/SIMPLE/scripted modes. Prune correctly off for `axiomate --print` flows.

The wiring change is one line:
```ts
// Inside the existing runVerySlowOps body, alongside cleanupOldMessageFilesInBackground:
void import('./checkpoints/prune.js').then(m => m.pruneCheckpoints({}))
```

(Dynamic import keeps boot-time import graph tight; matches the Phase 4 prune file being lazy-loadable.)

### Cross-worktree decision (B — Hermes parity)

The Phase 3 architectural review flagged this latent risk (line 342–347):

> **Risk**: a stale-prune of the original session's ref in a different worktree could orphan a resumed `gitHash`. Same git repo at different abs paths → different `projectHash` → different ref. After 14 days of inactivity in worktree A, `pruneCheckpoints` will stale-drop A's ref, including any commit reachable only from A. If the user resumes the session in worktree B, B's snapshots can rewind to their own gitHashes (unaffected), but rewinds to A-era gitHashes referenced by the resumed transcript would fail with "unknown commit".

**Decision: B (Hermes parity).** Use abs-path projectHash isolation; document the limitation; no special-case logic.

Rationale:
- Hermes ships this exact behavior and has run for two years without complaints. The combination required to hit the bug (worktree add + run session in A + resume into B + don't run anything in A for 14 days) is rare.
- Alternative A (cross-worktree ref preservation: detect same git repo via `git rev-parse --show-toplevel`, keep refs alive across all worktrees of a single upstream repo) is an order of magnitude more code: identify worktree-set membership, recursively touch all sibling refs whenever any one is touched, handle the case where the upstream repo itself is moved/deleted. Pay implementation cost only after dogfood confirms the issue surfaces.
- Mitigation if it ever bites a user: `/checkpoints prune --retention-days 90` (Phase 5 CLI) lets them keep refs alive longer; `/checkpoints clear` lets them start fresh.

User-facing language for `/checkpoints` Phase 5 status output:
> "Snapshots are scoped per worktree (project root path). Resuming a session in a different worktree of the same git repo creates a new snapshot scope; rewinds to commits taken from the original worktree may become unavailable after retention."

### Test plan for Phase 4 (`__tests__/prune.test.ts`)

Use the Phase 2 test harness pattern: tmp `AXIOMATE_CHECKPOINT_BASE`, real git spawned, no binary mocks. Each test sets up a synthetic store with controlled mtimes and ref counts.

**Coverage matrix**:

| Test | Setup | Assertion |
|---|---|---|
| `orphan-pass-removes-deleted-workdir` | 3 projects; rm -rf one workdir | `orphanRefsRemoved === 1`; ref + index + meta all gone for that hash16 |
| `stale-pass-honors-retention` | 5 projects; rewrite 2 metas with `last_touch = now − 30d` | `staleRefsRemoved === 2` with `retentionDays: 14` |
| `size-cap-drops-oldest-first` | 1 project, 50 commits totaling 600 MB | `sizeCapDropped > 0`; `storeBytesAfter ≤ 500 MB`; oldest commits unreachable |
| `size-cap-respects-keep-last-n` | 5 projects each at exactly 1 commit, total > cap | loop exits at iteration 1 (no ref droppable); `sizeCapDropped === 0`; report logs no-progress |
| `marker-suppresses-recent-runs` | write `.last_prune = now − 1h` | first call returns `{ skipped: 'recent' }`; ref counts unchanged; **marker not rewritten** |
| `marker-bypassed-by-forceNow` | same setup, call with `forceNow: true` | passes run; new marker written |
| `corrupted-marker-tolerated` | write `.last_prune = "garbage\n\n"` | passes run; marker overwritten with valid timestamp |
| `git-missing-skips-cleanly` | mock probeGitAvailable → false | `{ skipped: 'git-missing' }`; no fs writes; no errors[] |
| `gc-runs-unconditionally-when-not-skipped` | empty store (no orphans/stale/size pressure) | `gcInvocations === 2` (intermediate + final, max_total_size_mb default 500) — Hermes parity |
| `gc-failure-collected-not-thrown` | inject runCheckpointGit failure on `gc` | passes complete; `errors[]` has gc message; report still returned |
| `fsck-clean-post-prune` | run full prune on mixed store | `git fsck --no-dangling` exits 0 |
| `concurrent-prune-runs-do-not-corrupt` | invoke `pruneCheckpoints` twice in parallel | both return; one is `{ skipped: 'recent' }`; fsck clean |

**Excluded from Phase 4 tests**:
- Cross-worktree resume reachability — needs full session-replay harness; Phase 6 work.
- Hermes-style legacy archive cleanup — Axiomate has no v1 (Decision #9).

### Things deliberately deferred past Phase 4

- **Reflog expire on individual refs before drop**: Hermes does it implicitly via `git update-ref -d`; we follow.
- **`git repack` after gc**: gc covers it. Add only if dogfood shows packs growing without bound.
- **Configurable retention/cap from project config**: hard-coded for now. Phase 5 CLI flags expose them ad-hoc.
- **Telemetry/metrics**: `PruneReport` is in-memory only. If we want history, write a JSONL log later.

### Refactor opportunities flagged for the Phase 4 implementation commit

These are **noted, not blocking**. Pull only if cleanup-natural; otherwise leave for follow-up:

1. **Extract `dropOldestCommitsFromRef(ref, k)`** from `pruneRefToMaxN.ts` and reuse for size-cap pass. Both invariants ("keep last N" and "drop K oldest") collapse to "rebuild ref off `commits.slice(k)`". Currently `pruneRefToMaxN` only exposes the "keep last N" shape.
2. **`dirSize(path)` helper** — shared with Phase 5 `/checkpoints status`. Could land here or there; here is fine.
3. **The store.ts:130-135 cosmetic** flagged in the pre-Phase-4 audit (config writes use `workTree: store` instead of Hermes' `workTree: base`). Behaviorally identical; touch only if `prune.ts` ends up next to it in the diff.

### Decisions added in Phase 4 spec

17. **Phase 4 trigger lives in `backgroundHousekeeping.ts`, not `processSessionStartHooks`** (Decision 6A, 2026-05-21). Reason: `processSessionStartHooks` is the user-facing hook system; prune is internal infrastructure. `runVerySlowOps` already handles idle-gate + bare-mode skip + 10-min boot delay. **Why:** original plan misread the hook system; rectified after reading the actual call site. **How to apply:** all future "do something async at boot, off the hot path" tasks belong here, not in the user-hook system.

18. **Cross-worktree resume reachability is accepted as a documented edge case** (Decision 6B, 2026-05-21, choice B over A). `projectHash` stays a pure abs-path hash. Worktrees of the same upstream git repo at different abs paths get distinct refs. Stale-prune of one worktree's ref can orphan a `gitHash` referenced by a resumed session that originated there. **Why:** Hermes runs identical behavior for two years without reports; the combination required is rare; alternative A's worktree-set tracking is an order of magnitude more complex. **How to apply:** if a user reports a "cannot rewind to past snapshot after resuming" issue, first check whether the original session ran in a different worktree path, and if so, reach for `--retention-days` rather than building cross-worktree linkage. Document the boundary in `/checkpoints` Phase 5 UI.

19. **Size-cap pass still belongs in Phase 4, not folded back into `createSnapshot`** (Decision 6C, 2026-05-21, reaffirms Phase 2 spec step 13). Per-project ring buffer (Phase 2 step 12) + cross-project size cap (Phase 4 pass 3) keep the hot snapshot path predictable. The worst case (rapid-fire snapshots between boots) is bounded by per-project ring buffer × project count. **Why:** running size-cap on every snapshot would touch every ref + every commit per project on every turn — N² blowup as project count grows. **How to apply:** if dogfood ever shows a single-session disk runaway, fix it with a tighter `MAX_SNAPSHOTS` per project, not by moving size-cap back into the hot path.

---

## Phase 4 implementation plan (locked 2026-05-21, before code)

This is the concrete modification plan executed in three steps per the user's mandate: (1) anchor behaviors with tests; (2) deep-read Hermes; (3) propose plan. Steps 1 & 2 already done. This is step 3.

### Behavior anchors landed (commit `832a9837`)

Two new tests in `__tests__/store.test.ts` pin Phase 4-adjacent assumptions before any refactor:

1. `info/exclude` is first-init-only — second `ensureStore()` call does NOT overwrite user edits, AND does NOT recreate the file if the user deleted it. Audit finding A documented this; now test-pinned.
2. `for-each-ref refs/axiomate/*` enumerates the per-project ref after a fixture commit — pins the prefix Phase 4 size-cap pass will use.

Existing 173-test suite is the broader anchor — Phase 4 must not regress any of them.

### Hermes deep-read corrections to the existing Phase 4 spec

Reading `tools/checkpoint_manager.py:1086-1526` again precisely, two divergences from the prior spec surfaced:

| Spec line | Spec said | Hermes actually does | Decision for Axiomate |
|---|---|---|---|
| Algorithm step 7 | "INTERMEDIATE GC … runs only if pass 1+2 dropped at least one ref" | Lines 1375-1382 run gc **unconditionally** after orphan/stale loop | **Mirror Hermes — unconditional intermediate gc.** A no-op `gc --prune=now` on a clean store is cheap (<100ms) and removing the conditional cuts a behavioral divergence. |
| Algorithm step 9 | "FINAL GC … runs only if pass 3 dropped anything" | Lines 1446-1452 run gc **unconditionally** at end of size-cap branch | **Mirror Hermes — unconditional final gc** (still gated on `max_total_size_mb > 0`). |
| Spec mentioned `_enforce_size_cap` as the size-cap source | Hermes' `prune_checkpoints` **inlines** the size-cap loop (1384-1453) rather than calling `_enforce_size_cap` (1086) | Both copies exist in Hermes (DRY violation). | **Axiomate ports the inline `prune_checkpoints` version.** We don't have a per-snapshot size cap (Decision #19), so the helper version isn't needed. |
| Algorithm step 8 | "if no ref dropped this round: break" | Hermes' `any_dropped` is set OUTSIDE the outer 20-iteration loop (line 1111), so once any drop succeeds in iteration 1, the no-progress check never fires in later iterations | **Stricter than Hermes — we reset `droppedThisRound` per iteration.** Genuine improvement; Hermes' shape is a likely bug. Document in code comment. |

These are minor adjustments; the big-picture algorithm is unchanged.

### File list & sequencing

The implementation is a single PR with **one new file** plus **one wiring change**:

| File | Change | Why |
|---|---|---|
| `agent/src/utils/checkpoints/prune.ts` | **New.** Exports `pruneCheckpoints(opts)`. ~250 LOC. | The prune module itself. |
| `agent/src/utils/checkpoints/__tests__/prune.test.ts` | **New.** 12-test coverage matrix from existing spec. ~400 LOC. | Phase 4 verification. |
| `agent/src/utils/backgroundHousekeeping.ts` | One line added inside `runVerySlowOps`: `void import('./checkpoints/prune.js').then(m => m.pruneCheckpoints({}))`. | The integration point. |

Sequencing inside the PR (commit-by-commit):

1. **Commit 1 — `feat(checkpoints): add prune.ts (orphan + stale + size-cap)` skeleton.** Stub `pruneCheckpoints` returns `{ skipped: 'recent' }`. Tests for the marker / forceNow / git-missing paths land green. **Behavioral compatibility window**: the file exists but is not yet wired in.
2. **Commit 2 — `feat(checkpoints): orphan + stale passes`**. Pass 1+2 implementation + dropProjectRef helper + intermediate gc (unconditional, mirroring Hermes). Tests for orphan + stale + gc-error-collected land green.
3. **Commit 3 — `feat(checkpoints): size-cap pass`**. Pass 3 implementation. Tests for size-cap + KEEP_LAST_N_PER_REF + 20-iteration break + droppedThisRound-per-iteration land green.
4. **Commit 4 — `feat(checkpoints): wire prune into backgroundHousekeeping`**. The single line in `backgroundHousekeeping.ts`. No tests on the wiring (it's one line of glue) — the prune module's tests are the verification. **This is the commit that ships the feature**; everything before it is dormant.
5. **Commit 5 (if needed) — `refactor(checkpoints): extract dropOldestCommitsFromRef`**. Pull the chain-rebuild dance out of `pruneRefToMaxN.ts` and `prune.ts` into a shared helper. Only land this if it reduces total LOC; otherwise leave the duplication.

### Refactor decision: extract `dropOldestCommitsFromRef`?

The prior spec flagged this as a refactor opportunity. Concrete consideration:

- `pruneRefToMaxN.ts` has the chain-rebuild flow tied to "keep last N" semantics. Steps: `rev-list --count`, `rev-list --reverse`, `slice(-N)`, then per-commit `rev-parse {tree}` + `log %s` + `commit-tree`, then `update-ref`.
- Phase 4 size-cap pass needs the same chain rebuild but with "drop K oldest" semantics: `slice(K)` instead of `slice(-N)`, K=1 in the per-iteration use, and the `update-ref` happens without CAS.

**Decision: extract on commit 5, only if both call sites end up with structurally identical inner loops after commit 3 lands.** If commit 3 ends up needing slightly different error-handling shapes (likely — size-cap continues to next ref on per-commit failure; pruneRefToMaxN currently bails the whole prune), keep the duplication. The 8-test pruneRefToMaxN suite is the regression net for any extraction.

### Risk surface (pre-Phase-4 specifically)

| Risk | Likelihood | Mitigation |
|---|---|---|
| Wiring inside `runVerySlowOps` runs prune in environments where it's unwanted (CI, `axiomate --print`) | Medium | `runVerySlowOps` already gated by `getIsInteractive()` + 1-min idle check + 10-min boot delay. `bareMode` skips the whole housekeeping stack. Safe. |
| `pruneCheckpoints` throws and crashes the housekeeping timer | Low | Function never throws (fail-open contract). `errors[]` collects per-step issues. Wiring is `void import().then()` — no await on caller, no crash propagation. |
| Stale-prune of an active project's ref (incorrect `last_touch`) | Low | `touchProject` is called on every `createSnapshot` (steps 4 of the 13). Even skipped snapshots touch. `lastTouch` reflects actual project usage. |
| Size-cap runaway when one project has a huge single retained commit | Low | 20-iteration cap + KEEP_LAST_N_PER_REF=1 ensure the loop terminates. Edge case is documented; user can `/checkpoints clear` (Phase 5) if it surfaces. |
| Concurrent prune runs (two axiomate processes booting at the same minute) | Low-medium | `.last_prune` 24h marker is the throttle. If both pass the marker check (race), both proceed; the size-cap CAS-free `update-ref` could race two ref rewrites, but git's update-ref is atomic per-ref so the loser silently overwrites with a slightly older view. **Not a corruption risk; potential lost size-cap drop.** Acceptable; documented as a Phase 4 limitation. |
| Phase 4 changes accidentally break Phase 3 fileHistory swap | Very low | fileHistory.ts only depends on `createSnapshot` + `rollback` + `listSnapshots`; prune.ts touches none of those, only the projects/<hash16>.json metadata read by orphan/stale passes. |

### What Phase 4 explicitly does NOT do

(Re-stated for clarity since this is the implementation gate.)

- Does **not** call `_enforce_size_cap` per-snapshot. Snapshot path stays Phase 2/3 shape unchanged.
- Does **not** add new fields to `projects/<hash16>.json` schema. Phase 4 reads `workdir` and `last_touch` only — both already present.
- Does **not** introduce a new env var or config knob. `AXIOMATE_CHECKPOINT_BASE` continues to be the single test-isolation seam.
- Does **not** touch fileHistory.ts, sessionStorage.ts, rewind.ts. Pure additive, off the snapshot path.
- Does **not** add the `/checkpoints` slash command (that's Phase 5). Phase 4 is invisible to users except via store size & disk usage.

### Verification gate before merging Phase 4

In addition to the 12-test coverage matrix:

1. **Full checkpoints suite green**: 173/173 → expect 185/185 after adding the 12 prune tests.
2. **Manual smoke**: `axiomate --print 'echo hi'` runs cleanly with a populated store. No prune triggered (bareMode skip).
3. **Manual smoke**: 3-minute interactive `axiomate` session against a synthetic 600 MB store with `forceNow=true` injected; verify size-cap brings it under 500 MB and `git fsck` clean.
4. **No new compile warnings**, no new ESLint errors.

---


## Phase 4 done (2026-05-21)

Five-commit sequence shipped against the locked plan:

| Commit | Subject | Notes |
|---|---|---|
| `c972dbaa` | prune.ts skeleton + entry-contract tests | git-missing soft-disable, 24h marker, forceNow bypass, marker write |
| (next) | orphan + stale passes + intermediate gc | Hermes 1255-1370 split into separate orphan/stale loops |
| `16e5fa21` | size-cap pass + final gc + bytesFreed | round-robin drop, KEEP_LAST_N_PER_REF=1, 20-iter livelock cap |
| `5569f631` | wire pruneCheckpoints into background housekeeping | runVerySlowOps callsite, fail-open try/catch defense-in-depth |
| (deferred) | extract `dropOldestCommitsFromRef` shared helper | dropOldest in prune.ts and pruneRefToMaxN.ts share ~50 lines but selectors differ; revisit if a third call site emerges |

### Hermes-parity verification (re-read 2026-05-21)

After Phase 4 landed, a second deep-read of `prune_checkpoints` (Hermes 1223-1459) and `maybe_auto_prune_checkpoints` (Hermes 1462-1526) found two earlier "stricter than Hermes" claims to be false and one real divergence:

1. **droppedThisRound parity** — earlier retrospective claimed Hermes' `any_drop` was set outside the outer 20-iter loop and never reset. Re-reading line 1399 shows `any_drop = False` is the first line *inside* the outer loop body, before the inner ref scan. Both implementations reset per round; behaviors are identical. The "stricter than Hermes" framing has been removed from `prune.ts` runSizeCapPass JSDoc (commit `cce28d3a`).
2. **Marker write parity** — earlier retrospective claimed Hermes only writes the marker after a full successful prune, while we write after intermediate gc. Re-reading 1499-1508 shows Hermes writes the marker once `prune_checkpoints` returns, regardless of whether anything was dropped — i.e., even on a no-op store. Same as us. No divergence.
3. **Real divergence: inner-loop size measurement** — earlier code measured `dirSizeBytes(base)` inside the size-cap iteration loop, while Hermes measures `_dir_size_bytes(store)` (line 1388). Difference is the `.last_prune` marker (~13 bytes) — too small to flip a cap decision in practice but a semantic mismatch (cap should bound the bare repo, not unrelated sibling files). Fixed in commit `cce28d3a`. Entry/exit measurement still uses `base` because `bytesFreed` is the user-visible total and should reflect everything under `~/.axiomate/checkpoints/`.

### Genuine divergences (intentional, recorded for future reference)

1. **Default `retentionDays = 14` vs Hermes 7** (already locked in Phase 0). Axiomate sessions span longer dogfood arcs; losing rewindability after a week is a UX regression.
2. **Default `maxTotalSizeMb = 500` vs Hermes 0 (disabled)** (already locked in Phase 0). Hermes' operator default opts in; we ship a temperate hard upper bound so unattended long-runs don't fill disk.
3. **`PruneReport.errors` is `string[]`** (typed messages) vs Hermes `errors: int` (count). Phase 5 `/checkpoints` UI surfaces failure modes; a count alone is unhelpful.
4. **No legacy pre-v2 archive cleanup** (Hermes 1262-1334). Axiomate has no v1 store, so the `legacy-*` and `<base>/<hash>/HEAD` paths don't exist. Documented in Decision #9.
5. **Orphan + stale split into two reporting counters** vs Hermes' single combined loop. Cosmetic — `report.orphanRefsRemoved` and `report.staleRefsRemoved` are user-visible diagnostics. Same evaluation order (orphan beats stale on the same project).
6. **`rev-list` arguments use `${ref}^{commit}` peel** in `dropOldestCommitFromRef` vs Hermes' bare ref name. Required because we run with `workTree=store` (the bare repo dir contains the `refs/axiomate/` subdir), so git's revision parser would hit `ambiguous argument: both revision and filename`. Hermes runs with `cwd=base` (the parent dir), avoiding the ambiguity. Adding the peel costs nothing on Hermes' setup, so it would be safe to apply there too.

### Bug discovered while testing (worth noting)

`rev-list` and `rev-list --count` against a bare ref name fail with `fatal: ambiguous argument: both revision and filename` after our chain rebuild — the worktree directory at `refs/axiomate/` plus the loose-vs-packed-ref state confuses git's revision parser. Fix: peel to commit explicitly with `${ref}^{commit}` in `dropOldestCommitFromRef`. `pruneRefToMaxN.ts` doesn't hit this in practice because **its caller passes `workTree: canonical` (the user's project dir), not `workTree: store`** — the project dir does not contain a `refs/axiomate/` subdirectory, so the ambiguity never arises. The peel-fix is therefore unnecessary in `pruneRefToMaxN.ts` for current call sites; if a future caller ever invokes it with `workTree: store`, it will need the same fix.

### Phase 5 readiness

Phase 5 (`/checkpoints` slash command + CLI subcommand) can read PruneReport directly from `pruneCheckpoints({ forceNow: true })` and render the bytes-freed/orphan/stale/size-cap counters. No additional hooks needed from Phase 4.

---


## End-to-end audit (2026-05-21, after Phase 4)

Three parallel sub-agents audited Phases 1, 2, and 3+4 against Hermes. Each finding below was independently verified by main thread before recording — agent claims that turned out to be false on verification are noted.

### Verified findings, classified

#### Real, fix this commit-pass

| ID | File | Issue | Fix |
|---|---|---|---|
| F1 | `fileHistory.ts:478-488` (`fileHistoryRestoreStateFromLog`) | No shape detection for legacy `trackedFileBackups`-shape snapshots persisted before the Phase 3 swap. Decision #9 said "Old file-copy backups: read-only compat" but the loop attaches the legacy snapshot with `gitHash: undefined`; a subsequent `/rewind` to that turn calls `git ls-tree undefined` and throws (`fileHistory.ts:520-523`). Concrete failure path on cross-version session resume. | Skip-and-log when `snapshot.gitHash` is missing in the fold loop. Add a focused test in `fileHistory.test.ts`. |

#### Real, doc-only

| ID | File | Issue | Resolution |
|---|---|---|---|
| F2 | `git.ts:75` (`allowedExitCodes` JSDoc) | Verified divergence: Axiomate promotes allowed-exit-code matches to `ok: true`, Hermes' `_run_git:300,312-316` keeps `ok = (returncode == 0)` and only suppresses logging. Phase 2 audit confirmed every Axiomate call site is written for the Axiomate semantics — divergence is uniform, not a mixed-mode bug. | Add a one-line note to `allowedExitCodes` JSDoc clarifying this is a deliberate ergonomic upgrade, so future readers don't "fix" it back to Hermes shape. |
| F3 | `countFiles.ts:91-95` | Already-documented audit finding D (gitignore-honoring) is true but incomplete: Hermes `_dir_file_count:519` counts BOTH files and directories via `rglob('*')`; Axiomate counts files only (`!entry.isDirectory()`). Effective `MAX_FILES` threshold is higher in Axiomate. | Append a short note to the existing finding D entry — same direction as the gitignore divergence (we cap what `git add -A` actually pays for), no behavior change. |

#### Real, defer

| ID | File | Issue | Why deferred |
|---|---|---|---|
| F4 | `git.ts:50` | Timeout clamp `[10, 600]` seconds vs Hermes' `[10, 60]`. Intentional drift — `gc` paths use 3× the default and Hermes' 60s ceiling was hit in practice on large stores. Already in effect; not a regression. | Touch only if a future audit asks why. |
| F5 | `git.ts:212` | `git-not-found` reason inferred via stringy `lower.includes('enoent')` match on execa's shortMessage. Brittle vs Hermes' typed `FileNotFoundError(filename="git")` catch (322-326). Works in practice; execa 5+ shortMessage stably contains "ENOENT". | Defer until execa output format actually shifts. |
| F6 | `paths.ts:83-91` | `DEFAULT_EXCLUDES` includes `bin/` which is broader than Hermes — could shadow user-written `bin/` script directories in projects that aren't C/C++/Java. | Product call, not a port concern. Defer until a user complaint. |
| F7 | `createSnapshot.ts:355-357` | First-snapshot create-without-CAS race hole. Two concurrent worktrees racing on the very first ref creation can silently clobber each other. Hermes 954 has the same hole. | Hermes-parity — both impls accept this. Two-year Hermes runtime hasn't surfaced it. Fix when a user reports it. |
| F8 | `prune.ts:346-359` | `runReflogExpireAndGc` 3× timeout applied to BOTH reflog and gc. Hermes 1381 only triple-times the gc; reflog uses default. Cosmetic over-budget — generous, not wrong. | Touch only if a future audit asks why. |
| F9 | `createSnapshot.ts:366` | `update-ref` CAS-failure exit code may be 1 OR 128 depending on git version/locale. Code-1 path is read as `'race'`, code-128 path falls through to `'transient-error'`. | Low risk; revisit if cross-platform CI surfaces a misclassification. |

#### Real test gaps, defer to next test-tightening pass

| ID | Test file | Gap |
|---|---|---|
| T1 | `prune.test.ts` | `bytesFreed > 0` is asserted only `>= 0`. fs noise on tmpfs makes the strict-positive assertion flaky; would need a fixed-content snapshot harness to pin reliably. |
| T2 | `prune.test.ts` | Concurrent prune runs (two processes, marker race). The 24h marker is the only throttle — behavior under simultaneous boots is unpinned. |
| T3 | `git.test.ts` | Timeout-clamp behavior of `AXIOMATE_CHECKPOINT_TIMEOUT` (NaN, negative, > 600). Also no pin on `allowedExitCodes` ok-promotion semantic. |
| T4 | `validate.test.ts` | Tab/newline-only commit hashes (`"\t\n"`); leading-whitespace hashes; backslash-traversal on POSIX (`"..\\..\\etc/passwd"`). |
| T5 | `createSnapshot.test.ts` | Race-on-update-ref pre-staged, rev-parse-transient (code outside {0,128}), stale-index-cleared-when-ref-deleted. |
| T6 | `fileHistory.test.ts` | Cross-version resume test: feed a legacy-shape `file-history-snapshot` JSONL entry → assert `restoreStateFromLog` skips it cleanly without crashing. (Lands together with F1 fix.) |

### Falsified by verification (recorded so we don't re-flag)

| Agent claim | Why false |
|---|---|
| `paths.ts:81` `normalizePath` realpath divergence is undocumented | JSDoc line 81 explicitly states `No filesystem access — symlinks are not followed (realpath-free)`. Agent missed the line. |
| `backgroundHousekeeping.ts:49-51` comment contradicts the try/catch | Agent only read lines 49-51. Lines 60-62 explain the try/catch as defense-in-depth against future refactors. Comment is coherent when read in full. |

### Remaining audit confidence

After this pass, no 🔴 (must-fix-now) issues remain in Phases 1-4 except F1 (legacy-shape resume crash). All other findings are 🟡 doc-only, deferred-by-design, or test-tightening that doesn't gate Phase 5.

---



| Path | Role | Phase |
|---|---|---|
| `agent/src/utils/fileHistory.ts:189` | `fileHistoryMakeSnapshot` | 3 (swap) |
| `agent/src/utils/fileHistory.ts:327` | `fileHistoryRewind` | 3 (swap) |
| `agent/src/utils/fileHistory.ts:66` | `fileHistoryEnabled` gate | 3 (reuse) |
| `agent/src/utils/sessionStorage.ts:1245` | `recordFileHistorySnapshot` (persistence boundary) | 3 (additive schema: `gitHash`) |
| `agent/src/utils/git.ts:212` | `gitExe()` | 1 (reuse) |
| `agent/src/utils/execFileNoThrow.ts` | `execFileNoThrow` | 1 (reuse) |
| `agent/src/utils/envUtils.ts:7` | `getConfigHomeDir()` | 1 (reuse) |
| `agent/src/utils/windowsPaths.ts:98-125` | `findGitBashPath()` | **DO NOT TOUCH** |
| `agent/src/utils/debug.ts` | `logForDebugging` | all (reuse) |
| `agent/src/commands/rewind/rewind.ts` | `/rewind` command | leave alone |
| `agent/src/commands.ts` | slash command registry | 5 |
| `agent/src/utils/backgroundHousekeeping.ts` | `startBackgroundHousekeeping`, neighbor of `cleanupOldMessageFilesInBackground` | 4 (prune trigger — correct site) |
| `agent/src/main.tsx:~1709` | call site that boots `startBackgroundHousekeeping` | 4 (no edit; just where the chain starts) |
| `agent/src/main.tsx:~2130` | commander definitions | 5 (CLI subcommand) |
| `agent/src/commands/sandbox-toggle/sandbox-toggle.tsx:40-50` | sub-arg dispatch pattern | 5 (mirror) |
| `agent/src/components/LogSelector.tsx` | Ink list selector | 5 (reuse) |
| `agent/src/components/design-system/Dialog.tsx` | confirm dialog | 5 (reuse for `clear -f`) |
| `agent/src/utils/rtk.ts:14-39` | retry/timeout/fail-open pattern | 1, 2 (mirror) |

Hermes reference (read-only, do not modify):
- `C:/public/workspace/hermes-agent/tools/checkpoint_manager.py` — store, GIT_DIR isolation, prune
- `C:/public/workspace/hermes-agent/hermes_cli/checkpoints.py` — CLI shape

---

## Scratch / in-flight notes

(Append while implementing; trim after each phase completes.)

---

## On resume (next session / after compaction)

1. Read this file top to bottom.
2. Read the plan only if a decision feels unclear: `C:\Users\kiro\.claude\plans\typed-discovering-brook.md`. The plan is frozen design; this file is live state.
3. Find current phase by `🟡` marker → that's where you stopped. If none, the "Immediate next action" line at top is the next step.
4. If a phase is `⛔ blocked`, the blocker is in scratch.
5. **Update this file as you progress** — flip ⬜→🟡 when starting, 🟡→✅ when finishing, append blockers as ⛔.

---

## Phase 5 implementation plan (locked 2026-05-21)

### Hermes Phase 5 surface (read from `hermes_cli/checkpoints.py` + `tools/checkpoint_manager.py:1533-1638`)

5 subcommands, all plain stdout (no TUI): `status` (default), `list` (alias for status), `prune`, `clear`, `clear-legacy`. axiomate ports **only** `status` / `prune` / `clear` — `clear-legacy` is dropped (see below). Underlying helpers we still need: `store_status`, `clear_all`.

### `clear-legacy` is NOT ported (real divergence from Hermes)

In Hermes, `legacy-*` directories are v1→v2 migration archives — Hermes shipped a v1 with per-session git repos, then v2 renamed each old per-session dir to `~/.hermes/checkpoints/legacy-<ts>/` and `clear_legacy` cleans those up.

**axiomate has no v1.** The pre-Phase-3 file-copy backend was an unreleased early implementation. No user install can have any legacy archive — the shadow-git store is the first and only fileHistory backend on real machines. The audit fix (2026-05-21) also deleted the `cleanupOldFileHistoryBackups()` archive path, so even dev machines no longer accumulate `~/.axiomate/file-history.legacy-*/`. A UI command for a code path that has no inputs anywhere is dead weight, so `clear-legacy` does not exist in axiomate.

### Surface decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Slash command name | `/checkpoints` (plural) | `/rewind`'s alias is `'checkpoint'` (singular). Set-based lookup keeps both distinct. |
| `/checkpoints list` UI | `components/CustomSelect/select.js` `Select` | `LogSelector` is too heavy (fuse + agentic search + branch lookup, session-log-shaped). `Select` matches what `Settings/Config.tsx:49` uses. |
| Bytes formatter | `formatFileSize` from `utils/format.ts:9` | Already exists. Don't add `formatBytes`. |
| CLI confirm | readline prompt; `-f/--force` skips | Hermes parity. Slash command uses `Dialog`. |

### Touched axiomate surface (and how each fuses)

| Touch point | Current state | How Phase 5 fuses |
|---|---|---|
| `commands.ts` `COMMANDS` | 47 entries | one `import` + one array entry |
| `/rewind` aliases `['checkpoint']` | `commands/rewind/index.ts:6` | unchanged; new `/checkpoints` is independent |
| `pruneCheckpoints({forceNow:true})` | Phase 4 ready | `/checkpoints prune` calls directly; `PruneReport` printed verbatim |
| `listSnapshots(workdir)` | Phase 2 ready | `/checkpoints list` Ink picker → `fileHistoryRewind` (mirroring `REPL.tsx:4007`) |
| `projects/<hash16>.json` metadata | Phase 2 writes; nothing reads beyond prune | `storeStatus` reads it — pin with anchor test before adding consumers |

### Execution sequence (one commit per step)

1. **Anchor existing behaviors** (task #67) — two tests:
   - `/rewind`'s `'checkpoint'` alias resolves correctly even with future `/checkpoints` registered
   - `projects/<hash16>.json` + `listSnapshots` round-trip pinned (data source for `storeStatus`)
2. **Port `store_status`/`clear_all`** (task #68) — `agent/src/utils/checkpoints/storeStatus.ts` + `__tests__/storeStatus.test.ts`. Note: `clear_legacy` is intentionally NOT ported (see "`clear-legacy` is NOT ported" above).
3. **Slash command** (task #69) — `agent/src/commands/checkpoints/{index.ts,checkpoints.tsx}`, sub-args `status`/`list`/`prune`/`clear` (no `clear-legacy`), shaped like `commands/sandbox-toggle/sandbox-toggle.tsx:40-50`
4. **CLI subcommand** (task #70) — `agent/src/cli/handlers/checkpoints.ts` + commander wiring in `main.tsx` next to `doctor`/`agents` (~line 2333). Subcommands: `status`/`list`/`prune`/`clear` only.
5. **Verify + progress doc** (task #71) — `tsc --noEmit`, full vitest, manual smoke, mark Phase 5 ✅
