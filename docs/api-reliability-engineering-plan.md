# Axiomate API Reliability Engineering Plan

This plan tracks API-related gaps from `docs/axiomate-productization-stability-report.html`.
Scope is only the three LLM protocol paths:

- `openai-chat`
- `openai-responses`
- `anthropic`

Computer-use and broader productization work are out of scope for this plan.

## Architecture Rule

API recovery must follow one chain:

`error envelope fixture -> ErrorFailoverReason -> RecoveryIntent -> RecoveryAction -> retry context mutation -> recovery trace -> contract test`

No new provider string pattern or recovery action should be added without a contract case.
Deterministic request compatibility changes that do not depend on a failed
attempt must go through the small preflight registry in
`apiRequestPreflight.ts`; those rules need stable ids, protocol/model gates, and
unit coverage. If the behavior is failure-driven, it belongs in the semantic
observe/decide/execute path instead.

The detailed intake rule for newly observed provider errors lives in
`docs/api-provider-envelope-fixture-policy.md`. In short, every new provider
envelope must land as:

`provider envelope -> error fixture -> ErrorFailoverReason -> RecoveryIntent -> RecoveryAction -> retry context mutation -> recovery trace -> contract test`

The retry architecture is split into six responsibilities:

- Observation: `RecoverySession.observeFailure()` records every failed attempt with
  semantic reason, status, retryability, previous reason, first-failure flags, and
  consecutive-same-reason count. It normalizes protocols to `openai-chat`,
  `openai-responses`, `anthropic`, or `axiomate-generic`.
- History: `RecoverySession.history` exposes observations, decisions,
  previous decision, and helper counters. Decisions can now reason over a
  changing sequence such as first `400 unsupported_parameter`, then `502`.
- Decision: `decideRecovery()` consumes the latest observation plus session context
  and produces a single `RecoveryDecision`.
- Rule registry: `recoveryRules.ts` contains the declarative semantic recovery
  table. Hermes/OpenAI/Anthropic corner cases should land here as rules, not as
  new retry-loop branches. Every rule declares reasons, protocols, intent,
  allowed actions, repeat policy, and no-decision behavior.
- Intent: `RecoveryIntent` records the semantic recovery purpose. Product
  diagnostics should read intent first, then action/mutation details.
- Execution: `withRetry()` applies the decision by mutating `RetryContext`,
  sleeping/backing off, delegating, failing, aborting, or triggering model fallback.
- Orchestration: `withRetry()` owns the outer attempt loop and emits trace after
  every decision, including failed recovery decisions.

## Current Position vs Productization Report

As of 2026-05-30, the API part of
`docs/axiomate-productization-stability-report.html` is no longer a blank gap.
The core reliability architecture is in place:

- semantic observation / history / decision / execution split
- declarative recovery rule table
- recovery intent/action taxonomy
- request mutation flags for the three protocol paths
- deterministic request preflight registry for narrow provider compatibility
  guards
- golden request, stream, error, and trace fixtures
- stream watchdog trace and non-streaming fallback trace
- unified API timeout policy labels and budgets for stream idle,
  non-streaming fallback, and auxiliary API paths
- stream-creation generic 404 fallback trace contract
- direct API error request id and inner-cause trace capture
- SDK retry suppression so provider failures reach Axiomate's classifier
- auxiliary trace plumbing for side-query, inference, token counting, model
  validation, compact, session search, and related product helpers
- model-routing execution: `models` is the concrete model resource map, while
  main-loop routes and auxiliary task policies provide model candidates and
  policy gates for the unified recovery decision layer; session overrides
  resolve as explicit `MainModelOverride` routes through AppState, UI display,
  and main-loop route-chain execution
- `/doctor` API provider cards consume the same recovery traces and show
  route/model/protocol next actions for the current session

The remaining API-core work is ongoing hardening, not a known architectural
gap:

1. Add narrow fixtures only when new provider envelopes appear in dogfood.
2. Keep real-provider `gate:api:integration` as release confidence; provider
   latency can still make the live gate slower than unit contracts.
3. Credential-pool rotation remains a separate product policy decision if
   Axiomate adopts pooled credentials later.

The API harness core now covers the previous three gaps: OpenAI Responses
null-output / malformed-response recovery, Hermes-style partial stream
continuation, and semantic auxiliary recovery budgets for foreground, fast,
quality, and background auxiliary paths.

## API Harness Work Board

Snapshot date: 2026-05-30.

Scope for this board excludes computer-use and non-API diagnostics. `/doctor`
API failure cards are included for the current session-local product slice.

| Area | Current position | Remaining API-harness work | Priority |
|---|---|---|---|
| Observe / decide / execute architecture | Core complete. `RecoverySession` observes, `decideRecovery()` chooses, and `withRetry()` / auxiliary runners execute. Route policy only gates `switch_model`; it is not a second recovery table. Fallback availability is now a structured per-observation input with candidate model, denial reason, and policy snapshot instead of a shared mutable gate. Stream-creation `model_not_found` uses retry-layer delegated handoff plus a boundary decision trace before model fallback, so the boundary does not silently switch models. | Keep this boundary intact. New provider cases must enter through fixtures and recovery rules. | Guardrail |
| Three-protocol recovery matrix | Mostly complete for OpenAI Chat, OpenAI Responses, and Anthropic. Request mutation, stream fallback, malformed response, partial stream, timeout, rate-limit, and image recovery paths are covered. | Add only narrow fixtures for newly observed provider envelopes. | Ongoing |
| Hermes resilience intake | API-core lessons are mostly absorbed: request validation 400/502, unsupported fields, Responses encrypted replay/null output, Anthropic thinking/long-context/image, stream stalls, generic 404, SDK retry suppression, wrapped metadata bodies, xAI/Grok sanitizers. | Credential-pool rotation is intentionally not implemented until pooled credentials become a product policy. OAuth/stale-call guidance belongs to product diagnostics. | Mostly done |
| Main route fallback | Route chains, semantic `switch_model`, per-observation policy snapshots, trace fields, `/model` persistence, onboarding route selection, provider-cache isolation, strict final-shape config reads, and route-aware session overrides are implemented. | Keep new route features behind the same decision/policy snapshot tests. | Done |
| Model configuration product surface | Complete for the current API-harness milestone. Final config shape is active, user config has been updated to route/task policy shape, `/model add` reports structured route usage, ModelEditor validates route/task references, `/model` can administer route/aux policy without JSON edits, and first-user model configuration docs exist at `docs/user/model_configuration_zhcn.html`. | Keep docs/examples aligned with `models`, `model.routes`, `auxiliary`, and `MainModelOverride`. | Done |
| Auxiliary route runner | Complete for API-harness scope. Central runner covers `queryAuxiliaryTask()` / route-first `sideQuery()` / direct helper paths; `apiQueryHookHelper` accepts auxiliary task policies; `hookAgent` full-query execution accepts route policy overrides; final disposition behavior has a fixture matrix. | Keep live-provider fallback coverage in the release gate. | Done |
| Release confidence | `pnpm run gate:api` passes locally. `pnpm run gate:api:integration` runs the local gate plus real-provider fallback checks for one main route and one auxiliary task; use it as release confidence when live providers are reachable and responsive. | Keep this gate as the release-confidence check for API harness changes. | Done |

### Remaining Work Queue

