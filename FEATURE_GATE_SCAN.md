# Feature Gate Correctness Scan

Date: 2026-04-19

## Scope

This scan focuses on migration-era gate rewrites:

- `feature('X') -> feature('DEV')`
- internal / `ant`-scoped checks removed or flattened
- features revived behind `feature('DEV')`
- features that now default to ON in some build flows

Method used for this scan:

- scan the current tree for `feature('DEV')`, env gates, settings gates, and internal / `ant` residue
- read the main rewiring commits: `586b6f9`, `59f6028`, `83eff69`, `84b565c`, `e97a0bd`, `7983ef6`, `8dc6139`
- compare local build semantics against packaged build semantics

As of this scan, `feature('DEV')` appears 120 times across 58 files under `agent/src`.

## Top-Level Findings

### 1. `feature('DEV')` currently means "build flavor", not "developer mode"

The repo has two materially different build paths:

- `agent/build.ts` sets `features: ['DEV']`
- `agent/package-win.ts` and `agent/package-mac.ts` do not pass any `features`

Practical result:

- `npm run build` or `bun run build.ts` produces a DEV-enabled artifact
- packaged macOS / Windows binaries strip `feature('DEV')` blocks

This is the biggest correctness issue in the current gate model. Many features that look "dev-only" in source are actually default-on in local build artifacts.

### 2. The repo already has a preferred runtime-gate pattern

There are good examples of the intended pattern:

- `PromptSuggestion`: env + settings + `/config`
- `Speculation`: env + settings + `/config`
- `/resume` deep search: env + settings + `/config`
- `/resume` agentic search: env + settings + `/config`

This pattern is much clearer than raw `feature('DEV')` for anything user-visible or behavior-changing.

### 3. Some gates are only partially migrated

Example:

- `awaySummaryEnabled` exists in settings schema and env handling, but is not exposed via `ConfigTool/supportedSettings.ts` and is not wired into the main `/config` UI like prompt suggestion / deep search

This is important because "has env var" and "is a properly managed feature flag" are not the same thing in the current tree.

### 4. The highest-risk items are not visual polish items

The main risk is not cosmetic DEV-only UI. The main risk is behavior split:

- background jobs
- memory writes / memory format
- permission / safety logic
- tool availability
- default agent surfaces

## Risk Categories

### A. Highest risk: behavior-changing features that are effectively default-on in local builds

| Area | Current state | Why it is risky | Main files |
|---|---|---|---|
| Cron scheduling / agent triggers | `feature('DEV')` plus disable-only env | local builds expose cron tools and scheduler by default; can create durable scheduled state and background behavior | `agent/src/tools.ts`, `agent/src/tools/ScheduleCronTool/prompt.ts`, `agent/src/cli/print.ts`, `agent/src/hooks/useScheduledTasks.ts` |
| Built-in Explore / Plan / Verification agents | `feature('DEV')` enables them directly | local build defaults differ from packaged releases; changes user-visible agent surface and prompt/tool behavior | `agent/src/tools/AgentTool/builtInAgents.ts`, `agent/src/constants/prompts.ts` |
| Session memory | gate is effectively `feature('DEV')` | background memory extraction behavior differs by build artifact | `agent/src/services/SessionMemory/sessionMemory.ts` |
| Extract memories | initialized when `feature('DEV')` | background memory writes and end-of-turn behavior differ by build artifact | `agent/src/utils/backgroundHousekeeping.ts`, `agent/src/services/extractMemories/extractMemories.ts` |
| Memory index mode | `skipIndex = feature('DEV') ? true : false` | local builds teach the model a different persistence contract than packaged releases | `agent/src/memdir/memdir.ts`, `agent/src/utils/axiomatemd.ts` |
| Bash AST parser path | AST parser only on `feature('DEV')` | shell permission / security behavior differs between local and packaged builds | `agent/src/utils/bash/parser.ts`, `agent/src/tools/BashTool/bashPermissions.ts` |
| Keybinding customization | enabled only when `feature('DEV')` | user-facing capability depends on artifact type, not explicit opt-in | `agent/src/keybindings/loadUserBindings.ts`, `agent/src/commands/keybindings/index.ts` |
| `/files` command | enabled only when `feature('DEV')` | command surface differs by artifact with no explicit runtime flag | `agent/src/commands/files/index.ts` |

These are the first items that should be reviewed one-by-one.

### B. Medium risk: user-visible features that are default-on in local builds but less likely to corrupt state

