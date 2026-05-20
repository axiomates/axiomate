# Checkpoints v2 — Design Memo (Phase 0)

> Internal design memo. **Frozen scope: this memo describes architecture, not steps.**
> Companion to `docs/checkpoints-v2-progress.md` (live progress) and the full implementation plan at `~/.claude/plans/typed-discovering-brook.md`.

## Why

`agent/src/utils/fileHistory.ts` already snapshots the worktree once per agent turn (keyed by `messageId`, line 189). The **storage backend** is the bottleneck:

- file-by-file copies under `~/.axiomate/projects/<...>` — no dedup
- `MAX_SNAPSHOTS = 100` per session — long sessions silently lose history
- per-session storage — multi-worktree users duplicate every blob
- no orphan reclaim, no size cap, no GC

Hermes Agent solved the same problem in `tools/checkpoint_manager.py` (v0.13 highlight #20709) using a **shadow-git store**: one shared bare-ish repo, per-project refs, content-addressable dedup, three-pass prune + `git gc`. We port the architecture, not the Python.

## What changes (and what doesn't)

We swap the **backend** under the existing `fileHistory*` API. We do **not** add a parallel layer. Concretely:

| API surface | Today | After |
|---|---|---|
| `fileHistoryMakeSnapshot(messageId)` | copies tracked files into versioned backups | calls `store.createSnapshot(workdir, msg)` → returns `gitHash` |
| `fileHistoryRewind(messageId)` | restores file-by-file from copies | calls `store.rollback(workdir, gitHash)` |
| `fileHistoryEnabled()` | reads `fileCheckpointingEnabled` config | unchanged |
| Persistence record `FileHistorySnapshot` | `{ messageId, trackedFileBackups, timestamp }` | `{ messageId, gitHash, timestamp }` (additive — readers handle both shapes) |
| `/rewind` UX, all tool call sites | unchanged | unchanged |

**Old file-copy backups remain readable.** No force-migration. They age out via existing session GC.

## Store layout

```
~/.axiomate/checkpoints/
  store/                              ← single bare-ish git repo
    HEAD, config, objects/            ← shared content-addressable storage
    refs/axiomate/<hash16>            ← one branch tip per project
    indexes/<hash16>                  ← one git index per project (prevents races)
    projects/<hash16>.json            ← {workdir, created_at, last_touch}
    info/exclude                      ← shared default excludes
  .last_prune                         ← 24h auto-prune idempotency marker
```

`<hash16>` = `sha256(absoluteWorkdir).slice(0, 16)`. Same project across N worktrees → same `<hash16>` → same ref → blob dedup is automatic.

Sibling to existing `~/.axiomate/{shell-snapshots, plans, debug, teams, projects}/`. Verified clean — no path collision.

## Isolation strategy (the critical safety pattern)

**Concern**: every user has a `.git/` in their project; many have `commit.gpgsign=true`, signing hooks, or credential helpers in `~/.gitconfig`. A naive port would either pollute the user's git history or spawn pinentry GUIs mid-session.

**Mechanism**: every checkpoint git invocation runs with these env vars (in `agent/src/utils/checkpoints/gitEnv.ts`):

```
GIT_DIR             = ~/.axiomate/checkpoints/store     ← redirects all git ops
GIT_WORK_TREE       = <user's project root>             ← worktree to snapshot
GIT_INDEX_FILE      = ~/.axiomate/checkpoints/store/indexes/<hash16>
GIT_CONFIG_GLOBAL   = /dev/null  (NUL on Windows)       ← mute ~/.gitconfig
GIT_CONFIG_SYSTEM   = /dev/null  (NUL on Windows)       ← mute /etc/gitconfig
GIT_CONFIG_NOSYSTEM = 1
```

`info/exclude` lists `.git/`, so the user's repository state is never staged into the shadow store.

**Result**: `git status`, `git log`, `git stash`, `git reset` in the user's project all behave exactly as today. The user's `.git/` directory is untouched. No GPG prompts. No credential helper invocations. The shadow store is a fully isolated parallel universe.

Spawn pattern: direct `execFileNoThrow(gitExe(), [...args], { env })`. No shell. Same approach used by `context.ts:50` and `hooks/fileSuggestions.ts:267`.

## Missing-git policy

Hermes-style soft disable (`tools/checkpoint_manager.py:632-636`):

- Probe `gitExe()` lazily on first checkpoint operation
- Cache result in module-local `_gitAvailable`
- If `false`: `logForDebugging('Checkpoints disabled: git not found')` once, all checkpoint ops short-circuit to no-op
- `/checkpoints` status surfaces the disabled state with an install hint
- **Agent boots and runs normally either way**

**Out of scope here**: the existing Windows `findGitBashPath()` hard-exit (`utils/windowsPaths.ts:98-125`). That's BashTool's POSIX-shell requirement (grep/sed/find/cat), not ours. We don't pile on top of it. As a side effect, on Windows git is in practice always present (git-bash ships with Git for Windows), so the soft-disable path is exercised mainly on Linux/macOS without git.

## Failure semantics

Snapshot/prune failures are **fail-open**: log via `logForDebugging`, skip the operation, never block tool execution. Matches `utils/rtk.ts:14-39` pattern (timeout, retry on transient errors, fail-open). Categories:

- `git-missing` → subsystem-wide disable (above)
- `too-many-files` → workdir has >50,000 files → skip with warning, fileHistory's existing 100-snapshot cap continues to function transparently
- `no-changes` → empty diff → no commit, no record (silent)
- transient (`EBUSY`, `ETIMEDOUT`, AV-scan races) → skip this turn, next turn retries fresh

## Why this passes review

1. **No new user surface in Phase 0–4**: `/rewind` UX is unchanged; users get faster + GC'd snapshots transparently. `/checkpoints` arrives in Phase 5 as new infrastructure visibility, not as a behavior change.
2. **No new global flag**: reuses existing `fileCheckpointingEnabled` config + `AXIOMATE_CODE_DISABLE_FILE_CHECKPOINTING` env.
3. **Backwards compatible at the persistence layer**: readers handle both old `trackedFileBackups` and new `gitHash` shapes.
4. **No coupling to BashTool's bash requirement**: spawn `git.exe` directly with array args; git-bash availability is irrelevant to this code path.
5. **Hermes' design has 2 years of production hardening** (commits #11261 → #16303 → #20709, plus three dedicated test files in `tests/{tools,integration,batch_runner}/test_*checkpoint*.py`). We import the architecture, not the language.

## Resolved decisions (locked 2026-05-20)

1. **`info/exclude` policy**: snapshot only state that affects agent continuity; exclude build artifacts and dependency locks. The authoritative list lives at `agent/src/utils/checkpoints/paths.ts:DEFAULT_EXCLUDES` and covers:
   - **VCS**: `.git/`, `.hg/`, `.svn/`
   - **Visual Studio (C++ / C# / .NET)**: `bin/`, `obj/`, `.vs/`, `*.pdb`, `*.ilk`, `*.idb`, `*.tlog`, `*.exp`, `*.lib`, `*.suo`, `*.user`, NuGet `packages/` + `*.nupkg`, ReSharper caches
   - **JS/TS/Bun**: `node_modules/`, `dist/`, `build/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.parcel-cache/`, `.vite/`, `.pnpm-store/`, `.yarn/`
   - **Python**: `__pycache__/`, `*.pyc`, `.venv/`, `venv/`, `env/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `*.egg-info/`
   - **Rust**: `target/` (Cargo.lock intentionally **kept** — part of binary-crate reproducibility)
   - **Java/Gradle/Maven**: `.gradle/`, `*.class`, `*.jar`, `*.war`, `.mvn/`
   - **iOS/Xcode**: `*.xcworkspace/xcuserdata/`, `*.xcodeproj/xcuserdata/`, `DerivedData/`, `Pods/`
   - **Android**: `app/build/`, `*.apk`, `*.aab`, `*.dex`
   - **Native binaries**: `*.so`, `*.dylib`, `*.dll`, `*.o`, `*.a`, `*.exe`, `*.obj`
   - **Large media**: `*.mp4`, `*.mov`, `*.zip`, `*.tar*`, `*.7z`, `*.iso`, `*.dmg`
   - **Lockfiles** (regenerable): `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `composer.lock`
   - **Secrets**: `.env`, `.env.*`
   - **OS/editor junk**: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.swp`, `*~`, `.idea/`, `.vscode/`
   - **Logs**: `*.log`, `logs/`
   - **Top-level Axiomate state**: `/.axiomate/` (anchored — does *not* match nested `agent/.axiomate/`, so the user's `agent/.axiomate/settings.local.json` is rewindable as intended)
2. **Default caps**: `retentionDays = 14`, `maxTotalSizeMb = 500` — same shape as Hermes' production defaults; configurable via Phase 5 CLI flags.
3. **Phase sequencing**: Phase 1 → 2 → 3 → 4 → 5 confirmed. Each phase independently shippable; rollback is `git revert` on agent code.
4. **User `.gitignore` is honored automatically**: `createSnapshot` calls plain `git add -A` (no flag to disable gitignore), matching Hermes' approach (`tools/checkpoint_manager.py:890-893`). Effective exclusion is the **union** of three layers:
   - **`info/exclude`** — our `DEFAULT_EXCLUDES` (the safety net for users with no `.gitignore`)
   - **Worktree `.gitignore` files** — user's own ignore rules at any depth, auto-respected by `git add`
   - **`core.excludesFile` (global gitignore)** — *not* honored, because `GIT_CONFIG_GLOBAL=/dev/null` mutes user config. Acceptable trade-off — global gitignore is typically `.DS_Store`/`Thumbs.db` which we cover already, and the muting is necessary to avoid GPG pinentry mid-session.

   Two consequences worth knowing:
   - **Tracked-but-since-ignored files**: in a normal repo, files already committed remain tracked even after being added to `.gitignore`. The shadow store starts from empty refs every project, so it has no "already tracked" concept — purely ignore-rule-driven, which is the cleaner behavior for our use case.
   - **`.gitignore` changes apply immediately**: if the user edits `.gitignore`, the next snapshot reflects it. We don't cache or freeze the rules.