| Order | Task | Status | Exit condition |
|---|---|---|---|
| 1 | Freeze the strict configuration contract | Done | Config read/write paths accept only `models`, `model.routes`, `auxiliary`, and explicit session route overrides. `models` is a resource map only; runtime routing requires explicit route/task policy. |
| 2 | Route-ize session override semantics | Done | Bootstrap and AppState both use `MainModelOverride`; ModelPicker, `/model show`, PromptInput, TeamCreateTool, and `query()` resolve session overrides as default/named/single-model routes without mutating global config. |
| 3 | Finish `/model add` result semantics | Done | Onboarding returns whether the model was persisted as active primary, fallback candidate, or models-only; `/model add` reports that result and only updates AppState when the new model is actually active. |
| 4 | Add ModelEditor route-reference validation | Done | Editing a model validates `models`, `model.routes`, and `auxiliary`; broken route/task references are blocked with explicit paths before save. |
| 5 | Complete `/model` route administration surface | Done | Commands can inspect and edit the final route/task policy surface without JSON hand-editing: route create/delete/rename/show, route policy fields, auxiliary fallback chains, and auxiliary policy fields. |
| 6 | Lock final config examples and onboarding persistence | Done | `~/.axiomate.json`, integration config fixtures, onboarding flow, `/model show`, settings UI, and first-user docs use `models`, `model.routes`, `auxiliary`, and `MainModelOverride` semantics. |
| 7 | Run configuration-system gate | Done | Focused model route, onboarding, config validation, ModelEditor, `/model`, typecheck, and `pnpm run gate:api` pass locally. |
| 8 | Migrate `utils/hooks/apiQueryHookHelper.ts` | Done | Helper enters the central auxiliary route/task runner via `auxiliaryTask`, preserves explicit `getModel` as a bypass, and has route/fallback metadata tests for skill-improvement-style hooks. |
| 9 | Define `hookAgent` / `execAgentHook` semantics | Done | `query()` accepts an explicit full-query route override. `execAgentHook` uses `auxiliary.hookAgent` as a full route policy when no hook model is specified; explicit `hook.model` becomes a single-model route bypass. |
| 10 | Add auxiliary final-disposition fixture matrix | Done | Chain exhaustion tests cover `return_null`, `return_empty`, `return_original`, `fail_open`, `fail_closed`, and `propagate_error`, including caller-defined `return_original` semantics. |
| 11 | Clean task-tagged `sideQuery()` manual model/provider preselection | Done | Runtime call sites use route-first `sideQuery({ auxiliaryTask, ... })`; explicit `modelOverride` remains a deliberate provider/model bypass. |
| 12 | Retire tier-name runtime helper usage | Done | Runtime source no longer selects API models through fast/mid/current tier helpers. Runtime paths use route/task policy helpers, `queryAuxiliaryTask()`, route-first `sideQuery()`, or explicit direct-model bypasses. |
| 13 | Run real-API integration gate | Done | `pnpm run gate:api:integration` proves one main route fallback and one auxiliary fallback against real providers. |

After items 1-7, the model configuration system is product-ready enough to stop
creating semantic ambiguity while the remaining API harness work continues.
After items 8-12, the API harness body and route/task selection cleanup are complete.
Item 13 is the live-provider release confidence gate. Product diagnostics and
`/doctor` API cards are complete for the current session-local API slice.

## Hermes Resilience Intake Matrix

This matrix tracks the Hermes "resilience / tenacity" API lessons that were
audited from `C:\public\workspace\hermes-agent`.

| Hermes lesson | Axiomate status | Evidence / next action |
|---|---|---|
| Central error classifier plus structured recovery hints | Absorbed | `errorClassifier.ts`, `recoveryRules.ts`, `recoveryDecision.ts`, `withRetry.ts`. Axiomate now has a stricter observe/decide/execute split than Hermes' original retry loop. |
| 400/502 request-validation bodies should not flood generic 5xx retries | Absorbed | `unsupported_parameter` extracts omittable fields and retries with one mutation. Contract fixtures cover 400 and 502. |
| Unsupported temperature / request fields should be omitted semantically | Absorbed | `omit-unsupported-request-fields` is repeatable only for newly discovered fields. |
| `invalid_encrypted_content` on Responses reasoning replay | Absorbed | Axiomate strips Responses reasoning replay and encrypted-content include once; Responses null-output salvage is now covered separately. |
| Multimodal tool-result content rejected by OpenAI-compatible providers | Absorbed | `multimodal_tool_content_unsupported` downgrades tool result content to text. |
| llama.cpp `json-schema-to-grammar` rejects `pattern` / `format` | Absorbed | `llama_cpp_grammar_pattern` strips schema keywords before retry. |
| Anthropic thinking signature, long-context tier, OAuth long-context beta | Absorbed | `thinking_signature`, `long_context_tier`, and `oauth_long_context_beta_forbidden` have explicit rules and traceable actions. |
| Anthropic / provider image payload too large | Absorbed | `image_too_large` now selects an `ImageRecoveryProfile`, records `rewrite_image_payload_for_retry`, rewrites only the retry-local request payload through profile-specific image budgets, and fails exhausted if the same semantic error repeats. |
| Time-to-first-byte / stalled stream watchdog | Absorbed for API core | Axiomate emits stream watchdog retry traces with request id, headers, bytes, TTFB, phase, inner cause, and `stream_idle_timeout` policy fields. First-byte policy labels exist in the timeout table for future first-byte watchdog wiring if needed. |
| OpenAI Responses stream parser hits `response.output = null` / `NoneType not iterable` | Absorbed | `responses_null_output` and `malformed_response` classify semantically; completed Responses streams can be salvaged without inventing tool calls; malformed non-streaming output throws `LLMAPIError(502)` for retry. |
| Mid-tool-call partial stream should route through length continuation | Absorbed | Axiomate throws `PartialStreamRecoveryError`, creates a `partial-stream-stub` assistant message after retry exhaustion, records dropped tool names, and drives a continuation turn instead of replaying incomplete tool calls. |
| Stale-call / silent-reject patterns should surface actionable hints | Product diagnostics landed for the current `/doctor` slice | `/doctor` API cards consume recovery traces and produce route/model/protocol next actions. Further provider-specific hints should be added only after dogfood reveals unclear cards. |
| Responses request timeout sizing and stale-call defaults | Absorbed for API core | `apiTimeoutPolicy.ts` centralizes timeout semantics: stream labels, non-streaming fallback budgets, `API_TIMEOUT_MS` override, auxiliary source-aware budgets, parent-abort handling, and trace fields `timeoutKind` / `timeoutMs`. |
| Auxiliary main-model fallback and payment/rate-limit fallback | Absorbed for API harness | The M8 route/task policy runner covers auxiliary calls. `models` remains the resource map; `model.routes` and `auxiliary.<task>` define candidates and policy gates only. `decideRecovery()` still owns `switch_model` decisions. Credential-pool fallback remains a separate product decision. |
| Generic 404 without a model-not-found signal should not switch models | Absorbed | Generic 404 now classifies as retryable `unknown`; explicit model-not-found bodies still classify as `model_not_found`. Stream creation routes generic 404 immediately to the outer non-streaming fallback delegate instead of burning retry attempts or switching models. Stream-creation `model_not_found` is delegated by `withRetry` and only switches model after the boundary emits a formal fallback decision trace. |
| Message-only 413 / payload-too-large wrappers | Absorbed | `payload_too_large` now recognizes message-only `request entity too large`, `payload too large`, and `error code: 413` shapes. |
| SDK `RateLimitError` without HTTP status | Absorbed | Constructor-name detection maps it to semantic `rate_limit` with status 429. |
| Wrapped `metadata.raw` provider bodies | Absorbed | Classifier extracts pattern text and error codes from nested `metadata.raw` JSON, including OpenRouter-style upstream provider envelopes. |
| xAI OAuth `service_tier` strip and slash-enum sanitization | Absorbed for API core | `service_tier` is both omittable through `unsupported_parameter` recovery and stripped deterministically for Grok Responses preflight. Grok slash-enum failures now flow through `slash_enum_unsupported -> sanitize_slash_enum_schema -> strip_slash_enums -> RetryContext.stripSlashEnums -> trace/fixture`, with preflight kept as a narrow deterministic compatibility guard. |
| Credential-pool rotation on exhausted credentials / weekly usage limits | Not implemented / product decision | Axiomate does not currently have Hermes-style pooled credentials in the API core. If added, it must become a recovery action, not an inline retry-loop branch. |
| OAuth 401 actionable guidance | Product diagnostics landed for the current `/doctor` slice | Auth failures map to concrete `models["..."].apiKey` / account access guidance in API failure cards. Further OAuth-specific wording can be refined after dogfood. |

## Productization Report API Gap Matrix

