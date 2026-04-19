# Feature Revival Audit

**Companion to [DELETED_FEATURES.md](DELETED_FEATURES.md).** That file is the **archive / historical catalog** of what was removed and why. This file is the **forward-looking audit**: an objective, value-based assessment of what deserves revival, cross-referencing git history with current code state.

Some historic "delete-for-good" markings in DELETED_FEATURES.md were based on incomplete information about Anthropic coupling — on re-inspection of the original implementations, a few are actually self-contained and high-value. This audit documents those findings and ranks candidates by `value × 1/cost`.

---

## Audit methodology

For each deleted/incomplete feature:

1. **Read the pre-deletion source** via `git show <commit>~1 -- <path>` to see what it actually did
2. **Check provider-coupling**: scan for Anthropic-specific imports, API endpoints, feature flags, billing/subscription logic
3. **Verify revival path**: does it need rebuilding from scratch, or can we un-gate / restore-from-history?
4. **Estimate cost**: dev-hours including settings/env/UI wiring, tests
5. **Rank by value × 1/cost**

Features still gated at `feature('DEV')` with full implementations (VERIFICATION_AGENT, TREE_SITTER_BASH, EXTRACT_MEMORIES, MESSAGE_ACTIONS, etc. — see DELETED_FEATURES.md Part E) are **intentionally left as DEV-only** per maintainer preference. They're "valuable but keep dev-only"; not in scope for this audit.

---

## Already revived

| Feature | Revival commits | Status |
|---|---|---|
| Onboarding / provider-setup wizard | `be18fd0`, `943db3d`, `bfafbf4`, `1f628e6`, `a09c9fe` | Live |
| Prompt Suggestion + Speculation | `e8a7c39` | Opt-in (prompt suggestion default on, speculation default off) |
| `/resume` Deep + Agentic Search | `3776449` | Opt-in (both default off) |
| `axiomate://` deep-link protocol handler | `6b84568` | Live, opt-out via `disableDeepLinkRegistration` |
| `/export` local transcript export (covers most of B-2) | Preserved from initial import `2673a37` | Live — writes plain text to cwd or user path; see B-2 for format/path polish gaps |

---

## Tier A — Extremely high ROI (strongly recommended)

Features where **the implementation is already in git history / on disk**, and revival is mostly wiring.

### A-1 ✓ DEEP_LINK_PROTOCOL (done in `6b84568`)

- **What it does:** Register `axiomate://` as a custom URI scheme with the OS (macOS `.app` bundle / Linux `.desktop` / Windows registry). Clicking `axiomate://session/<id>` or `axiomate://prompt?q=hello` in a browser launches axiomate in a terminal with the right context.
- **Kept-in-history reason:** Full cross-platform registration code in [`utils/deepLink/registerProtocol.ts`](agent/src/utils/deepLink/registerProtocol.ts), URL parsing in `parseDeepLink.ts`, terminal launcher in `terminalLauncher.ts`, macOS NAPI module (`url-handler-mac-napi-axiomate`) all intact — just 4 broken wires between them.
- **Provider-neutral:** Yes (pure OS-level integration, no API calls).
- **Cost:** Trivial (~30 min).
- **Status:** Revived. Registration is automatic, idempotent, self-healing. Opt-out via `~/.axiomate.json` `"disableDeepLinkRegistration": "disable"`.

### A-2 AWAY_SUMMARY (partially wired — implementation restored, hookup pending)

- **What it does:** Monitor terminal focus/blur (DECSET 1004). When user is away for 5+ minutes and a turn has finished, use `getFastModel()` to generate a 1-3 sentence "while you were away" recap from recent messages + session memory. Appended as an `away_summary` message type when the user returns.
- **Origin:** Deleted in `8dc6139` ("delete 5 dead feature gates") as part of AWAY_SUMMARY feature-gate cleanup.
- **Current state:** Service file is **already restored** at [agent/src/services/awaySummary.ts](agent/src/services/awaySummary.ts), exports `generateAwaySummary()`. **Zero callers** in the current tree — needs: terminal focus/blur detection hookup (ink has `terminal-focus-state.ts` infrastructure), `awaySummaryEnabled` settings gate, `AXIOMATE_CODE_ENABLE_AWAY_SUMMARY` env var, message-insertion into REPL state.
- **Provider-neutral:** Yes. Uses `getFastModel()`, `queryModelWithoutStreaming()`, session memory — all provider-agnostic. Zero Anthropic-specific API calls.
- **Cost:** Small (1-2h): pure wiring; service logic is pre-staged.
- **Default:** OFF — unexpected system messages could startle users. Power-user opt-in.
- **Why it was tagged wrong before:** I previously assumed coupling to KAIROS / assistant-mode based on the name "AWAY". Inspection of pre-deletion source shows it's a clean feature with no KAIROS dependencies.

