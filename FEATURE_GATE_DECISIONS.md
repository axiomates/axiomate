# Feature Gate Decisions

Companion to [FEATURE_GATE_SCAN.md](FEATURE_GATE_SCAN.md). The scan mapped the problem; this file records the per-item decisions and their rationale.

Date: 2026-04-19

## Updates since the scan

- **Build parameterization landed** (commit `febba78`). `agent/build.ts`, `package-win.ts`, `package-mac.ts` now all default to `features=[]`. DEV is explicit opt-in via `build:dev` / `package:*:dev` scripts, `--features=DEV`, or `AXIOMATE_BUILD_FEATURES=DEV`. This resolved the scan's **#1 top-level finding** — local vs packaged no longer drift silently.
- **Bash AST parser migrated to env opt-in** (commit `841ba10`). `feature('DEV')` replaced by `AXIOMATE_CODE_ENABLE_BASH_AST=1`. Default behavior unchanged (legacy shell-quote); release binaries can now opt in without a rebuild.

Net effect: `feature('DEV')` now genuinely means "build-flavor, user must pass `:dev`" — the scan's recommended rule-of-thumb semantics.

## Correction to the scan

**`awaySummaryEnabled` is NOT `feature('DEV')`-gated.** It already uses env + settings runtime gating (`isAwaySummaryEnabled()` checks `AXIOMATE_CODE_ENABLE_AWAY_SUMMARY` and `settings.awaySummaryEnabled`). The scan listed it as "partially migrated" correctly — the only real gap is `/config` UI exposure. Don't treat it as a DEV-gate migration candidate.

**Bash parser is pure TypeScript, not WASM/NAPI.** The scan implied the AST path had native dependencies that could fail on some platforms. `agent/src/utils/bash/bashParser.ts` is a pure-TS tree-sitter-compatible parser with synchronous init. No platform-specific load failure to guard against.

---

## Per-feature summary (plain terms)

### Stateful / safety-sensitive

| # | Feature | What it does | State written |
|---|---|---|---|
| 1 | **Cron scheduling** (`/loop`) | Schedule prompts to run at a time or interval. Scheduler polls every 1s; fires inject prompts as system messages. | `.axiomate/scheduled_tasks.json` (durable) |
| 2 | **Session memory** | When context grows >5000 tokens or 3+ tool calls, forked agent extracts conversation notes to keep long sessions grounded. | `~/.axiomate/projects/<path>/memory/MEMORY.md` |
| 3 | **Extract memories** | At end of each completed turn, forked agent distills noteworthy facts into daily logs + rolling index. | `~/.axiomate/projects/<path>/memory/YYYY-MM-DD.md` + `MEMORY.md` |
| 4 | **Memory `skipIndex`** | Migration artifact. DEV branch tells model "ignore index, only write to daily log"; production path has index in system prompt. Production is the final design. | None (prompt-construction only) |
| 5 | **Bash AST parser** ✅ **done** | Tree-sitter-style AST walk with fail-closed allowlist. Stricter than regex + shell-quote; defends against exotic syntax tricks. Now env opt-in `AXIOMATE_CODE_ENABLE_BASH_AST`. | None |

### Tool surface / capability

| # | Feature | What it does |
|---|---|---|
| 6 | **Built-in Explore / Plan / Verification agents** | Three specialized sub-agents. Explore does broad codebase research; Plan breaks down multi-step tasks; Verification independently re-runs tests and returns a verdict before completion. DEV system prompt forces "spawn verification before finishing" on 3+ file changes. |
| 7 | **`/files` command** | Lists files currently in context. Pure debug read. |
| 8 | **Keybinding customization** | User edits `~/.axiomate/keybindings.json`; file watched for hot reload. Missing file = defaults apply. |
| 9 | **Message actions** | `shift+up` activates menu when browsing past messages: Enter (edit user msg / expand tool output), C (copy), P (copy primary field like path). Escapable with esc. |
| 10 | **Quick / Global search** | `ctrl+r` history backsearch (stable). `ctrl+shift+f` global code search (less mature). |

### UI / diagnostics

| # | Feature | What it does |
|---|---|---|
| 11 | **Token budget UI** | User types `+500k` or `spend 2M` in prompt; UI shows per-turn budget progress and auto-continues if model stops early. Invisible unless explicitly triggered. |
| 12 | **Theme extras** | DEV exposes all theme variants in `/config theme` (incl. experimental); release only shows curated list. |
| 13 | **Native clipboard fast path (macOS)** | NSPasteboard native module reads clipboard images in ~5ms vs osascript 1.5s. Requires shipping native module. |
| 14 | **Shot stats** | `/stats` shows 1-shot rate, shot distribution histogram, derived from `gh pr create` attribution text. |
| 15 | **Perfetto tracing** | `AXIOMATE_CODE_PERFETTO_TRACE=1` writes Chrome Trace Event JSON to `~/.axiomate/traces/` for ui.perfetto.dev visualization. |
| 16 | **DevBar** | Bottom-line footer showing recent slow sync ops (readdir, stat, readFile). 500ms poll; hidden when no slow ops. |