| Report requirement | Current status | Remaining work |
|---|---|---|
| Unified recovery action table across OpenAI Chat, OpenAI Responses, and Anthropic | Mostly complete | Keep all new provider patterns behind `ErrorFailoverReason -> RecoveryIntent -> RecoveryAction -> trace -> fixture`. |
| OpenAI Chat request/error/stream/retry contract matrix | Mostly complete | Add only narrow edge fixtures as new envelopes appear. The original P0 cases are covered: stream unsupported, endpoint 404, model-not-found fallback, max-token drop, unsupported field omission, rate limit, 502 validation, server error, and stream-fallback negatives. |
| OpenAI Responses as its own protocol, not just Chat with different fields | Mostly complete | Event-order fixtures, encrypted replay recovery, semantic null-output / malformed-response recovery, and safe completed-stream salvage exist. Add only narrow edge fixtures as new envelopes appear. |
| Anthropic Hermes-derived failure classes | Mostly complete | Image-too-large retry is implemented. Keep adding fixtures for new subscription or payload envelope shapes. |
| Side query / verify / compact / token counting share taxonomy | Mostly complete | Auxiliary paths now use semantic recovery budgets; token counting remains fallback-to-local-estimation; verify keeps its existing bounded verification loop. |
| Every recovery action emits structured trace | Core complete | `/doctor` or session diagnostics must consume traces so users can see reason, mutation, delay, fallback, and final outcome. |
| Golden fixtures for request body, stream chunks, error envelopes, retry traces | Mostly complete | Enforce as a release gate, not only as local tests. Keep adding fixtures when new provider envelopes appear. |
| Rate-limit / overload policy | Mostly complete | `retry-after`, foreground gating, jitter, and repeated-529 fallback exist. Credential-pool rotation is missing because pooled credentials are not part of current API core. |
| Stream diagnostics | Mostly complete | Stream-idle traces now carry timeout policy labels. A separate first-byte watchdog remains optional if product diagnostics need that distinction operationalized, not only represented in the policy table. |
| Main and auxiliary model routing / fallback | Complete for API harness | Main-loop route-chain fallback, route/task config, `/model` route persistence, onboarding route selection, provider-cache isolation, session override route semantics, helper retirement, and the central auxiliary runner are implemented. Real-provider integration remains as release confidence. |
| API failure cards in `/doctor` | Complete for the current session-local slice | Keep real-provider dogfood as release confidence and refine wording only for observed unclear cards. |

## Status

### M0: Recovery Contract v1

Status: complete.

Delivered:

- `recoveryAction.ts`: unified recovery action names.
- `recoveryIntent.ts`: semantic recovery intent names for trace, `/doctor`, and reports.
- `recoverySession.ts`: structured per-request recovery observation history.
- `recoveryRules.ts`: extensible semantic recovery rule registry.
- `recoveryDecision.ts`: pure outer recovery decision policy over observation history and retry context.
- `recoveryTrace.ts`: structured recovery trace events.
- `withRetry.ts`: outer retry loop plus execution of recovery decisions.
- `llm.ts`: passes provider protocol name into retry options.
- Unit coverage for recovery action mapping and trace emission.
- Rule registry coverage requiring stable ids, one-shot behavior, context patches,
  and mutations for semantic recovery rules.
- Recovery trace includes both semantic intent and concrete action.

Acceptance:

- API unit tests pass.
- Type checking passes.
- Current retry semantics stay contract-stable.

### M0.5: Recovery Contract v2

Status: complete.

Delivered:

- `RecoveryProtocol`: explicit protocol type with `axiomate-generic` as the
  generic mode. `axiomate` is no longer used as an ambiguous wildcard.
- `RecoveryHistory`: history view with previous observation, previous decision,
  rule/action/intent counters, and last-decision lookup helpers.
- `RecoveryRule` v2 schema:
  - `reasons`
  - `protocols` or `any`
  - `intent`
  - `actions`
  - `repeatPolicy`
  - optional precondition / no-decision behavior / rule-local decision builder
- Rule invariants:
  - unique stable ids
  - every rule declares protocol scope and repeat policy
  - dynamic rule decisions must return the owning rule id, expected intent,
    expected repeat policy, and one of the rule's allowed actions
  - mutation-style rules use one-shot or delegate-once repeat policy
- History-aware decisions:
  - one-shot semantic recoveries become `fail_recovery_exhausted` when repeated,
    rather than falling back to generic retry/backoff
  - repeatable unsupported-field recovery only mutates newly discovered fields
  - context-overflow output-budget recovery avoids repeating the same max-token
    override until the reason changes
- Trace v2 fields:
  - `traceId`
  - `observationId`
  - `decisionId`
  - `ruleId`
  - `repeatPolicy`
  - `previousIntent`
  - `previousAction`
  - `final`
- Contract tests:
  - `recoveryArchitectureContracts.test.ts`
  - updated rule registry tests
  - updated `withRetry` history trace tests
  - updated OpenAI Chat retry-trace golden fixture

Acceptance:

- `pnpm --filter ./agent exec vitest run src/__tests__/unit/services/api`
  passes.
- `pnpm --filter ./agent run build:types` passes.

### M1: Semantic Error Taxonomy and Hermes Corner Cases

Status: complete for foundation; more cases can now be added as fixtures.

Delivered:

- Added first-class semantic reasons:
  - `unsupported_parameter`
  - `invalid_encrypted_content`
  - `multimodal_tool_content_unsupported`
  - `llama_cpp_grammar_pattern`
  - `oauth_long_context_beta_forbidden`
  - `image_too_large`
  - `provider_policy_blocked`
  - `content_policy_blocked`
  - `streaming_unsupported`
  - `stream_endpoint_not_found`
  - `slash_enum_unsupported`
- Added recovery actions:
  - `omit_request_fields`
  - `strip_reasoning_replay`
  - `downgrade_multimodal_tool_content`
  - `strip_json_schema_keywords`
  - `disable_long_context_beta`
  - `rewrite_image_payload`
  - `strip_slash_enums`
- Added retry context mutation flags consumed by OpenAI Chat, OpenAI Responses, and Anthropic request construction.
- Added contract table at `agent/src/__tests__/unit/services/api/contracts/apiRecoveryContracts.test.ts`.
- Added Hermes-derived request-edge cases for generic 404, message-only 413,
  status-less `RateLimitError`, wrapped `metadata.raw` bodies, xAI/Grok
  `service_tier`, and Grok slash-enum schema sanitization.
- Added `apiRequestPreflight.ts` for deterministic request compatibility rules
  that should run before the first failed attempt. The current rule strips
  Grok Responses `service_tier` and slash-containing schema enum values behind
  explicit protocol/model gates.

Acceptance:

- Hermes-derived corner cases classify to semantic reasons, not generic `format_error` or `unknown`.
- Recoverable cases mutate the next request once, then fail fast if the same semantic error repeats.
- Non-recoverable account/provider-policy errors fail fast. Per-prompt
  `content_policy_blocked` is deterministic for the unchanged request, so it
  does not retry the same model; it can only switch model when route policy and
  a distinct fallback candidate allow `switch_model`.

### M2: OpenAI Chat Contract Matrix

Status: report P0 matrix mostly complete; request/error/trace fixture foundation
and core stream chunk fixtures complete.

Covered now:

- Golden request-body fixtures for normal stream retries and request mutations:
  drop `max_tokens`, omit unsupported fields, strip unsupported JSON schema
  keywords, and downgrade multimodal tool results.
- Golden error-envelope fixtures for Chat fallback routing and semantic recovery.
- Golden retry trace fixtures for core Chat request mutations.
- `400 stream unsupported` classifies as `streaming_unsupported` and remains
  eligible for non-streaming fallback.
- `404 stream endpoint missing` classifies as `stream_endpoint_not_found` and
  remains eligible for non-streaming fallback.
- `404 model_not_found` routes to model fallback instead of non-streaming fallback.
- Generic stream-creation `404` produces a delegated recovery decision trace at
  `client_init`, then an outer non-streaming fallback trace with request id and
  cause.
