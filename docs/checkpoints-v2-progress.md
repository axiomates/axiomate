# Axiomate Checkpoints v2 — Implementation Progress

> Long-running task. **Resume by reading "Immediate next action" below.**

- **Plan (full design + decisions)**: `C:\Users\kiro\.claude\plans\typed-discovering-brook.md`
- **Reference implementation**: `C:\public\workspace\hermes-agent\tools\checkpoint_manager.py` + `C:\public\workspace\hermes-agent\hermes_cli\checkpoints.py`
- **Started**: 2026-05-20

---

## Immediate next action

→ **Phase 2**: implement `agent/src/utils/checkpoints/store.ts` — the user-facing API (`ensureStore`, `createSnapshot`, `listSnapshots`, `rollback`, `currentRef`, `probeGitAvailable`). Backed by the Phase 1 primitives. Round-trip integration test against a real on-disk shadow store.

Phase 1 done (2026-05-20):
- 4 source files: `paths.ts` (with `DEFAULT_EXCLUDES` covering VS C++/C#, Python, JS/Bun, Rust, Java, iOS, Android), `validate.ts` (commit-hash + path-traversal guards), `gitEnv.ts` (GIT_DIR/WORK_TREE/INDEX_FILE + mute global/system gitconfig), `git.ts` (typed `runCheckpointGit` wrapper, never throws).
- 3 test files: 44/44 passing in 2.4s. `tsc --noEmit` clean.
- Honest scope: Phase 1 tests are pure-function (env composition, validation, paths). Real git-spawn behavior is exercised end-to-end in Phase 2 against a real on-disk store.

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
