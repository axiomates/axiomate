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

### A4. Onboarding / provider-setup wizard

- **Highest-value rebuild candidate.** Guides a first-run user to pick a provider, enter `baseURL` + `apiKey`, and verify the connection.
- **Current state:** [components/Onboarding.tsx](agent/src/components/Onboarding.tsx) still on disk. [interactiveHelpers.tsx:91](agent/src/interactiveHelpers.tsx#L91) `showSetupScreens` is a bypass stub ("theme/config infrastructure isn't fully ported yet").
- **Why cut:** Claude Code's onboarding was tied to OAuth account login + Anthropic subscription upsell. Gutted during brand scrub (see `e0c4974` "replace /login error prompts with API-key-config guidance" and earlier).
- **Rebuild cost:** Moderate. Need: provider-picker screen (Anthropic / OpenAI / custom), baseURL + apiKey form, `verifyApiKey` integration (already live), writing to `~/.axiomate.json` via `saveGlobalConfig`.
- **Key existing utilities to reuse:** `verifyApiKey` in [services/api/llm.ts](agent/src/services/api/llm.ts) (now uses `classifyError`, provider-neutral), `saveGlobalConfig` in [utils/config.ts](agent/src/utils/config.ts), existing `Onboarding.tsx` JSX skeleton.
- **Provider-neutral:** Yes, this is the whole point.
- **Decision:** **Keep deferred** — do not delete `Onboarding.tsx` or the stub. Top priority for future work.

### A5. /brief command (brief-only output mode)

- **What it did:** Toggles a mode where the model uses a dedicated `BriefTool` (`SendUserMessage`) for all user-facing output; plain text outside the tool is hidden. Targeted at IDE/cowork UI embedders that want structured responses only.
- **Why cut:** Tied to Anthropic's KAIROS / assistant-mode subsystem behind a GrowthBook gate; doesn't fit axiomate's CLI multi-provider mission. The `commands/brief.ts` entry point was removed first; subsequent cleanup stripped the `BriefTool` itself, the `isBriefOnly` app state, the `defaultView` settings picker, and all `false ? ... : false` DCE stubs.
- **Removed in:** Group 1 — [commands/brief.ts](agent/src/commands/brief.ts) (entry point); follow-up — `agent/src/tools/BriefTool/`, `isBriefOnly` state, Config defaultView picker, settings.types `defaultView`, and stub references in `conversationRecovery.ts`, `ToolSearchTool/prompt.ts`, `permissionRuleParser.ts`.
- **Rebuild cost:** Low. `BriefTool` and `isBriefOnly` are gone — rebuild from scratch as a fresh `commands/brief.ts` + `BriefTool` registered in `agent/src/tools.ts`, plus a chat-style filter in `Messages.tsx`. Look at git history before the cleanup commit for the previous shape.
- **Provider-neutral:** Yes.

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