- `400 max_tokens too large` drops `max_tokens` once.
- `400/502 unsupported parameter` omits the named request field once.
- Transport, timeout, rate-limit, overload, server error, context overflow, thinking signature, and long-context tier are negative cases for non-streaming fallback.
- llama.cpp grammar errors strip JSON schema `pattern` / `format` before retry.
- Stream chunk golden fixtures cover started stream, partial text stream flush,
  inline malformed error envelope, and empty stream.
- Partial tool-use stream commits are explicitly protected from non-streaming
  fallback replay.
- Local stream-shape failures and empty streams classify as
  `malformed_response` and retry the streaming path first; they no longer
  trigger non-streaming fallback merely because no assistant output was
  committed.

Remaining:

- Keep adding edge fixtures when new OpenAI-compatible provider envelopes appear.
- Optional: expand `deferModelNotFoundFallback` fixtures to spell out every
  with/without-fallback and model-name/no-model-name variant, even though the
  core routing behavior is already covered.

### M3: OpenAI Responses Protocol Recovery

Status: core stream contract complete; Hermes null-output salvage and semantic
malformed-response expansion implemented.

Covered now:

- `invalid_encrypted_content` strips Responses reasoning replay and omits encrypted-content include before retry.
- Empty/malformed non-streaming response now throws semantic `LLMAPIError(502)`
  and classifies as `responses_null_output` or `malformed_response` where
  applicable.