| Area | Current state | Why it still deserves review | Main files |
|---|---|---|---|
| Message actions | `feature('DEV')` with env disable | user-visible editor behavior differs across artifacts | `agent/src/screens/REPL.tsx`, `agent/src/keybindings/defaultBindings.ts`, `agent/src/components/messageActions.ts` |
| Quick search / global search / history picker | `feature('DEV')` | user-visible navigation behavior differs across artifacts | `agent/src/components/PromptInput/PromptInput.tsx`, `agent/src/hooks/useHistorySearch.ts` |
| Token budget UI | `feature('DEV')` | UI and prompt-input behavior differ across artifacts | `agent/src/components/PromptInput/PromptInput.tsx` |
| Theme extras | `feature('DEV')` expands theme settings/options | lower risk, but still a settings-surface split | `agent/src/tools/ConfigTool/supportedSettings.ts`, `agent/src/components/ThemePicker.tsx` |
| Native clipboard image fast path | macOS fast path behind `feature('DEV')` | artifact-dependent clipboard behavior; likely acceptable, but still a build-flavor split | `agent/src/utils/imagePaste.ts` |
| Shot stats | `feature('DEV')` | stats surface differs by artifact; low state risk | `agent/src/utils/stats.ts`, `agent/src/utils/statsCache.ts`, `agent/src/components/Stats.tsx` |

### C. Lower risk: diagnostics and clearly build-flavor-oriented features

These can probably remain build-flavor gated if the build-flavor story is made explicit:

- Perfetto tracing
- prompt dumping helpers
- dev-only context visualization / debug UI
- DevBar

Main files:

- `agent/src/utils/telemetry/perfettoTracing.ts`
- `agent/src/services/api/dumpPrompts.ts`
- `agent/src/components/ContextVisualization.tsx`
- `agent/src/components/DevBar.tsx`

## Already on the Right Path

These features already follow the repo's better runtime-gating direction:

| Feature | Gate shape | Notes |
|---|---|---|
| Prompt suggestion | env + settings + `/config` | good reference pattern |
| Speculation | env + settings + `/config` | good reference pattern |
| Deep search | env + settings + `/config` | good reference pattern |
| Agentic search | env + settings + `/config` | good reference pattern |
| Agent teams | explicit env / CLI opt-in | not hidden behind `feature('DEV')` |

## Partially Correct Features

These features are closer to the intended model but still incomplete:

| Feature | Current state | Gap |
|---|---|---|
| Away summary | env + settings schema | not surfaced through `ConfigTool/supportedSettings.ts` or the main `/config` UI |
| Cron scheduling | disable-only env | no explicit settings toggle, no positive opt-in, defaults to ON in DEV-enabled artifacts |

## Internal / `ant` Residue

Most current `ant` residue appears to be comments, docs, or naming leftovers rather than active feature gates.

Examples:

- `agent/src/utils/log.ts`
- `agent/src/utils/warningHandler.ts`
- scattered comments in `REPL.tsx`, `extractMemories.ts`, `stats.ts`, shell parser comments

This is worth cleaning up, but it is lower priority than the gate correctness work above.

## Recommended Review Order

1. Normalize the build story.
   Decide whether `feature('DEV')` should really mean "debug / local build only", or whether the repo should introduce explicit build flavors such as `DEV`, `EXPERIMENTAL`, and `RELEASE`.

2. Review stateful and safety-sensitive features first.
   Start with cron, session memory, extract memories, memory index mode, and bash AST permissions.

3. Review user-visible entry points second.
   Built-in agents, keybinding customization, `/files`, message actions, quick search, history picker, token budget.

4. Leave clearly diagnostic features for last.
   Perfetto, dump prompts, context visualization, DevBar.

## Suggested Rule of Thumb Going Forward

Use `feature('DEV')` only when all of the following are true:

- the feature is genuinely tied to build flavor rather than user preference
- the feature does not change durable state or safety behavior
- the feature does not need stable user-facing documentation
- it is acceptable for local build artifacts and packaged binaries to behave differently

Otherwise prefer:

- settings field
- env override
- `/config` exposure when user-facing

## Working Backlog for the Next Pass

- Decide whether cron should become explicit opt-in rather than DEV-default
- Decide whether built-in Explore / Plan / Verification agents should use runtime gating
- Decide whether session memory and extract memories should stay build-flavor gated or become explicit toggles
- Decide whether memory `skipIndex` mode is intentional or an artifact of the migration shortcut
- Decide whether bash AST permissions should be build-flavor gated at all
- Add `/config` support for `awaySummaryEnabled` if the feature is meant to stay alive
- Clean up low-value `ant` / internal wording after the gate audit is stable