### A-3 PERFETTO_TRACING (pending)

- **What it does:** Chrome-trace-format performance profiler. Writes per-session JSON to `~/.axiomate/traces/trace-<session>.json`, viewable in [ui.perfetto.dev](https://ui.perfetto.dev) or `chrome://tracing`. Traces agent hierarchy (parent-child subagents), API calls (TTFT/TTLT/prompt size/cache stats), tool executions, and user-input waits. Supports periodic flush via `AXIOMATE_CODE_PERFETTO_WRITE_INTERVAL_S`.
- **Origin:** Deleted in `8dc6139`. Full implementation (~1120 lines across `utils/telemetry/perfettoTracing.ts` plus 5 caller sites in runAgent / inProcessRunner / spawnInProcess / instrumentation / sessionTracing) in git history.
- **Provider-neutral:** Yes. Pure **local file** output using Chrome's open Trace Event Format spec. Zero phone-home. No Anthropic telemetry backend.
- **Cost:** Small-medium (2-3h): retrieve source, restore the 5 hook points, gate behind `AXIOMATE_CODE_ENABLE_PERFETTO_TRACE=<path>` env-only (diagnostic, no `/config` UI needed).
- **Default:** OFF (unset env = disabled).
- **Why it was tagged wrong before:** The name "tracing" suggested telemetry → backend upload. Actual behavior is local `fs.writeFile`. Open format, offline viewer.

---

## Tier B — Moderate ROI (worth doing)

### B-1 Reactive compaction (documented as A1 in DELETED_FEATURES.md)

- **What it did:** When a turn hit `prompt_too_long` or media-size errors **mid-stream**, the error was withheld from SDK consumers, an auto-compact ran, and the turn was retried with compacted context. Complements proactive `isAutoCompactEnabled()` (~95% coverage); reactive was the fallback for "one big tool result pushed it over limit" cases.
- **Origin:** Orchestration (~150 lines) deleted across `query.ts`, `commands/compact/compact.ts`, `services/compact/compact.ts`. Dependencies still live: [`compactConversation`](agent/src/services/compact/compact.ts), `buildPostCompactMessages`, `calculateTokenWarningState`.
- **Provider-neutral:** Yes. `classifyError()` already handles both Anthropic and OpenAI 413/prompt_too_long shapes.
- **Cost:** Medium (~half day). Stream-loop withhold logic + retry orchestration + `State.hasAttemptedReactiveCompact` guard (prevent death spirals).
- **Default:** If revived, default ON — it's a robustness win with no user-visible overhead unless the 413 actually fires.

### B-2 `/export` local transcript export (mostly done — polish remaining)

- **Current state:** `/export` slash command **is live** — [agent/src/commands/export/](agent/src/commands/export/) preserved from initial import. Writes plain text via [exportRenderer.ts](agent/src/utils/exportRenderer.ts) to cwd or a user-supplied path, optional `ExportDialog` UI. No Anthropic upload (the pre-existing `transcript-share` was a separate deleted command).
- **Remaining polish (optional):**
  - Markdown / HTML format options (currently plain text only)
  - Default output path `~/.axiomate/exports/<session-id>-<date>.md` when no filename given
  - Tool-call collection + subagent transcript pull-in (current exporter is turn-level only)
- **Provider-neutral:** Yes.
- **Cost:** Small (~2h) if we do the polish; core feature already shipping.
- **Default:** N/A — command is invoked on demand.

### B-3 Rate-limit interactive UI (documented as A3)

- **What it did:** When the model returned `rate_limit`, render an inline component offering "switch to fallback model" / "wait and retry" instead of plain error text.
- **Origin:** React component + `onOpenRateLimitOptions` prop threading removed in Group 5. Clean slate.
- **Provider-neutral:** Yes. `classifyError()?.reason === 'rate_limit'` and `parseRetryAfterMs()` from [`services/api/rateLimitTracker.ts`](agent/src/services/api/rateLimitTracker.ts) already normalize Anthropic + OpenAI shapes.
- **Cost:** Small-medium (~half day). Suggest React context over re-threading props.
- **Default:** OFF (don't hijack existing error display unless user opts in).

---

## Correctly rejected (after objective re-evaluation)

| Candidate | Actual reason — doesn't pass bar |
|---|---|
| **ULTRATHINK** keyword trigger | Injects `ultrathink_effort` attachment that **only Anthropic's internal stack recognizes**. OpenAI silently ignores. Creates "why doesn't this work" support burden for non-Anthropic users. Thinking settings are already explicit config. |
| **STREAMLINED_OUTPUT** | Transformer source (`utils/telemetry/streamlinedTransform.ts`) is **outside the fork's history window** — can't revive, would need fresh design. Parking until real demand. |
| **BASH_CLASSIFIER / POWERSHELL_AUTO_MODE LLM paths** | Shipped stub `classifyBashCommand()` had **zero callers** in the permission flow. Each auto-approval would add a fast-model roundtrip — too much latency for every bash request. Rule-based heuristics (regex for `rm -rf`, `dd if=`, `:(){` fork bombs) are faster and more predictable. |
| **A2 Skill prefetch** | Pre-deletion Anthropic telemetry showed **97% of calls found nothing**. Poor value-to-cost. Turn-0 skill discovery via `getSkillListingAttachments` (already live) covers the actual user need. |
| **A7 Session transcript module** | `sessionStorage.ts` primitives (`getTranscriptPath`, `reAppendSessionMetadata`, `scanPreBoundaryMetadata`) cover `~/.axiomate/history` resume. The deleted module was an extra layer providing no concrete value-add. |
| **A8 Job classifier** | Presupposes a **"jobs runtime"** orchestration layer (JOB_ENV_KEY dispatch, parallel `axiomate list` CLI, per-job state.json files) that was never shipped externally. Rebuilding the classifier without the runtime is backwards. |
| **TRANSCRIPT_CLASSIFIER / KAIROS / TEAMMEM / FRC** | Real implementations lived in Anthropic's internal monorepo. Shipped stubs were always no-op placeholders. No rebuild path against user-configured endpoints. |

---

## Left as DEV-gated (maintainer preference, not in audit scope)

These are fully-implemented, axiomate-compatible features, intentionally surface-only-in-DEV. They're valuable but flipping them to opt-in / production is a separate decision. See DELETED_FEATURES.md Part E for details.

**Tier 1 (highest user value per LOC):** VERIFICATION_AGENT, TREE_SITTER_BASH, EXTRACT_MEMORIES, NATIVE_CLIPBOARD_IMAGE

**Tier 2 (moderate):** MESSAGE_ACTIONS, HISTORY_PICKER, TOKEN_BUDGET, COMMIT_ATTRIBUTION, BUILTIN_EXPLORE_PLAN_AGENTS, HOOK_PROMPTS

**Tier 3 (niche / small wins):** AGENT_TRIGGERS, AUTO_THEME, QUICK_SEARCH, DUMP_SYSTEM_PROMPT, NEW_INIT, EXPERIMENTAL_SKILL_SEARCH

Un-gating any of these follows the same pattern as prompt-suggestion / deep-search revival: flip the `feature('DEV')` gate to a settings field + env var + `/config` toggle.

---

## Audit status

| Area | Status |
|---|---|
| Tier A — extremely high ROI | 1 of 3 complete (DEEP_LINK); A-2 AWAY_SUMMARY impl restored, wiring pending |
| Tier B — moderate ROI | 1 of 3 complete (B-2 /export core; format/path polish pending) |
| Rejections | Documented |
| DEV-gated Part E | Left alone per maintainer preference |

---

## See also

- **[DELETED_FEATURES.md](DELETED_FEATURES.md)** — Authoritative catalog: what was removed, which commit, original rationale. Start there for historical context.
- **[README.md § Roadmap](README.md#roadmap--rebuild-candidates)** — User-facing short list.

## Audit methodology caveat

This audit is **point-in-time**. When future cleanups or revivals happen, update the tables here (not just DELETED_FEATURES.md — the archive answers "what was removed", this file answers "what should we do next").