- Responses request adapter already preserves reasoning round-trip when valid.
- Event-order golden fixtures cover:
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added` / `.done`
  - text deltas
  - function-call argument deltas
  - reasoning summary deltas with encrypted round-trip metadata
  - completed responses with incomplete status / max-token stop reason
  - `response.incomplete` stream error
  - malformed text delta before message item
- Responses stream-shape failures and empty streams retry the streaming path
  first as `malformed_response`; they no longer trigger non-streaming fallback
  merely because no assistant output has been committed.
- Non-streaming fallback remains reserved for explicit stream-mode
  incompatibility (`streaming_unsupported`) or stream endpoint 404
  (`stream_endpoint_not_found`), matching the Chat duplicate-tool-execution
  guard.
- Responses stream creation 404 now defers model fallback like Chat, preserving
  outer non-streaming fallback routing.
- Responses non-streaming fallback now rejects empty content with
  `LLMAPIError(502)`, keeping it in retryable `server_error` semantics instead
  of returning an empty assistant message.
- Added first-class `responses_null_output` and `malformed_response`
  classifier reasons.
- `retry-malformed-responses-output` retries malformed Responses output with
  an `until_reason_changes` repeat policy.
- Completed Responses streams can emit `salvage_stream_output` /
  `salvage_completed_stream_output` trace and finish from already received
  stream content if the parser only fails on terminal `response.output=null`.
- Salvage never fabricates missing tool calls; partial tool-call drops are
  handled by the separate partial-stream continuation path.

Remaining:

- Add narrow fixtures for any newly observed Responses malformed-output
  envelopes.

### M4: Anthropic-Specific Recovery

Status: core recovery loop complete; remaining items are narrower fixtures.

Covered now:

- `thinking_signature` disables thinking and retries.
- `long_context_tier` maps to explicit semantic recovery:
  `lower_long_context_tier -> lower_context_tier`.
- `lower_context_tier` is carried through `RetryContext`,
  `CannotRetryError`, assistant API-error metadata, query reactive compact,
  and `autoCompactIfNeeded()`.
- Reactive compact can now run in forced mode for `lower_context_tier`, so the
  Anthropic long-context tier gate can compact and retry even when the normal
  model-window threshold would decline proactive autocompact.
- Forced reactive compact preserves the existing safety rails: global compact
  disable, compact/session-memory recursion guards, and consecutive-failure
  circuit breaker.
- Compaction diagnostics now record `recoveryAction` and `forced` for API-driven
  reactive compaction.
- `oauth_long_context_beta_forbidden` removes context beta headers and retries once.
- Image-too-large classifies separately and retries once through
  `rewrite_image_payload_for_retry` instead of blind retrying.
- `ImageRecoveryProfile` maps provider wording to deterministic retry-local
  image rewrite policies:
  `fit_provider_image_limit`, `fit_many_image_dimension_limit`,
  `aggressive_size_compression`, and
  `drop_or_textualize_tool_result_images`.
- The rewrite executor mutates only the next request payload. It does not change
  persisted conversation history, and repeat `image_too_large` fails as
  exhausted recovery.
- OpenAI Chat, OpenAI Responses, and Anthropic request builders all consume the
  same `rewriteImagePayload` retry context flag and profile.
- Anthropic contract fixtures now cover thinking-only streams as committed
  responses, preventing them from being treated like empty/malformed streams.
- Anthropic request contract fixtures now cover tool content block ordering:
  `tool_result` blocks are normalized before ordinary user text before crossing
  the provider boundary.

- Add any newly observed Anthropic subscription / payload envelopes as contract
  fixtures before adding patterns.

### M5: Stream Reliability Observability

Status: foundation and watchdog trace fixtures complete.

Covered now:

- `RecoveryTraceEvent` supports stream observability fields:
  - `requestId`
  - `ttfbMs`
  - `elapsedMs`
  - `bytesReceived`
  - `streamPhase`
  - `innerCause`
  - `safeHeaders`
- `withRetry()` can consume a request-scoped `RecoveryTraceContext` and attach
  those fields to every recovery decision trace.
- `withRetry()` also copies request ids and direct `LLMAPIError` summaries from
  the thrown error when no stream context is available, so creation-time failures
  are still attributable.
- Safe header filtering keeps diagnostic headers such as retry-after, request
  id, OpenAI rate-limit headers, and Anthropic rate-limit headers while dropping
  credentials.
- Main stream orchestration writes existing lifecycle signals into the trace
  context:
  - attempt start
  - response headers
  - TTFB
  - streaming
  - stream complete
  - fallback
- Anthropic stream request id and response headers flow through the existing
  provider result path.
- OpenAI Chat and Responses stream paths now attempt to surface SDK request ids
  when the SDK exposes them.
- OpenAI Chat, OpenAI Responses, and Anthropic stream paths emit provider-neutral
  byte-count events from raw stream chunks/events. `llm.ts` accumulates them into
  `RecoveryTraceContext.bytesReceived`.
- The inner stream-consumption retry path in `llm.ts` now emits a recovery trace
  before sleeping and retrying, with the same stream observability context.
- Direct provider tests cover byte-count events for OpenAI Chat, OpenAI
  Responses, and Anthropic streams.
- Stream-shape fallback is disabled once an assistant message has already been
  committed, preventing duplicate tool execution on partial stream failures.
- Non-streaming fallback now emits a semantic `RecoveryTraceEvent` with
  `intent: switch_to_non_streaming` and `action: non_streaming_fallback`.
- Golden fixtures now cover model fallback, delegated recovery, and
  stream-shape non-streaming fallback trace branches, including generic
  stream-creation 404 fallback.
- Stream watchdog timeout now emits a semantic retry trace before sleeping and
  retrying, including request id, TTFB, byte count, safe headers, stream phase,
  inner timeout cause, timeout policy fields, retry intent, and retry action.
- Golden fixtures now cover observability-first stream watchdog retry.
- Mid-stream failures after partial assistant text/tool accumulation now throw
  `PartialStreamRecoveryError` instead of replaying unsafe fallback calls.
- After stream-consumption retries are exhausted, `llm.ts` creates a
  `partial-stream-stub` assistant message with `stop_reason: max_tokens` and
  `partialStreamRecovery` metadata.
- `query.ts` routes the stub through a continuation turn and distinguishes
  network text continuation, dropped mid-tool-call continuation, and ordinary
  max-output continuation.

Remaining:

- Optional: add an active first-byte watchdog if product diagnostics need to
  distinguish "request sent but no first token" from post-first-event idle
  stalls in runtime behavior. The policy labels already exist.
- Add edge fixtures if new partial-stream provider shapes appear.

### M6: Side Query / Inference Parity

Status: product trace plumbing complete; semantic auxiliary recovery budgets
implemented.

Covered now:

- Added an auxiliary API recovery trace layer for non-main-loop API paths.
- `InferenceRequest` and `CountTokensRequest` can carry `onRecoveryTrace` and
  `querySource`.
- `sideQuery()` passes recovery trace sinks through to provider inference.
- OpenAI Chat, OpenAI Responses, and Anthropic `inference()` error paths emit
  semantic recovery traces.
- Anthropic `verifyConnection()` emits semantic recovery traces when final
  verification fails after its bounded retry loop.
- Anthropic `countTokens()` emits semantic recovery traces before returning
  `null` for fallback-to-local-estimation behavior.
- Auxiliary traces explicitly separate actual execution from recommendation:
  `action: fail_fast` records that the auxiliary path did not retry, while
  `recommendedAction` / `recommendedIntent` preserve the semantic recovery that
  the main loop would use.
- `withAuxiliaryRecovery()` now assigns auxiliary API recovery budgets from
  semantic context: background direct helpers do not retry locally, validation
  and fast auxiliary tasks get one recovery retry, and foreground/quality
  auxiliary work gets two recovery retries.
- Auxiliary recovery uses the same observe/decide/execute rule table as the
  main recovery loop and records observation id, decision id, previous
  reason/action, mutation, safe headers, and final outcome.
- Provider `inference()` paths honor `suppressAuxiliaryRecoveryTrace`, so the
  outer auxiliary harness owns trace emission and provider catch blocks only
  normalize/rethrow.
- Side-query retries can apply semantic request mutations for unsupported
  fields, JSON schema keyword stripping, multimodal tool-result downgrades,
  thinking disable, and max-token omission/override.
- Golden fixtures now cover side-query rate limit, inference malformed response,
  and count-token context overflow traces across the three protocols.
- `ToolUseContext` now has a shared `onRecoveryTrace` sink. The main query
  loop passes it into `queryModelWithStreaming()`, so forked agents and
  side-question/compact forks inherit the same trace channel.
- Compact's direct streaming fallback passes `onRecoveryTrace` into the API
  layer.
- Product auxiliary helpers now accept or inherit trace sinks where they call
  API paths: model validation, permission explainer, session search
  summarization, agentic session search, memdir relevance selection, file-read
  token counting, MCP token counting, and tokenCounting auxiliary fallback.
- `apiTimeoutPolicy.ts` now applies source-aware auxiliary budgets
  (`side_question`, `verification_agent`, and `session_search` get foreground
  time; validation helpers get bounded validation time; background helpers get
  short time) and wraps auxiliary attempts so SDKs cannot hang beyond the local
  timeout even if they ignore abort signals.
- OpenAI Chat, OpenAI Responses, and Anthropic non-streaming fallback paths use
  the same timeout policy; timeout failures record `timeoutKind` and
  `timeoutMs` in recovery traces.
- OpenAI Chat, OpenAI Responses, and Anthropic inference/count-token auxiliary
  paths use the unified timeout wrapper and policy labels.
- OpenAI Chat and OpenAI Responses provider clients are constructed with
  SDK-level retries disabled, and per-call SDK options also pass
  `maxRetries: 0`.
- Anthropic stream and non-stream paths already used `withRetry()` with
  SDK retries disabled; `verifyConnection()`, `inference()`, and
  `countTokens()` now also disable SDK-level retries so provider failures are
  visible to semantic classification and recovery tracing.
- Focused plumbing tests cover `query()` to API options, neutral sideQuery and
  token-counter forwarding, foreground auxiliary recovery budgets, background
  no-recovery behavior, auxiliary request mutation, session-search forwarding,
  agentic session-search forwarding, and SDK retry suppression.

Remaining:

- Wire a product-facing consumer for recovery traces, such as `/doctor` API
  failure cards or a session diagnostics panel. The event channel now exists;
  UX presentation is still M7/productization work.
- Add more product-facing fixtures for auxiliary model fallback if new task
  classes are introduced. The route/task policy runner itself is implemented.
- Decide whether credential-pool fallback or bounded retry for additional
  auxiliary operations should exist as product policies.

### M7: API Release Gate

Status: local API gate available; full release gate still needs product-facing
diagnostics and checklist enforcement.

Current local gate:

- `pnpm run gate:api`

This expands to:

- `pnpm run test:api`
- `pnpm run build:types`
- `git diff --check`

Available now:

- Dedicated contract fixture folder with golden request, stream, error, and trace fixtures.
- Provider envelope fixture policy at
  `docs/api-provider-envelope-fixture-policy.md`.
- Unified timeout policy at `agent/src/services/api/apiTimeoutPolicy.ts`,
  with unit coverage for stream labels, non-streaming budgets, auxiliary
  budgets, parent abort, and trace context projection.
- Architecture contract tests for recovery history, protocol normalization, and
  rule metadata.
- Rule registry invariant tests.
- Retry trace golden fixture includes semantic intent, action, rule id, repeat
  policy, previous decision, mutation, and final outcome.
- Fallback/delegated/stream-fallback trace fixtures cover the non-mutation
  recovery branches.

Remaining:

- Release checklist requiring:
  - no new string pattern without fixture
  - no new recovery action without trace test
  - three-protocol recovery matrix updated
  - product `/doctor` API failure card consumes recovery trace

#### M7A: `/doctor` API Failure Cards Plan

Canonical plan: `docs/doctor-api-ui-plan.md`.

Status: core product diagnostics slice landed on 2026-05-29. This is not a new
retry system; it is the product-facing consumer for the recovery traces already
emitted by the API harness.

Landed:

- `apiRecoveryDiagnostics` session-local in-memory ring buffer stores recent
  safe `RecoveryTraceEvent` projections. It is process-local, bounded, and does
  not write prompts, request payloads, raw authorization headers, API keys, or
  raw provider error bodies to disk.
- The main interactive REPL now wires `ToolUseContext.onRecoveryTrace` to the
  diagnostics store, so main-loop recovery traces and inherited auxiliary/side
  calls have a product-facing sink in addition to debug logging.
- `apiFailureCards` projects trace groups into user-facing cards with severity,
  status, scope, impact, model path, observed failure, timeline, stopped reason,
  and one concrete next action.
- `/doctor` mounts an `API Providers` section using the repo's built-in Ink
  `Box`/`Text` rendering style. Empty state is silent; recent API cards render
  newest first.
- Unit coverage now locks ring-buffer bounds, defensive copies, header
  redaction, multi-attempt grouping, fallback grouping, final-failed severity,
  and Doctor section rendering through the repo's built-in Ink static renderer.
- Diagnostics listing now returns defensive deep copies of nested safe metadata,
  and `/clear` / foreground resume clear session-local API traces to avoid stale
  Doctor cards.
- Trace projection now distinguishes model fallback, request-mode fallback,
  request-shape adaptation, failed adaptation, compaction delegation, stream
  salvage, and route-policy-blocked failures.
- Trace projection no longer treats fallback-candidate metadata as a completed
  model switch unless the executed action is `fallback_model`.
- `withRetry` emits a stable trace id for each retry session, while retaining
  per-attempt observation/decision ids. Doctor therefore groups one
  observe/decide/execute recovery sequence into one card.
- Successful retries now emit a trace-only `recovered` execution outcome after
  the operation succeeds. This is deliberately excluded from recovery decision
  outcomes, so rules still describe decisions and Doctor can show the final
  execution result without changing retry behavior.
- Route policy gates are recomputed per observed failure reason and snapshotted
  into each trace event, preventing a previous attempt's `reasonAllowed` /
  `actionAllowed` result from mutating later decisions or earlier diagnostics.
- Provider onboarding verification now writes API recovery traces into the same
  Doctor store, so setup-time API failures use the same taxonomy as runtime
  requests.
- Doctor card copy points to concrete model route/config fields when trace ids
  are available, such as `models["deepseek-main"].baseUrl` and
  `model.routes["quality-main"].fallbackChain`; it falls back to
  `models.<model>` / `model.routes.<route>` placeholders only when the trace
  lacks the concrete id.
- Doctor UI renders safe advanced metadata as dim text for operation, protocol,
  route, auxiliary task, rule ids, and allowlisted headers.

Remaining:

- Dogfood real provider failures to refine copy and confirm every source path
  appears in `/doctor` during normal interactive use.
- Revisit whether advanced details should remain always dim or move behind a
  verbose/expand mode after dogfood.
- Add broader end-to-end Doctor coverage only after real provider dogfood shows
  gaps that unit/static-render fixtures do not cover.

Goal:

- Make API failures explainable without asking users to inspect debug logs.
- Show what Axiomate observed, what the decision layer chose, what execution did,
  and why recovery stopped or switched model.
- Keep sensitive data out of diagnostics: no prompts, request payloads, API keys,
  authorization headers, file contents, or raw user text.

Data flow:

1. Add a session-local API recovery diagnostics store.
   - Input: `RecoveryTraceEvent` from `ToolUseContext.onRecoveryTrace`.
   - Shape: bounded ring buffer, newest first, safe to render in `/doctor`.
   - Retention: enough recent events for a normal session, without writing
     prompts or payload data to disk.
   - Fields to preserve: timestamp, trace id, protocol, operation, route id,
     auxiliary task, model, from/to model, chain index, attempt, max attempts,
     reason, intent, action, outcome, final flag, rule id, mutation,
     status code, request id, timeout kind/ms, stream phase, elapsed/TTFB,
     bytes received, safe headers, policy gate, previous reason/action.
2. Add a projection layer from traces to user-facing failure cards.
   - Group related events by trace id when available; otherwise by operation,
     route/task, protocol, model, and timestamp window.
   - Compute final status: recovered, switched model, adapted request,
     salvaged, stopped, aborted, or exhausted.
   - Preserve attempt history so a sequence such as `400 unsupported_parameter`
     followed by `502 server_error` is shown as one recovery session, not as a
     overwritten error.
3. Map semantic reasons and intents to next actions.
   - `auth` / permanent auth: check API key, provider account, env var, or
     provider preset.
   - `billing`: top up, change model/provider, or choose a cheaper route.
   - `rate_limit` / `overloaded`: wait, respect retry-after, use another route,
     or adjust fallback chain.
   - `timeout` / `connection` / stale socket: check network, proxy, base URL,
     gateway, or timeout policy.
   - `model_not_found` / endpoint mismatch: check model id, protocol, base URL,
     and provider route.
   - `unsupported_parameter`, schema, max-token, image, multimodal, thinking, or
     encrypted-content errors: show the request mutation Axiomate attempted and
     whether it was exhausted.
   - `provider_policy_blocked`: change provider/account policy, model, or route.
   - `content_policy_blocked`: the provider safety/content filter rejected this
     prompt; rephrase the request, or allow a fallback provider for
     `content_policy_blocked`.
   - `responses_null_output`, `malformed_response`, local stream-shape
     failures, empty streams, or stream watchdog stalls: show
     provider/gateway compatibility guidance and whether stream retry or stream
     salvage was used.
   - `streaming_unsupported` / `stream_endpoint_not_found`: show that a narrow
     request-mode rule triggered non-streaming fallback.
   - OAuth/stale-call/silent-reject patterns use the same mapping once their
     trace evidence is present; this is product guidance, not a retry branch.

`/doctor` UI:

1. Add an `API Providers` section to `/doctor`.
   - If no API recovery events exist, show no noisy success card by default.
   - If events exist, show up to the most recent few failure cards, newest first.
2. Card header:
   - severity: warning for recovered/degraded, error for final failed,
     info for adapted/salvaged.
   - short title: for example `API request recovered by switching model`,
     `Provider rejected request shape`, or `API request exhausted retries`.
   - scope: main route, auxiliary task, or direct helper operation.
3. Card body:
   - impact: main response, model validation, token counting, session search,
     permission explanation, compact, or other operation.
   - model path: route id plus `primary -> fallback` transition when present.
   - observed failure: semantic reason, status code, request id, and safe header
     summary such as retry-after or provider request id.
   - recovery timeline: compact list of attempts with reason, action, mutation,
     delay, and outcome.
   - why it stopped: final trace reason, policy gate rejection, exhausted
     one-shot mutation, no fallback candidate, parent abort, or non-retryable
     failure.
   - next action: one concrete user step plus the relevant command/config
     target, such as `/model route show`, `/model fallback add`, provider key
     env var, or Settings config path.
4. Advanced details:
   - Keep raw internal fields collapsed or visually dim: trace id, rule id,
     observation/decision id, timeout kind, elapsed/TTFB, bytes received, safe
     headers, previous reason/action, policy gate details.
   - Never render prompts, request body, tool inputs, API keys, bearer tokens, or
     raw authorization headers.
5. Cross-product alignment:
   - Provider setup minimal verify should later write into the same card
     taxonomy so a failed onboarding verification and a failed runtime request
     explain errors the same way.
   - MCP/plugin/settings cards can use the same visual structure, but their
     data sources stay separate from API recovery trace events.

Implementation sequence:

1. `apiRecoveryDiagnostics` store.
   - Add a small service with append/list/clear helpers and a fixed-size ring
     buffer.
   - Wire the main interactive `ToolUseContext.onRecoveryTrace` sink to append
     to the store while preserving existing debug logging.
   - Ensure subagents, compact forks, side questions, and auxiliary calls share
     the same sink when they already inherit `ToolUseContext`.
2. Card projection and copy.
   - Add a pure mapper from `RecoveryTraceEvent[]` to `ApiFailureCard[]`.
   - Keep title, severity, impact, summary, timeline, and next-action mapping in
     one tested module.
   - Prefer semantic `intent` over raw provider text when choosing copy.
3. Doctor rendering.
   - Add an `ApiProviderDoctorSection` component and mount it from `Doctor.tsx`.
   - Render compact cards first; advanced fields only after the user expands
     details or in debug mode, depending on the existing `/doctor` interaction
     pattern.
4. Tests.
   - Unit tests for reason/intent/action to card mapping.
   - Unit tests for grouping multi-attempt traces and preserving attempt order.
   - Redaction tests for headers and sensitive fields.
   - Doctor rendering test for empty state, recovered warning, and final failure.
   - API gate should keep passing; no live-provider call is required for the
     card mapper itself.

Exit criteria:

- A failed API request can be diagnosed from `/doctor` without opening debug log.
- The card shows observation, decision, execution, and final outcome.
- Main-loop, non-streaming fallback, stream fallback, and auxiliary traces can
  all appear in the same card model.
- The UI distinguishes recovered/degraded from final-failed failures.
- Every next action points to a concrete command, config field, provider account
  setting, or wait/retry instruction.
- Sensitive request data cannot appear in the card output.

### M8: Model Route and Auxiliary Fallback Policy

Status: main-loop route fallback, route persistence, session override
semantics, the auxiliary route runner, and real-provider integration confidence
are complete for the API-harness scope.

This milestone uses Hermes-style route/task policies while keeping Axiomate's
existing `models` map.

Configuration posture: model routing has one accepted shape. Runtime code,
persisted config, integration fixtures, onboarding, `/model`, and tests use
only the final contract below.

#### Final Configuration Contract

`models` stays as the concrete model resource registry. It defines model ids and
provider-specific execution details:

- `protocol`
- provider model name
- display name
- `baseUrl`
- `apiKey` or key environment reference
- context window
- image support
- thinking / effort settings
- provider compatibility flags such as `repairToolCalls`

`models` must not define runtime routing intent. The same model id can be a
primary model in one route, a fallback in another route, and an auxiliary task
model elsewhere.

Main agent routing moves into `model`:

```jsonc
{
  "model": {
    "defaultRoute": "deepseek-main",
    "routes": {
      "deepseek-main": {
        "primary": "deepseek-v4-pro",
        "fallbackChain": ["gpt-5.4", "Qwen/Qwen3.5-397B-A17B", "Qwen/Qwen3-8B"],
        "recoveryProfile": "main-agent",
        "allowActions": ["retry_same_model", "adapt_request", "switch_model"],
        "switchModelOn": ["rate_limit", "overloaded", "timeout", "connection", "server_error", "content_policy_blocked"]
      }
    }
  }
}
```

Auxiliary task routing moves into `auxiliary`:

```jsonc
{
  "auxiliary": {
    "goalJudge": {
      "primary": "Qwen/Qwen3.5-397B-A17B",
      "fallbackChain": ["Qwen/Qwen3-8B", "deepseek-v4-pro"],
      "recoveryProfile": "auxiliary-judge",
      "allowActions": ["retry_same_model", "adapt_request", "switch_model"],
      "switchModelOn": ["timeout", "connection", "server_error", "malformed_response", "content_policy_blocked"],
      "failure": "fail_open",
      "timeoutMs": 30000
    }
  }
}
```

Field semantics:

- `primary`: first model id to attempt for the route/task.
- `fallbackChain`: ordered model ids available for model-switch recovery.
- `recoveryProfile`: named policy profile used to select default retry budgets,
  failure disposition defaults, and task/route-specific recovery constraints.
- `allowActions`: policy gate over recovery actions. It constrains the unified
  decision table; it does not make decisions by itself.
- `switchModelOn`: semantic error reasons for which this route/task permits the
  `switch_model` action. This is policy input; the unified decision table still
  chooses whether to switch models for a specific observed failure.
- `failure`: auxiliary-only final disposition when all attempts fail, such as
  `fail_open`, `fail_closed`, `return_null`, `return_original`,
  `return_empty`, or `propagate_error`.
- `timeoutMs`: auxiliary-only per-attempt timeout override. If absent, use
  `apiTimeoutPolicy.ts` source-aware auxiliary budgets.

#### Session Override Contract

Session model override is not a fourth persistent model configuration system.
It must be represented explicitly as a route override:

```ts
type MainModelOverride =
  | { type: 'default-route' }
  | { type: 'route'; routeId: string }
  | { type: 'single-model-route'; modelId: string }
