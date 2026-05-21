# Axiomate Checkpoints v2 — Implementation Progress

> Long-running task. **Resume by reading "Immediate next action" below.**

- **Plan (full design + decisions)**: `C:\Users\kiro\.claude\plans\typed-discovering-brook.md`
- **Reference implementation**: `C:\public\workspace\hermes-agent\tools\checkpoint_manager.py` + `C:\public\workspace\hermes-agent\hermes_cli\checkpoints.py`
- **Started**: 2026-05-20

---

## Immediate next action

→ **Phase 2**: implement `agent/src/utils/checkpoints/store.ts` — the user-facing API (`ensureStore`, `createSnapshot`, `listSnapshots`, `rollback`, `currentRef`; `probeGitAvailable` lives in `git.ts` per Decision #15). Backed by the Phase 1 primitives. Round-trip integration test against a real on-disk shadow store.

**Read the Phase 2 spec below before writing code.** It's the result of (a) a deep read of Hermes' `checkpoint_manager.py` (2026-05-20) and (b) a 2026-05-21 audit pass that locked decisions #12-#15 and folded back in two pieces the original spec had over-deferred:
- **Per-project ring-buffer prune** (Hermes `_prune`, 1020-1084) — now step 12 of `createSnapshot`. Without it, every project's ref grows linearly forever.
- **`_touchProject` ordering** — now step 4, *before* the file-count guard, so even skipped snapshots register the project (matches Hermes 849 vs 852).

The spec also locks the precise step ordering, plumbing-vs-porcelain choices, and edge cases the TS port must preserve.

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
| 2 | Store API (snapshot / list / rollback) | ⬜ | `agent/src/utils/checkpoints/store.ts` + tests |
| 3 | Backend swap behind fileHistory.ts (load-bearing) | ⬜ | edits to `fileHistory.ts` + `sessionStorage.ts` |
| 4 | Auto-prune (orphan / stale / size-cap + gc) | ⬜ | `agent/src/utils/checkpoints/prune.ts` + tests |
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
5. Write `<store>/info/exclude` from `DEFAULT_EXCLUDES` via `infoExcludePath()`. Overwrite every init call (not just first) — Hermes treats this as authoritative.
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

## Anchors (verified file paths to read or modify)

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
| `agent/src/main.tsx:~1458` | `processSessionStartHooks('startup', ...)` | 4 (prune-on-boot hook) |
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
