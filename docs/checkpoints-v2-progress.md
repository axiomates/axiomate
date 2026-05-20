# Axiomate Checkpoints v2 — Implementation Progress

> Long-running task. **Resume by reading "Immediate next action" below.**

- **Plan (full design + decisions)**: `C:\Users\kiro\.claude\plans\typed-discovering-brook.md`
- **Reference implementation**: `C:\public\workspace\hermes-agent\tools\checkpoint_manager.py` + `C:\public\workspace\hermes-agent\hermes_cli\checkpoints.py`
- **Started**: 2026-05-20

---

## Immediate next action

→ **Phase 2**: implement `agent/src/utils/checkpoints/store.ts` — the user-facing API (`ensureStore`, `createSnapshot`, `listSnapshots`, `rollback`, `currentRef`, `probeGitAvailable`). Backed by the Phase 1 primitives. Round-trip integration test against a real on-disk shadow store.

**Read the Phase 2 spec below before writing code.** It's the result of a deep read of Hermes' `checkpoint_manager.py` and locks the precise step ordering, plumbing-vs-porcelain choices, and edge cases the TS port must preserve.

Phase 1 done (2026-05-20):
- 4 source files: `paths.ts` (with `DEFAULT_EXCLUDES` covering VS C++/C#, Python, JS/Bun, Rust, Java, iOS, Android), `validate.ts` (commit-hash + path-traversal guards), `gitEnv.ts` (GIT_DIR/WORK_TREE/INDEX_FILE + mute global/system gitconfig), `git.ts` (typed `runCheckpointGit` wrapper, never throws).
- 3 test files: 44/44 passing in 2.4s. `tsc --noEmit` clean.
- Honest scope: Phase 1 tests are pure-function (env composition, validation, paths). Real git-spawn behavior is exercised end-to-end in Phase 2 against a real on-disk store.

Phase 1 follow-up (2026-05-21, after Hermes deep-read):
- Added `normalizePath(value)` to `paths.ts` — direct port of Hermes' `_normalize_path` (`tools/checkpoint_manager.py:193-195`). Tilde-expand (`~`, `~/foo`, `~\foo`) + `path.resolve()`. **This is the canonical workdir hygiene function**; Phase 2 store API routes every workdir-shaped input through it before hashing/comparing/persisting.
- `validateRelativePath` now calls `normalizePath` on its `workingDir` arg, matching Hermes' `_validate_file_path:180`.
- Added `infoExcludePath()` helper to `paths.ts` (Phase 2 will write `info/exclude` here).
- Added `GIT_TERMINAL_PROMPT=0` to both `checkpointGitEnv` and `checkpointInitEnv` — defense in depth against auth/askpass hangs. **Hermes does not set this**; we go one step further than parity here, costing one line.
- Documented `projectHash` JSDoc contract: function stays pure, callers canonicalize via `normalizePath`. Test asserts noisy/clean inputs produce different hashes (so silent-canonicalization can't sneak in later); paired test asserts `projectHash(normalizePath(noisy))` equals `projectHash(normalizePath(clean))` so the layered approach actually delivers dedup.
- Tests now 55/55 passing. `tsc --noEmit` clean.

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

---

## Phase 2 spec — store.ts (locked from Hermes deep-read 2026-05-20)

Hermes refs use `tools/checkpoint_manager.py` line numbers throughout. The TS port should preserve these behaviors verbatim unless explicitly noted.

### Module-level constants

```ts
const MAX_FILES = 50_000              // working-dir file count cap (Hermes _MAX_FILES)
const MAX_FILE_SIZE_MB = 10           // per-file size cap, configurable later
const RM_CACHED_BATCH = 200           // chunk size for `git rm --cached` (Hermes 1011-1018)
```

### `probeGitAvailable(): Promise<boolean>`

- Module-level cached result (`_gitAvailable: boolean | null`). Set once, never re-probed.
- Implementation: `runCheckpointGit(['--version'], { store: 'unused', workTree: 'unused' })` is wrong because env requires real paths. Use a separate ultra-light probe: `execFileNoThrow(gitExe(), ['--version'], { timeout: 5000, useCwd: false })` — no env isolation needed for the probe itself.
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

This is the load-bearing function. Eleven steps, in order.

1. **Soft-disable**: if `!await probeGitAvailable()` → `{ skipped: 'git-missing' }`.
2. **Broad-dir guard**: skip if `workdir` is `/`, `~`, `C:\`, drive root (Hermes 643-648). Return `{ skipped: 'workdir-too-broad' }`.
3. **Per-turn dedup**: caller's responsibility — `fileHistory.ts:189` already keys on `messageId`. We don't reimplement Hermes' `_checkpointed_dirs` set.
4. **File-count guard**: count files in workdir respecting excludes. If > `MAX_FILES` → `{ skipped: 'too-many-files' }` (Hermes 852-854). Implementation note: cheapest is to delegate to git itself — `git ls-files --others --cached --exclude-standard` after stage, then early-abort if > cap. Or do a quick fs walk with the same exclude set first; pick whichever is faster on Windows. **Open question for implementation**: measure both.
5. **Set up per-project state**: `hash16 = projectHash(normalizePath(workdir))`; `indexFile = indexPath(hash16)`; `ref = refName(hash16)`. **Canonicalization happens at this boundary** via the Phase-1 `normalizePath` helper (tilde-expand + resolve). `projectHash` itself stays pure.
6. **Seed the index** (Hermes 863-884):
   - `git rev-parse --verify <ref>^{commit}` with `allowedExitCodes: {128}` to detect "ref doesn't exist yet" (`hasRef = ok && stdout.trim() !== ''`).
   - If `hasRef`: `git read-tree <refCommit>` so subsequent `diff-index` only shows real deltas.
   - If `!hasRef`: delete the stale index file if present, let `git add -A` create fresh.
7. **Stage**: `git add -A` with `timeoutMs: DEFAULT_CHECKPOINT_GIT_TIMEOUT_MS * 2` (Hermes 890-896 uses 2× timeout for staging large trees).
8. **Drop oversize files** (`_dropOversizeFromIndex`, Hermes 974-1018):
   - `git ls-files --cached -z` — NUL-separated for spaces/special chars. Parse on `\0`.
   - For each path, `fs.stat(join(workdir, path))`, collect those over `MAX_FILE_SIZE_MB * 1024 * 1024`.
   - If non-empty: chunk into `RM_CACHED_BATCH=200` and call `git rm --cached --quiet -- <paths>` per chunk.
   - Log dropped count at debug level. Don't surface to caller for now.
9. **No-changes detection** (Hermes 904-930):
   - If `hasRef`: `git diff-index --cached --quiet <refCommit>` with `allowedExitCodes: {1}`. Exit 0 = no changes → `{ skipped: 'no-changes' }`. Exit 1 = changes exist → continue.
   - If `!hasRef`: `git ls-files --cached`. Empty stdout → `{ skipped: 'no-changes' }`. Otherwise continue.
   - **Why `diff-index` against ref, not HEAD**: HEAD on a bare store points at a non-existent branch, so `--cached HEAD` would always show every staged path as new. The ref is the only source of truth.
10. **Commit via plumbing** (Hermes 932-951):
    - `git write-tree` → captures `treeSha` from stdout.
    - `git commit-tree <treeSha> [-p <refCommit>] -m <message> --no-gpg-sign` → captures `newSha`.
      - `-p` only when `hasRef`. First commit is a root commit (no parent).
      - `--no-gpg-sign` overrides any inherited config — belt-and-suspenders to the muted GIT_CONFIG_GLOBAL.
      - Pass `message` via `input` stdin if it might contain special chars; otherwise `-m` is fine. Hermes uses `-m`.
    - `git update-ref <ref> <newSha> [<oldSha>]` (CAS):
      - If `hasRef`: pass `oldSha` for atomic compare-and-swap (Hermes 956-960). If two snapshots race, the loser fails update-ref and returns `{ skipped: 'race' }` (or retries — see below).
      - If `!hasRef`: no third arg, just create the ref.
11. **Project metadata write** (Hermes 453-493):
    - Read `projects/<hash16>.json` if exists.
    - **Type guard** (Hermes test `test_non_dict_meta_does_not_raise`): if parsed value is not a plain object, treat as missing.
    - Build `{ workdir, created_at: existing.created_at ?? Date.now()/1000, last_touch: Date.now()/1000 }`.
    - Direct write (no temp-file rename — Hermes accepts the corruption risk because both readers tolerate broken JSON). Wrap in try/catch; log at debug if it fails. Snapshot still considered successful.
    - **Note**: we deliberately mirror Hermes here. Atomic write (temp+rename) is a future hardening if dogfood shows corruption.

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
  reason: string       // %s — the message arg from createSnapshot
}
```

- `limit` default = `MAX_SNAPSHOTS` (port from existing fileHistory cap = 100).
- Command: `git log <ref> --format=%H|%h|%aI|%s -n <limit>` with `allowedExitCodes: {128}` (ref may not exist).
- If exit 128 or empty stdout → return `[]`.
- Parse lines on `|` (3 splits). Reject malformed lines (defensive).
- **Skip the diff-shortstat enrichment** Hermes does (lines 688-694). It runs `N` extra git invocations and we don't surface those numbers in the current `/rewind` UX. Add later if Phase 5 `/checkpoints list` needs them.

### `rollback(workdir, hash, paths?): Promise<{ ok: boolean; preRollbackHash?: string; error?: string }>`

(Hermes 761-816.)

1. **Validate** `hash` via `validateCommitHash` — reject invalid before any git call.
2. **Validate paths** if provided: each via `validateRelativePath(path, workdir)`.
3. **Verify hash exists**: `git cat-file -t <hash>` with `allowedExitCodes: {128}`. Non-zero → `{ ok: false, error: 'unknown commit' }`.
4. **Pre-rollback snapshot** (Hermes 787): call `createSnapshot(workdir, \`pre-rollback snapshot (restoring to ${hash.slice(0,8)})\`)`. Capture its hash if successful so the user can undo the undo. **This is non-optional** — it's the safety net.
5. **Restore**: `git checkout <hash> -- <target>` where `target = paths ?? '.'`. Pass each path as a separate arg (no shell, no glob expansion).
6. **Important**: this updates the working tree only. It does **not** reset `<ref>` — so subsequent `createSnapshot` will diff against the still-newest ref tip and produce a forward commit that "undoes the rollback in the snapshot history." That's intentional: we never lose history, only move the working tree.
7. **Files added since the snapshot but absent from it are left alone** (Hermes behavior). If we ever want "clean restore" semantics, that's a separate flag.

### `currentRef(workdir): Promise<string | null>`

- `git rev-parse --verify <ref>^{commit}` with `allowedExitCodes: {128}`.
- Return trimmed stdout if `ok` and non-empty; `null` otherwise.

### Test plan for Phase 2 (`__tests__/store.test.ts`)

Each test creates a temp workdir under `os.tmpdir()` and a temp store under `os.tmpdir()` (override `getStoreDir()` via env or DI — TBD during implementation). Real git spawned, no mocks of the git binary itself.

**Round-trip**:
- write file → `createSnapshot` → modify file → `rollback` → file content matches snapshot.
- `listSnapshots` returns entries in newest-first order with correct `reason`.
- `currentRef` returns null before first snapshot, the latest hash after.

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

**GPG isolation**:
- Set `GIT_CONFIG_GLOBAL` in test process to a fake config containing `[commit]\n    gpgsign = true` → `createSnapshot` still succeeds (env override beats it).

**Idempotency**:
- Call `ensureStore()` twice → second call is a no-op (verify by checking config wasn't reset).

**Soft-disable**:
- Mock `probeGitAvailable` (or use DI on `_gitAvailable`) → all calls return `{ skipped: 'git-missing' }` cleanly, no crash.

**Malformed metadata** (Hermes' `test_non_dict_meta_does_not_raise`):
- Pre-write `projects/<hash16>.json` with `[]` → `createSnapshot` succeeds, file gets reset to a valid object.

### Things we deliberately defer past Phase 2

- **Per-snapshot diff stats** (Hermes 688-694) → only if `/checkpoints list` UI needs them.
- **Atomic metadata write** (temp + rename) → only if dogfood shows corruption.
- **Round-robin size cap dropping** (Hermes 1112-1162) → that's Phase 4 (prune).
- **Round-robin commit-chain rebuild on prune** (Hermes 1051-1074) → Phase 4.
- **Configurable `MAX_FILE_SIZE_MB`** → for now hard-code 10; expose later if needed.
- **Race retry on `update-ref` CAS failure** → return `{ skipped: 'race' }` for now. Caller can retry next turn.

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