```

Semantics:

- `default-route`: use `model.defaultRoute`.
- `route`: use the named persisted route, including its fallback chain and
  policy gates.
- `single-model-route`: create a request-local route with `primary = modelId`
  and `fallbackChain = []`. It is useful for `--model`, plan/session scoped
  overrides, and explicit one-off model selection.

Session overrides must not mutate `model.defaultRoute`, route primaries, or
fallback chains. Persisted model changes happen only through `/model use`,
`/model route/default/fallback/aux`, onboarding route usage choices, or
explicit config edits.

#### Persistence Contract

All config writers must preserve the final shape:

- `/model use <model-id>` updates the active persisted route primary.
- `/model route <route-id>` changes `model.defaultRoute`.
- `/model fallback ...` edits the active persisted route's fallback chain.
- `/model aux ...` edits auxiliary task policy.
- `/model add` writes `models[modelId]`, then uses the onboarding route usage
  choice to decide whether to set primary, add fallback, or leave routes alone.
- `/model edit <model-id>` edits only `models[modelId]`; if a renamed/deleted
  model becomes necessary later, the command must validate route references
  rather than silently preserving broken routes.
- ModelPicker normal selection is a persisted route-primary change.
- Session-only model selection, command-line `--model`, restored session model,
  and agent-specific model overrides use `MainModelOverride` and do not write
  global config.
- Integration config examples and loaders must use `models` + `model.routes` +
  `auxiliary`.

#### Validation Contract

The final schema validator should fail fast for invalid runtime config:

- `model.defaultRoute` must reference an existing route.
- Every `primary` and `fallbackChain` model id must exist in `models`.
- `fallbackChain` must be an array, not a string.
- A route/task cannot list its primary in its fallback chain.
- Fallback chains cannot contain duplicates.
- `allowActions` may only contain known recovery actions.
- `switchModelOn` may only contain known semantic failure reasons.
- `switchModelOn` is meaningful only as an allow-list for `switch_model`; it
  does not decide fallback.
- Auxiliary `failure` must be one of the known final dispositions.
- Unknown top-level model-routing fields are invalid config.

#### Architecture Boundaries

The model route system must preserve the observe/decide/execute split:

- Observation: each failed attempt records route id, auxiliary task id if any,
  model id, model chain index, protocol, semantic error reason, status, request
  id, first-failure flags, previous reason, and consecutive-same-reason counts.
- Decision: the unified recovery rule registry remains the only place that maps
  semantic errors to recovery intents/actions. Route/task policy data only gates
  whether a proposed `switch_model` action is available for this call. Retry
  loops must not encode fallback semantics such as "retry exhausted means switch";
  that belongs in `decideRecovery()`.
- Execution: the runner applies request mutations, sleeps/backoff, same-model
  retries, model switching, or final failure disposition, then reports the
  outcome back into the recovery trace.
- Orchestration: the outer main-loop or auxiliary runner owns the attempt loop
  and records every attempt. No call site should treat API-error assistant text
  as a successful auxiliary result.

`switchModelOn` is therefore auxiliary decision data, not a second recovery
table. Example:

- `unsupported_parameter` should normally decide
  `adapt_request -> retry_same_model`, even if a fallback chain exists.
- `rate_limit` may decide `switch_model` only when `allowActions` includes
  `switch_model`, `switchModelOn` contains `rate_limit`, and the model chain has
  another candidate.
- If policy gates reject the decision, the decision layer must choose an
  alternate allowed action or emit a final trace explaining why recovery is
  blocked.

#### Required Code Changes

1. Config schema:
   - [x] Add `model.defaultRoute`, `model.routes`, and `auxiliary`.
   - [x] Keep `models` as a resource map only; route/task policy owns runtime
     model selection.
   - [x] Keep persistent route-primary writes under `model.routes`; convert
     session choices to `MainModelOverride` at session boundaries.
   - [x] Add validation that every `primary` and `fallbackChain` entry exists in
     `models`.
   - [x] Add validation for duplicate fallback entries, invalid actions,
     invalid semantic reasons, and invalid auxiliary failure dispositions.
   - [x] Tighten validation so `fallbackChain` must be an array and broken
     route references fail fast.
   - [x] Remove automatic model-route synthesis from startup/config reads.
     Missing or broken route policy is a configuration error.

2. Model helper API:
   - [x] Add route-aware helpers:
     `getDefaultRouteId()`, `getMainRoute()`, `resolveModelRef()`,
     `resolveModelChain()`, `getMainModelCandidate()`, and
     `getAuxiliaryTaskPolicy()`.
   - [x] Keep `models` map access unchanged for provider execution.
   - [x] Replace API-runtime tier helper call sites with explicit auxiliary
     task policies. Route/task policy helpers are the only runtime selection
     surface for auxiliary work.
   - [x] Replace naked runtime model overrides with `MainModelOverride` through
     the full UI/AppState surface. Bootstrap, AppState, ModelPicker,
     PromptInput, `/model show`, TeamCreateTool, and main-loop `query()` now
     resolve default/named/single-model route overrides consistently.

3. Main-loop model fallback:
   - [x] Replace external single-fallback selection with an ordered route
     chain.
   - [x] Emit trace fields for `routeId`, `fromModel`, `toModel`, `chainIndex`,
     and policy gate results.
   - [x] Ensure model switching is requested through the same
     `RecoveryIntent -> RecoveryAction` decision path as other recoveries.
   - [x] Keep route policy as availability/gating data only. The retry loop now
     passes `canFallback`; exhausted-retry model switching is decided inside
     `decideRecovery()`.

4. Auxiliary runner:
   - [x] Add a central route/task runner for side LLM calls.
   - [x] Build attempts from `[primary, ...fallbackChain]`.
   - [x] Use the same classifier, recovery session, rule registry, request mutation
     machinery, timeout policy, and recovery trace channel as the main API
     harness.
   - [x] Apply task-specific final dispositions instead of leaking API-error text as
     normal content.
   - [x] `queryAuxiliaryTask(... auxiliaryTask)` paths now run through
     `runAuxiliaryTask()`. Covered tasks include session title, conversation
     rename, web fetch summary, tool-use summary, MCP datetime parsing, shell
     prefix generation, and similar simple non-streaming helpers.
   - [x] `sideQuery(... auxiliaryTask)` paths now run through
     `runAuxiliaryTask()`. Covered tasks include session-search summary,
     agentic session search, memdir relevance, permission explainer, model
     validation when task-tagged, and other task-tagged side queries.
   - [x] Direct helper paths include goal judge, away summary, token
     counting fallback, prompt hooks, and skill improvement apply.
   - [x] `utils/hooks/apiQueryHookHelper.ts` now supports `auxiliaryTask`
     route policies, forwards recovery metadata and trace sinks, and treats
     explicit `getModel()` as a deliberate direct-model bypass. Skill
     improvement suggestion hooks use the auxiliary task route.
   - [x] Finish the remaining direct `queryModelWithoutStreaming()` audit.
     Remaining direct calls are classified: runner-owned auxiliary attempts
     (`queryAuxiliaryTask`, goal judge, away summary, prompt hooks,
     skill improvement, `apiQueryHookHelper`) or explicit direct-model bypasses
     (`queryWithModel`, agent generation with an explicit model).
   - [x] `execAgentHook` / `hookAgent` full-query semantics are route-aware.
     `query()` accepts an explicit route override for multi-turn auxiliary
     agent loops; unspecified hook agents use `auxiliary.hookAgent`, while
     explicit `hook.model` remains a single-model bypass.
   - [x] Clean up residual manual model/provider selection in task-tagged
     `sideQuery` callers. Complete for runtime side-query paths:
     memdir relevance, agentic session search, per-session summary, and
     permission explainer now enter through route-first
     `sideQuery({ auxiliaryTask, ... })`. Explicit model overrides remain
     a tested direct provider/model bypass.

5. `/model` command and persistence:
   - [x] `/model route <route-id>` changes the active route.
   - [x] `/model use <model-id>` creates or updates a single-primary route.
   - [x] `/model default <route-id>` sets `model.defaultRoute`.
   - [x] `/model add` continues to add entries to `models`, then asks whether to use
     it as a route primary or fallback candidate.
   - [x] `/model fallback list/add/remove` edits the selected route's
     `fallbackChain`.
   - [x] `/model aux list` and `/model aux set <task> <model-id>` inspect/edit
     auxiliary policies.
   - [x] Persist normal model changes only through route policy. Session-only
     overrides remain session-only.
   - [x] Onboarding persists new models through route-aware config update logic
     and verifies the newly entered model id, not a stale auxiliary/default
     model.
   - [x] Provider registry cache is keyed by concrete model config so fallback
     models sharing the same endpoint do not reuse the wrong vendor/template,
     image, thinking, or extra-param settings.
   - [x] `/model add` reports the actual onboarding route usage result:
     primary, fallback, or models-only. It should not imply a fallback-only
     model became active.
   - [x] `/model` route administration covers the final policy surface:
     create/delete/rename routes if needed, edit auxiliary fallback chains, and
     make policy fields auditable without hand-editing JSON.
   - [x] `ModelEditor` validates that edited model entries do
     not leave broken route or auxiliary references.
   - [x] Integration config loader/example uses the explicit final route/task
     policy shape.

6. Tests and release gate:
   - [x] Unit tests for strict route/task config validation.
   - [x] Unit tests for route resolution and auxiliary task policy defaults.
   - [x] Contract tests proving policy gates do not bypass semantic recovery
     rules for main-loop model fallback.
   - [x] Regression tests for "fallback request failed and was treated as
     success" on the main-loop route chain.
   - [x] Main-loop multi-hop fallback trace fixture.
   - [x] Auxiliary runner fallback exhausted fixture for each final disposition.
   - [x] `/model` command persistence tests.
   - [x] Onboarding route persistence tests.
   - [x] Provider-cache isolation test for multiple models on one endpoint.
   - [x] `pnpm run gate:api` local gate passes.
   - [x] Add a dedicated real-API integration gate for main-route and auxiliary
     fallback.
   - [x] Run the relevant real-API integration series before merge/release.

#### M8 Remaining Task Breakdown

API-harness implementation tasks are complete for this milestone, including
release confidence against live providers.

| Priority | Task | Why it remains | Done when |
|---|---|---|---|
| P0 | `/model add` result semantics | Complete. | Onboarding returns a structured route-usage result; `/model add` reports primary/fallback/models-only accurately and updates AppState only when primary changed. |
| P0 | `ModelEditor` route-reference validation | Complete. | Saving validates the final config; broken references are blocked with route/task paths and model ids. |
| P0 | `/model` route administration surface | Complete. | `/model route show/create/delete/rename`, route policy edits, auxiliary fallback edits, and auxiliary policy edits are command-accessible and covered by tests. |
| P0 | Final config examples, onboarding persistence, and user docs | Complete for this milestone. | Runtime/docs/fixtures/onboarding/settings use `models`, `model.routes`, `auxiliary`, and `MainModelOverride`; user `~/.axiomate.json` has been rewritten to the final route/task policy shape with a backup; `docs/user/model_configuration_zhcn.html` explains manual config and UI usage. |
| P0 | Configuration-system gate | Complete. | Typecheck, model route tests, onboarding tests, `/model` tests, ModelEditor tests, config validation tests, and `pnpm run gate:api` pass locally. |
| P1 | `apiQueryHookHelper` route policy integration | Complete. | Helper accepts `auxiliaryTask` for route/task policy execution, forwards fallback metadata and trace sinks, logs null final disposition as an error result, and keeps explicit `getModel` as a direct-model bypass with tests. |
| P1 | `hookAgent` full-query route semantics | Complete. | `query()` supports explicit full-query route overrides; `execAgentHook` routes unspecified hook agents through `auxiliary.hookAgent`, and explicit `hook.model` is tested as a single-model bypass. |
| P1 | Strict config contract | Implemented in runtime reads and focused tests. | Runtime config accepts only `models`, `model.routes`, `auxiliary`, and `MainModelOverride`; missing route policy is not synthesized. |
| P1 | Auxiliary failure-disposition fixture matrix | Complete. | Tests cover `return_null`, `return_empty`, `return_original`, `fail_open`, `fail_closed`, and `propagate_error` after chain exhaustion, including the caller-owned meaning of `return_original`. |
| P1 | Session override semantics | Complete. | Session override resolves to `MainModelOverride` end to end and cannot mutate global route config implicitly. |
| P1 | Residual manual side-query model lookup cleanup | Complete. | Task-tagged runtime call sites use route-first `sideQuery({ auxiliaryTask, ... })`; explicit model overrides are documented/tested bypasses. |
| P2 | Route/task selection cleanup | Complete. | Runtime code uses route/task policy helpers, `queryAuxiliaryTask()`, route-first `sideQuery()`, or explicit direct-model bypasses. |
| P2 | Real-API integration gate | Complete. | `pnpm run gate:api:integration` passes with real credentials. |

#### Completion Criteria

M8 is complete when:

- Runtime API paths require the final route/task model configuration contract.
- All main-loop model switching goes through the observe/decide/execute recovery
  architecture.
- Auxiliary model fallback is centralized and policy-driven.
- Every model-switch attempt emits structured recovery trace.
- API-error results from fallback attempts cannot be consumed as successful
  auxiliary text.
- `/model` edits route/task policy and `models` resources with clear persistence
  semantics.
- `models` remains usable as a resource map, but routing requires
  `model.defaultRoute` and `model.routes`.

## Immediate Next Work

Configuration system is no longer the blocking track for API harness work.
The API harness body, route/task selection cleanup, and real-provider fallback
gate are complete for the current scope.

1. Add product diagnostics consumption for recovery trace events, starting
   with `/doctor` API failure cards.
2. Decide optional provider/runtime policies:
   pooled credential rotation and any newly observed provider-specific request
   sanitizer not yet covered by fixtures.
3. Add narrow API contract fixtures whenever new provider envelopes are
   observed in production.