---

## Decisions by action group

### 🟢 Remove `feature('DEV')` gate entirely

No new env vars, no settings — always on for all builds. These are migration residue or pure wins with no downside.

| # | Feature | Rationale |
|---|---|---|
| 1 | Cron scheduling ✅ done | User decision: `/loop` is GA per changelog; default-on with `AXIOMATE_CODE_DISABLE_CRON=1` as kill switch. |
| 4 | Memory `skipIndex` ✅ done | Migration artifact. Production path (index in prompt) is the intended final design; DEV branch is an experiment. |
| 7 | `/files` command ✅ done | Read-only debug command; zero risk. |
| 8 | Keybinding customization ✅ done | Missing file falls back to defaults; no side effects. |

### 🟡 Convert to runtime env opt-in (no settings / `/config`)

| # | Feature | Env var | Default |
|---|---|---|---|
| 10 | Quick / Global search / modal history picker ✅ done | `AXIOMATE_CODE_ENABLE_GLOBAL_SEARCH` | off |

Env-only (no /config) because the global-search dialog is known not-quite-stable (silent ripgrep error swallow, empty-result-vs-failure ambiguity, pending onKeyDown migration). Users opting in via env knowingly accept the rough edges. Ctrl+R falls back to the stable classic backward-search when unset.

### 🟠 Convert to env + settings + `/config` runtime toggle

These write durable state or have meaningful recurring cost. A single `:dev` run can write files a later release run won't see or manage. Must give users an explicit toggle with discoverability.

Follow the existing repo pattern: prompt suggestion / speculation / deep search / `awaySummaryEnabled` (see `agent/src/utils/settings/types.ts` + `agent/src/tools/ConfigTool/supportedSettings.ts`).

| # | Feature | Knob | Default |
|---|---|---|---|
| 5 | Bash AST parser ✅ done | `bashAstEnabled` + `AXIOMATE_CODE_ENABLE_BASH_AST` | off |
| 2 | Session memory ✅ done | `sessionMemoryEnabled` + `AXIOMATE_CODE_ENABLE_SESSION_MEMORY` | off |
| 3 | Extract memories ✅ done | `extractMemoriesEnabled` + `AXIOMATE_CODE_ENABLE_EXTRACT_MEMORIES` | off |
| 6 | Built-in Explore / Plan / Verification agents ✅ done | `builtInAgentsEnabled` + `AXIOMATE_CODE_ENABLE_BUILT_IN_AGENTS` | off |
| 9 | Message actions ✅ done | `messageActionsEnabled` + `AXIOMATE_CODE_ENABLE_MESSAGE_ACTIONS` | off |

(Item 1 cron moved to 🟢 — user decision: default-on, not env+settings+/config.)

**Estimated work:** ~40-60 LOC per item (schema field + env util + supportedSettings entry + gate replacement).

### 🔵 Keep `feature('DEV')` (build-flavor is correct fit)

Under the new "`:dev` is explicit opt-in" semantics, these fit the scan's rule-of-thumb perfectly. Leave them.

| # | Feature | Reason |
|---|---|---|
| 11 | Token budget UI | User decision: not a release-visible feature; keep DEV-gated. |
| 12 | Theme extras | Experimental themes shouldn't leak to release users. |
| 13 | Native clipboard fast path | Requires shipping native module; build-time decision. |
| 14 | Shot stats | UI clutter, no value for non-developers. |
| 15 | Perfetto tracing | Diagnostic; already double-gated (DEV + env write). |
| 16 | DevBar | Pure development tool. |

No work needed.

### 🟣 Needs product decision (cannot recommend unilaterally)

All resolved. Items 6 / 9 migrated to the 🟠 env+settings+/config pattern; item 10 migrated to the 🟡 env-only pattern. See their respective sections above.

### ⚪ Orphan: `awaySummaryEnabled` ✅ done

env + settings + `/config` all in place. `AXIOMATE_CODE_ENABLE_AWAY_SUMMARY=1` or `/config awaySummaryEnabled true` to opt in. Default off.

---

## Suggested execution order

1. ✅ ~~Bash AST parser → env opt-in~~ (done, commit `841ba10`)
2. **🟢 group** — one bundled commit, ~10 LOC of gate removals (items 4, 7, 8, 11).
3. **`awaySummaryEnabled` /config exposure** — isolated 20 LOC cleanup.
4. **🟠 group** — 3 items, one commit each, following prompt-suggestion pattern.
5. **🟣 group** — wait for product decisions before touching.

## Out of scope

- No `EXPERIMENTAL` / `RELEASE` multi-flavor system; single DEV flavor is enough.
- No change to bun-bundle `feature()` API.
- No CI release-strategy changes.

## Verification checklist (per change)

1. `npm run build:types` clean
2. `npm run build` (release default) — feature behaves as default-off
3. `npm run build:dev` — DEV-only content still present where expected
4. Grep `dist/cli.js` for feature-specific symbols: should be present for runtime-gated items (just guarded at runtime), absent for items still in `feature('DEV')` under release build
