# Deleted Features — Archive & Rebuild Guide

Axiomate was forked from Claude Code. During cleanup we stripped Anthropic/Claude-Code private infrastructure, brand residue, and unreachable stubs. This file catalogs what was removed and — for features that could still be useful — how to rebuild them against the user-configured-provider contract.

**Contract reminder:** axiomate reaches models only via user-supplied `baseURL` + `apiKey` in the `models` config, speaking standard Anthropic or OpenAI HTTP protocols. Any rebuild must stay provider-neutral (no Anthropic-specific betas, no private endpoints, no OAuth).

**To see original source of a deleted feature:** `git log --oneline --all -- <path>` then `git show <commit>:<path>`.

---

## Part A — Rebuild candidates

Features that served real user value and got removed only because they were tangled with dead subsystems. All candidates are provider-neutral by design; the Claude-Code-internal ones are in Part B.

### A1. Reactive compaction (mid-stream 413 / media-size auto-recovery)

- **What it did:** When a turn hit `prompt_too_long` or media-size errors mid-stream, the error was withheld from the SDK consumer, a compact ran on the conversation, and the turn was retried with compacted context — user saw a brief "compacting…" instead of a hard failure.
- **Complements:** `isAutoCompactEnabled()` proactive compact (still live) catches ~95% of cases. Reactive was the fallback for the "one big tool result pushed over limit" case.
- **Why cut:** Internal skill-search + job-classifier modules were deleted by earlier commits; the `reactiveCompact.ts` module was already missing by the time of this fork. Orchestration hooks in `query.ts` were gated by `reactiveCompact = null` sentinels (always false) and had been dead the whole fork life.
- **Removed in:** Group 2 (current branch) — `query.ts`, `commands/compact/compact.ts`, `services/compact/compact.ts`. ~150 lines of orchestration.
- **Rebuild cost:** Moderate. Need: (a) withhold logic in stream loop (don't yield `prompt_too_long` until recovery decides), (b) post-stream recovery branch that calls `/compact`-like flow and retries with `State.hasAttemptedReactiveCompact` to prevent death spirals, (c) a `tryReactiveCompact` function wiring to existing `compactConversation` helper.
- **Key existing utilities to reuse:** `compactConversation` in [services/compact/compact.ts](agent/src/services/compact/compact.ts), `buildPostCompactMessages`, `calculateTokenWarningState`.
- **Provider-neutral:** Yes — compaction uses user's configured model.

### A2. Skill prefetch (per-iteration parallel skill discovery)

- **What it did:** At the start of each turn, fired a small-model call asking "which skills are relevant given current messages + write-pivot signal"; result was collected at turn end as an attachment. Hidden behind main-turn latency.
- **Why cut:** Internal module (`services/skillSearch/prefetch.ts`, `services/skillSearch/featureCheck.ts`) was deleted by earlier commits; `skillPrefetch = null` sentinels had been dead. Also the prior internal team's production telemetry showed "97% of these calls found nothing."
- **Removed in:** Group 2 — `query.ts`. ~30 lines (per-iteration prefetch call + post-turn collect).
- **Rebuild cost:** Low mechanically, questionable value (see 97% stat). Would need: small-model dispatcher (provider-neutral), `DiscoverySignal` detection (type still exists in [services/skillSearch/signals.ts](agent/src/services/skillSearch/signals.ts)), collect hook in query loop.
- **Related live code:** `getSkillListingAttachments` in [utils/attachments.ts](agent/src/utils/attachments.ts) still provides turn-0 skill discovery — prefetch was only for mid-session discovery.
- **Decision:** Marked **delete-for-good** in Group 5 — value-to-cost is unfavorable; turn-0 discovery covers most needs.

### A3. Rate-limit UI component (interactive 429 handler)

- **What it did:** When the model returned `rate_limit` errors, rendered an inline React component offering "switch to fallback model" / "wait and retry" options instead of plain error text.
- **Why cut:** `isRateLimitErrorMessage()` and `RateLimitMessage` components were stubs (`return false` / `return null`) in the Claude-Code-internal setup; real implementation lived in an internal module that didn't ship to externals.
- **Removed in:** Group 1 — [components/messages/AssistantTextMessage.tsx](agent/src/components/messages/AssistantTextMessage.tsx).
- **Current behavior:** Rate-limit errors surface as plain text via the `API_ERROR_MESSAGE_PREFIX` branch. User sees the message but no one-click actions.
- **Rebuild cost:** Low-moderate. Need: React component that consumes `classifyError(...)?.reason === 'rate_limit'`, reads `parseRetryAfterMs`, offers fallback-model switch via `options.fallbackModel`.
- **Prop threading now gone:** `onOpenRateLimitOptions` was removed from `AssistantTextMessage.tsx` / `Message.tsx` / `Messages.tsx` / `MessageRow.tsx` / `REPL.tsx` in Group 5. Rebuild starts from a clean slate — re-add the prop where the new UI hooks in, or use a context instead.
- **Provider-neutral:** Yes — `classifyError()` and `rateLimitTracker` already handle both OpenAI and Anthropic 429 shapes.
- **Decision:** **delete-for-good** (Group 5). Rate-limit errors surface as plain text via `API_ERROR_MESSAGE_PREFIX`. Rebuild later from scratch if the interactive "switch model / wait" affordance is wanted.

### A4. Onboarding / provider-setup wizard ✓ REVIVED

- **What it did:** Guides a first-run user to pick a provider, enter `baseURL` + `apiKey`, and verify the connection.
- **Why cut originally:** Claude Code's onboarding was tied to OAuth account login + Anthropic subscription upsell. Gutted during brand scrub (see `e0c4974` "replace /login error prompts with API-key-config guidance" and earlier).
- **Status:** Rebuilt as a provider-neutral interactive wizard that writes to `~/.axiomate.json`. Verifies the `apiKey` via `verifyApiKey()` before persisting.
- **Revived in:** `be18fd0` (feat: interactive onboarding wizard with provider setup), `943db3d` (tighten trigger + silence ENOENT backup warning), `bfafbf4` (stop reading stdin in interactive mode), `1f628e6` (don't hang on first run when currentModel is unset), `a09c9fe` (offline-first + don't throw on first-run model resolution).
- **Provider-neutral:** Yes.

### A5. /brief command (brief-only output mode)

- **What it did:** Toggles a mode where the model uses a dedicated `BriefTool` (`SendUserMessage`) for all user-facing output; plain text outside the tool is hidden. Targeted at IDE/cowork UI embedders that want structured responses only.
- **Why cut:** Tied to Anthropic's KAIROS / assistant-mode subsystem behind a GrowthBook gate; doesn't fit axiomate's CLI multi-provider mission. The `commands/brief.ts` entry point was removed first; subsequent cleanup stripped the `BriefTool` itself, the `isBriefOnly` app state, the `defaultView` settings picker, and all `false ? ... : false` DCE stubs.
- **Removed in:** Group 1 — [commands/brief.ts](agent/src/commands/brief.ts) (entry point); follow-up `5a7d042` — `agent/src/tools/BriefTool/`, `isBriefOnly` state, Config defaultView picker, settings.types `defaultView`, and stub references in `conversationRecovery.ts`, `ToolSearchTool/prompt.ts`, `permissionRuleParser.ts`.
- **Rebuild cost:** Low. `BriefTool` and `isBriefOnly` are gone — rebuild from scratch as a fresh `commands/brief.ts` + `BriefTool` registered in `agent/src/tools.ts`, plus a chat-style filter in `Messages.tsx`. Look at git history before `5a7d042` for the previous shape.
- **Provider-neutral:** Yes.
- **Decision:** **delete-for-good** — the feature's mental model (tool_use = user-facing reply, streaming text = working notes) is coupled to chat-style UI surfaces (claude.ai, IDE embedders), not the CLI-first multi-provider axiomate mission. If a future use case wants structured output, prefer asking for it at the prompt level or via tool overrides, not a dedicated tool + filter pipeline.

### A6. /privacy-settings command

- **What it did:** Screen to review/update opt-out flags for telemetry, memory, session recording.
- **Why cut:** `isEnabled: () => false`; the underlying telemetry endpoints it controlled were Anthropic-internal.
- **Removed in:** Group 1 — [commands/privacy-settings/](agent/src/commands/privacy-settings/) (directory deleted).
- **Rebuild cost:** Low-moderate if axiomate adds user-facing telemetry/memory opt-outs. OTel telemetry is already user-configurable via env vars; a UI wrapper could be useful.
- **Provider-neutral:** Yes.

### A7. Session transcript / recovery module

- **What it did:** Persisted session transcripts and metadata in a durable format for cross-session resume beyond what `~/.axiomate/history` provides.
- **Why cut:** `sessionTranscriptModule = null` sentinel; internal module `services/sessionTranscript/` was never in the external build.
- **Removed in:** Group 2 — `services/compact/compact.ts`, `utils/attachments.ts`.
- **Rebuild cost:** Moderate. Existing `utils/sessionStorage.ts` has `getTranscriptPath`, `reAppendSessionMetadata`, and `scanPreBoundaryMetadata` already working; this module was an extra layer on top for richer recovery.
- **Provider-neutral:** Yes — pure local filesystem.
- **Decision:** **delete-for-good** (Group 5). The existing `sessionStorage.ts` primitives are sufficient for `~/.axiomate/history` resume. Rebuild later if richer cross-session features are wanted.

### A8. Job classifier / task summary modules

- Background jobs fired on session end to classify task state (for a separate "axiomate list" runtime) and generate summaries.
- Tied to an internal multi-agent "jobs" orchestration layer (complete with `JOB_ENV_KEY` dispatch protocol, `state.json` per-job files, and a parallel `axiomate list` CLI) that was never in the external build — only the `const jobClassifierModule = null` sentinel + a stale comment remained.
- **Removed in:** Group 2 — `query.ts`, `query/stopHooks.ts`.
- **Rebuild cost:** High, and presupposes building the jobs runtime first.
- **Decision:** **delete-for-good** (Group 5). No near-term use case; a clean rebuild would make sense only if a "batch-dispatch axiomate instances" feature is ever wanted, and that would deserve its own design from scratch.

---

## Part A-bis — Features revived as opt-in since initial doc

After this archive was first written, a further pass identified features that were in a half-killed state (stub returning false or no-op but full implementation still present). These were **revived as opt-in features** following a consistent pattern: `~/.axiomate.json` setting + `AXIOMATE_CODE_ENABLE_<FEATURE>` env var + `/config` toggle.

### A-bis 1. Prompt Suggestion + Speculation ✓ REVIVED

- **What it does:** After each assistant turn, a small parallel agent (using the main model for cache-hit discount) predicts what the user will type next as 2-12 word ghost text. Tab/Enter accepts. Speculation (opt-in extra) also **runs** the predicted prompt in a copy-on-write filesystem overlay, so accepting skips a roundtrip.
- **Original state:** Mid-function `return false` in `shouldEnablePromptSuggestion()`, hard-coded `const enabled = false` in `isSpeculationEnabled()`, Anthropic-subscription `currentLimits` overage gate stuck on `{status: 'allowed'}`. Full backend machinery intact.
- **Revived in:** `e8a7c39` (feat: revive prompt suggestion + speculation as configurable).
- **Defaults:** `promptSuggestionEnabled: true` (on), `speculationEnabled: false` (off — more aggressive, can chain 20 turns of throwaway work).
- **Controls:** env `AXIOMATE_CODE_ENABLE_PROMPT_SUGGESTION=0|1`, `AXIOMATE_CODE_ENABLE_SPECULATION=0|1`, settings `promptSuggestionEnabled` / `speculationEnabled`, `/config` → "Prompt suggestions" / "Speculative execution".
- **Provider-neutral:** Yes — fork piggybacks on parent cache via `cacheSafeParams`; works with any provider that supports prompt caching (OpenAI since late 2024, Anthropic, most OpenAI-compatible providers).

### A-bis 2. Deep Search + Agentic Search in /resume ✓ REVIVED

- **What it does:** `/resume` session picker gains two search modes — Deep Search (Fuse.js fuzzy fulltext, local, zero API cost) and Agentic Search (natural-language query, one `getFastModel` call per search ranks session metadata + transcript snippets by relevance).
- **Original state:** Two `const isXEnabled = false` stubs in `LogSelector.tsx` gated otherwise-complete implementations (`agenticSessionSearch.ts` 308 lines, full Fuse index + state machine in LogSelector).
- **Revived in:** `3776449` (chore: drop empty feature('DEV') blocks + revive /resume search as opt-in).
- **Defaults:** Both off (agentic search costs one fast-model call per query).
- **Controls:** env `AXIOMATE_CODE_ENABLE_DEEP_SEARCH`, `AXIOMATE_CODE_ENABLE_AGENTIC_SEARCH`, settings `deepSearchEnabled` / `agenticSearchEnabled`, `/config` toggles.
- **Provider-neutral:** Yes — agentic search uses `sideQuery` + `getFastModel`, both provider-agnostic.

---

## Part D — Additional cleanups since initial doc

Residues removed after initial documentation, all no-behavior-change deletions (0 callers, 0 runtime effect).

### D1. Brief / SendUserMessage full residue (`5a7d042`)

Besides the `commands/brief.ts` entry point removed in Group 1, a larger cleanup passed stripped: `agent/src/tools/BriefTool/` entire directory, `isBriefOnly` threaded through 15+ files, `BriefIdleStatus` + `BriefSpinner` in Spinner.tsx, `formatBriefTimestamp.ts`, `defaultView` settings field + `/config` picker (was a UX bug — users could pick "chat" but nothing happened), `filterForBriefTool`/`dropTextInBriefTurns` filter functions in Messages.tsx, `LEGACY_BRIEF_TOOL_NAME` alias in `permissionRuleParser.ts`, and all `false ? ... : false` DCE stubs in `conversationRecovery.ts` / `ToolSearchTool/prompt.ts`. Net: 32 files, −1123 LOC.

### D2. No-op hooks: frustration + AntOrgWarning + npm deprecation (`1ff9f3e`)

- `useFrustrationDetection` — typing-pattern analysis to nudge a frustration survey. Hard-returned `state: 'closed'`. REPL.tsx had a double-stub pattern (inline DCE override + call site whose result was assigned to an unread variable).
- `useAntOrgWarningNotification` — Anthropic Org quota-warning notification. 4-line empty hook, called for void with no observable effect.
- `useNpmDeprecationNotification` — Claude Code's "switch to native installer" nudge. Disabled by earlier commit `970cce6` because axiomate has no native installer alternative; the rebranded "Axiomate has switched from npm to native installer" warning was a sed-replace that didn't match reality.
- Also stripped the orphan no-op `logEvent` in `FeedbackSurvey/utils.ts` (0 callers, distinct from the live `services/analytics/index.ts:logEvent` OTel forwarder).

### D3. Anthropic subscription/org/account residue in SDK + analytics types (`812c575`)

- `SDKRateLimitInfoSchema` + `SDKRateLimitEventSchema` — full Anthropic billing schema (`five_hour`/`seven_day`/`overage` windows, 11 `overageDisabledReason` enum values covering org/seat/member/credit gating, `surpassedThreshold`). Type was already neutered to `any` in `agentSdkTypes.ts`. axiomate's real rate-limit path is `rateLimitTracker.ts` (Retry-After + x-ratelimit-* standard headers); these schemas were never emitted.
- `should1hCacheTTL` docstring mentioned "ant or subscriber within rate limits" eligibility + a config allowlist that no longer exists. Replaced with accurate description.
- `user.ts` `CoreUserData` Anthropic-only fields: `organizationUuid`, `accountUuid`, `subscriptionType`, `rateLimitTier`, `firstTokenTime` (this one was same-named but different from live REPL/queryProfiler TTFT metric — unrelated). All five were assigned `undefined` with an acknowledgment comment. `metadata.ts` had a duplicate dead `subscriptionType` field — also dropped.

### D4. Empty `feature('DEV')` / dead conditional blocks (`3776449`)

Four empty blocks left after upstream features were stripped, deleted inline:
- `postCompactCleanup.ts:58` `if (feature('DEV')) {}`
- `worktree.ts:603` `if (feature('DEV')) {}` + 8 lines of stale husky-hook commentary
- `attribution.ts:334` `if (feature('DEV') && isInternal && attributionData) {}` + 7 lines describing `INTERNAL_MODEL_REPOS` squash-merge trailers
- `main.tsx:1369` `if (customAgent.memory) {}` + stale "Log agent memory loaded" comment

### D5. `isUsingOverage` tracking (`e8a7c39`)

Stripped from `promptCacheBreakDetection.ts` — Anthropic-subscription overage state field that was always `false` in axiomate and never contributed to cache-break detection. Removed from `PromptStateSnapshot`, `recordPromptState` destructuring, `PendingChanges`, and the cache-break diagnostic commentary.

---

## Part E — Further rebuild candidates (currently DEV-gated)

The prior author's cleanup passes left a set of valuable, axiomate-compatible features gated behind `feature('DEV')` — they surface only in dev builds and get DCE'd in release. Each is self-contained and doesn't depend on Anthropic-private infrastructure. They're ready to flip from DEV-gated to opt-in / production-on with the same pattern as A-bis above (settings field + env var + `/config` toggle).

Origin commits: `586b6f9` ("rewire 13 valuable feature gates"), `59f6028` (VERIFICATION_AGENT), `83eff69` (HOOK_PROMPTS), `e97a0bd` (NATIVE_CLIPBOARD_IMAGE), `84b565c` (TREE_SITTER_BASH).

**Tier 1 — highest user value per LOC:**
- **VERIFICATION_AGENT** — independent adversarial verifier subagent for non-trivial implementation work. Catches "looks correct but actually broken" bugs. Self-contained, `model: 'inherit'`, ordinary tool set.
- **TREE_SITTER_BASH** — 4436-line AST-based bash parser (pure TS, no native dep). Catches `trap/enable/hash` evil that the legacy regex path misses. Security win.
- **EXTRACT_MEMORIES** — auto-extract durable learnings into project memory at session end. Complements existing `AXIOMATE.md` memory flow.
- ~~**NATIVE_CLIPBOARD_IMAGE**~~ — macOS clipboard image fast path (~0.03ms warm vs ~1.5s osascript fallback). **Already active in every build** — `build.ts:35` declares `'DEV'` by default so the `feature('DEV')` gate at `imagePaste.ts:127` always fires. Nothing to do. Windows/Linux users go through shell-based `getClipboardCommands()` regardless of the gate.

**Tier 2 — moderate value, low cost:**
- **MESSAGE_ACTIONS** — message action menu (edit/rerun past messages).
- **HISTORY_PICKER** — interactive session history picker. Complements recently-revived Deep + Agentic Search.
- **TOKEN_BUDGET** — per-turn token budget UI display. Useful for cost-conscious multi-provider users.
- **COMMIT_ATTRIBUTION** — auto git `Co-Authored-By` metadata on commits.
- **BUILTIN_EXPLORE_PLAN_AGENTS** — Explore + Plan built-in subagents. Ready to use.
- **HOOK_PROMPTS** — hook-related prompting (investigate before reviving — purpose unclear from gate alone).

**Tier 3 — niche or small UX wins:**
- **AGENT_TRIGGERS** — cron scheduling + slash-command agent invocation (e.g., "summarize yesterday's commits at 9am").
- **AUTO_THEME** — follow system theme.
- **QUICK_SEARCH** — global search keybindings.
- **DUMP_SYSTEM_PROMPT** — `--dump-system-prompt` CLI flag for debugging.
- **NEW_INIT** — `/init` command + AXIOMATE.md wizard (basic `/init` already exists; this is a more full-featured version).
- **EXPERIMENTAL_SKILL_SEARCH** — `DiscoverSkillsTool`. Value depends on skill ecosystem maturity.

**Still worth proper rebuild (not just DEV flip):**
- **A1 Reactive compaction** — mid-stream `prompt_too_long` / media-size auto-recovery. Moderate cost: needs withhold-and-retry orchestration in `query.ts`. Reuses existing `compactConversation`.
- **BASH_CLASSIFIER** (the concept, not the stub) — LLM-based "is this bash command read-only safe?" classifier for permission auto-approval. Original Anthropic implementation lived in their internal monorepo; the shipped stub always returned no-match. Would need fresh design using `getFastModel` + a prompt. Useful for power users running automated agents.
- **transcript-share** → local `/export` — original was Anthropic-service upload; axiomate equivalent would be `/export` to local markdown/HTML file for sharing. Different scope, same user need.

---

## Part B — Historical record: Claude-Code-internal infrastructure

These were removed by earlier commits (before this review session). Provider-coupled or Anthropic-service-coupled; no rebuild path against user-configured endpoints. Listed for archaeology only.

### B1. Remote control plane

| Subsystem | What it did | Removal commits |
|-----------|-------------|-----------------|
| Teleport | Mobile / web-side remote control of local CLI | `7228324`, `1e71a88`, `88c951e`, `9fbd271`, `81a5946` |
| CCR (Claude Code Relay) | Backend bridge routing IDE/desktop traffic through Anthropic | `7228324`, `ab5f79d` |
| RemoteIO stubs | Tools that push back to Anthropic server | `88c951e` |
| Remote-managed settings | Settings pushed from admin console | `7712c61` |
| xaa Enterprise OAuth | MCP IdP for enterprise seats | `f336b17` |
| `/ultrareview` command | "Review this on the web" Anthropic-private service | `0e5e09d` |

### B2. Anthropic-service routing

| Feature | Removal commits |
|---------|-----------------|
| Bedrock / Vertex / Foundry env routing | `a0b1a17` |
| Anthropic Cloud / BYOC env routing | `b95dd4f` |
| 4-way `APIProvider` enum (always firstParty now) | `dc41e70` |
| `x-anthropic-billing-header` | `a0a5091` |
| `ANTHROPIC_PERMISSIONS_TEMPLATE` | `0f24568` |
| `anthropic_internal.effort_override` | `3a36835` |
| `anthropic_beta` merge in `getExtraBodyParams` | Group 4 (current) |
| `ANTHROPIC_*` → `AXIOMATE_*` env rename | `da5b7b3` |

### B3. Auth / account infrastructure

| Feature | Removal commits |
|---------|-----------------|
| OAuth login flow | `05038ec`, `cf592ba`, `57e0d99` |
| `AccountInfo` SDK plumbing | `a36de1b` |
| HTTP auth headers + feedback/BigQuery exporters | `f3c5c42` |
| Claude.ai subscription mocks | `36c91b9` |
| OAuth token-revoked error classifier | Group 3 (current) |
| Cloud auth cache clearing (no-op) | Group 3 (current) |
| `sk-ant-sid` session-cookie auth branch | Group 3 (current) |
| `hasCompletedOnboarding` config field + `wouldLoseAuthState` canary | Group 1 (current) |
| `account_uuid` in `getAPIMetadata.user_id` | Group 3 (current) |

### B4. Classifier / automation pipelines

All were Anthropic-internal small-model dispatch pipelines with private config surfaces.

| Feature | Removal commits |
|---------|-----------------|
| BASH_CLASSIFIER | `020a1b4` |
| TRANSCRIPT_CLASSIFIER + auto-mode subsystem | `b61aeb4` |
| TEAMMEM (second memory bucket) | `73182f4` |
| `/debug-tool-call` dev command | Group 1 (current) |
| `/env` dev command | Group 1 (current) |
| FRC (Function Result Clearing) system prompt section | Group 1 (current) |

### B5. Dead feature-gate churn

Per-feature gates rewired to `feature('DEV')` or deleted outright as part of commit-B pass.

| Feature | Status | Commit |
|---------|--------|--------|
| AWAY_SUMMARY, PERFETTO_TRACING, STREAMLINED_OUTPUT, ULTRATHINK, POWERSHELL_AUTO_MODE | deleted | `8dc6139` |
| HOOK_PROMPTS, VERIFICATION_AGENT | rewired to DEV | `83eff69`, `59f6028` |
| NATIVE_CLIPBOARD_IMAGE, TREE_SITTER_BASH | rewired to DEV | `e97a0bd`, `84b565c` |
| SHOT_STATS | rewired to DEV | `7983ef6` |
| TREE_SITTER_BASH_SHADOW | deleted | `84b565c` |
| 13 valuable gates rewired from never-fired → DEV | rewired | `586b6f9` |

### B6. Dead tools (source never shipped external)

Removed in Group 1 — bindings in `tools.ts` were `false ? require(...) : null` referencing modules that don't exist on disk. No rebuild path since there's no source.

- RemoteTriggerTool, MonitorTool, SendUserFileTool, PushNotificationTool, SubscribePRTool
- OverflowTestTool, CtxInspectTool, TerminalCaptureTool, WebBrowserTool, SnipTool, ListPeersTool

### B7. Other

| Feature | Removal commits |
|---------|-----------------|
| `/login` OAuth prompts (replaced with config guidance) | `e0c4974` |
| `--file` CLI + Files API stubs | `7c40022` |
| Fake "public SDK" shell in agentSdkTypes.ts | `e5fdff2` |
| `transcript-share` feature | `2754f52` |
| `remoteManagedSettings` subsystem | `7712c61` |
| `services/api/client.ts` (unused) | `f0b016c` |
| `moreright/useMoreRight` runtime stub | Group 1 (current) |
| `ALL_MODEL_CONFIGS` / `ModelStrings` / `modelOverrides` chain | `de556c6` |
| Brand: Haiku/Opus/Sonnet references + hardcoded model IDs | `48f5d7d`, `ac688d0`, `a37dcbe` |
| Brand: Claude Agent SDK / Claude API framing in prompts | `518aaae`, `da5f455` |
| Brand: @[MODEL LAUNCH], golink, Ant codename | `c63854a` |

---

## Part C — Pattern notes for future rebuilds

- **Add a provider dimension to the feature's interface from the start.** Don't assume Anthropic-shape errors, Anthropic-shape metadata, or Anthropic-specific beta flags. Use `classifyError()` for error semantics, `provider.inference()` for model calls, and `providerHints` for anything provider-specific.
- **Prefer opt-in gates to always-on behavior.** Env var (`AXIOMATE_*_ENABLED`) or config-file toggle is easier to disable than a global kill switch later.
- **No phoning home.** Any telemetry, billing, update-check, or classifier-dispatch must only talk to user-configured endpoints. OTel is fine (user configures the collector).
- **If a rebuild needs a small-model dispatch**, reuse `getFastModel()` and `getProviderForModel()` — these resolve from user's `models` config.
- **Don't reintroduce `anthropic_beta` or `betas: [...]` at the shared-helper level.** Any Anthropic-beta-specific data goes into `providers/anthropicProvider.ts` via `providerHints`.
