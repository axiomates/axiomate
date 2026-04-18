# Remaining Cleanup Audit

Last scan: 2026-04-19

This document captures the current "not fully clean yet" findings from the
Claude Code to Axiomate migration. It focuses on residual private-brand
concepts, half-deleted features, stubs, dead code, and behavior that still
does not clearly match Axiomate's contract:

- Models must be reached only through user-configured `models` entries in
  `~/.axiomate.json`, using public Anthropic or OpenAI-compatible protocols.
- Axiomate should not depend on Claude Code private account systems, private
  cloud providers, private HTTP APIs, remote control, or hosted telemetry.
- Public Anthropic protocol support, the public Anthropic SDK, sandbox
  dependency, MCP, and public plugin marketplace compatibility are not
  automatically considered residue.

This is not a mathematical proof that the repository is clean. It is a
high-signal closure checklist for the remaining migration debt.

## Priority 0 - Behavior or Network Risks

These are the items most likely to surprise users or violate the intended
runtime contract.

### WebFetch domain preflight is a disabled stub

`WebFetchTool` still tries to run a domain blocklist check unless
`skipWebFetchPreflight` is set. The check calls `stub://disabled?...`, so the
default path is neither a real local policy nor a real remote service.

Files:

- `agent/src/tools/WebFetchTool/utils.ts:175` - `checkDomainBlocklist`
- `agent/src/tools/WebFetchTool/utils.ts:183` - `stub://disabled?domain=...`
- `agent/src/tools/WebFetchTool/utils.ts:386` - default preflight gate
- `agent/src/utils/settings/types.ts:555` - `skipWebFetchPreflight`

Why it is not clean:

- This is a classic "old service removed, call path left behind" workaround.
- It can cause WebFetch to fail by default before the actual fetch, even after
  user permission handling.

Recommended resolution:

- Delete the remote preflight concept entirely, or replace it with a local
  deterministic policy using settings allow/deny lists.
- If deleted, `skipWebFetchPreflight` should also be removed or migrated.

### Native installer still contains Anthropic internal Artifactory logic

The actual download path currently uses the Axiomate GCS release bucket, but
Artifactory functions and an internal `infra.ant.dev` registry URL remain.

Files:

- `agent/src/utils/nativeInstaller/download.ts:26` - `ARTIFACTORY_REGISTRY_URL`
- `agent/src/utils/nativeInstaller/download.ts:29` - `getLatestVersionFromArtifactory`
- `agent/src/utils/nativeInstaller/download.ts:126` - `downloadVersionFromArtifactory`
- `agent/src/utils/nativeInstaller/download.ts:229` - `npm ci --registry ARTIFACTORY_REGISTRY_URL`
- `agent/src/utils/nativeInstaller/download.ts:454` - current GCS path

Why it is not clean:

- The internal URL should not ship in an external fork.
- Even if currently unused, exported dead code can be reintroduced by accident.

Recommended resolution:

- Remove the Artifactory functions and constant.
- Keep only the Axiomate release bucket path and generic installer logic.

### Voice STT is an AI provider path outside `models`

Voice transcription uses `voice.stt` with `openai`, `openai-compatible`, or
generic `http` provider settings. This is configurable and not Anthropic
private, but it bypasses the main `models` registry contract.

Files:

- `agent/src/services/voiceTranscription.ts:17` - default OpenAI base URL
- `agent/src/services/voiceTranscription.ts:164` - OpenAI-compatible STT call
- `agent/src/services/voiceTranscription.ts:169` - defaults to `https://api.openai.com/v1`
- `agent/src/utils/config.ts:287` - `OpenAICompatibleSttProviderConfig`
- `agent/src/utils/config.ts:531` - `voice?: VoiceConfig`

Why it is not clean:

- If the policy is "all AI calls use `models`", `/voice` is an exception.
- If the policy allows non-chat STT providers, this should be documented as an
  explicit exception.

Recommended resolution:

- Either document `voice.stt` as an intentional non-chat provider exception, or
  redesign it to reference a named configured model/provider entry.

## Priority 1 - Half-Deleted Product Surfaces

These are visible or near-visible features where source remains but behavior
is stubbed, null, or disconnected.

### MCP remote server settings menu is null

HTTP/SSE MCP servers still render a `MCPRemoteServerMenu`, but the component is
a null stub in both settings and plugin management surfaces.

Files:

- `agent/src/components/mcp/MCPSettings.tsx:16`
- `agent/src/components/mcp/MCPSettings.tsx:171`
- `agent/src/commands/plugin/ManagePlugins.tsx:6`
- `agent/src/commands/plugin/ManagePlugins.tsx:1993`
- `agent/src/commands/plugin/ManagePlugins.tsx:2003`
- `agent/src/components/mcp/index.ts:4`

Why it is not clean:

- Remote MCP itself is useful and public, but the management UI is half-removed.
- The original Claude Code source included generic MCP OAuth plus ClaudeAI
  private auth. Axiomate should either rebuild the generic part or remove the
  UI branch.

Recommended resolution:

- Rebuild a provider-neutral remote MCP menu using public MCP OAuth only, or
  remove the render branches and references.

### UDS local messaging is half-deleted

The Unix-domain-socket messaging client and startup wiring are stubbed, while
address parsing and SendMessage validation still understand `uds:`.

Files:

- `agent/src/main.tsx:1099` - `messagingSocketPath = undefined`
- `agent/src/setup.ts:79` - UDS startup comment remains
- `agent/src/setup.ts:83` - empty server startup block
- `agent/src/utils/udsClient.ts:1` - stub module
- `agent/src/utils/udsClient.ts:9` - `listAllLiveSessions` returns `[]`
- `agent/src/utils/udsClient.ts:13` - `sendToUdsSocket` no-op
- `agent/src/utils/peerAddress.ts:12` - parses `uds:`
- `agent/src/tools/SendMessageTool/SendMessageTool.ts:580` - validates UDS address

Why it is not clean:

- The app still advertises and parses a transport that cannot deliver messages.
- This belongs to the same family as removed remote control/CCR-style local
  session ingress.

Recommended resolution:

- Delete UDS support end-to-end unless Axiomate wants a local-only socket
  messaging feature.
- If rebuilt, keep it purely local and document the security model.

### Workflow / Monitor MCP / ReviewArtifact are null shells

Several task and permission UI branches still include workflow, monitor, and
review-artifact concepts with null tool/component placeholders.

Files:

- `agent/src/tools/WorkflowTool/constants.ts:1`
- `agent/src/constants/tools.ts:28`
- `agent/src/tasks/types.ts:9`
- `agent/src/components/permissions/PermissionRequest.tsx:34`
- `agent/src/components/permissions/PermissionRequest.tsx:35`
- `agent/src/components/permissions/PermissionRequest.tsx:36`
- `agent/src/components/permissions/PermissionRequest.tsx:37`
- `agent/src/components/permissions/PermissionRequest.tsx:38`
- `agent/src/components/permissions/PermissionRequest.tsx:39`
- `agent/src/components/tasks/BackgroundTasksDialog.tsx:117`
- `agent/src/components/tasks/BackgroundTasksDialog.tsx:118`
- `agent/src/components/tasks/BackgroundTasksDialog.tsx:119`
- `agent/src/components/tasks/BackgroundTasksDialog.tsx:120`
- `agent/src/components/tasks/BackgroundTasksDialog.tsx:121`
- `agent/src/components/tasks/BackgroundTasksDialog.tsx:122`
- `agent/src/components/tasks/BackgroundTasksDialog.tsx:478`

Why it is not clean:

- These are removed feature shells, not live product behavior.
- `any` task state types and null detail dialogs make future maintenance
  misleading.

Recommended resolution:

- Remove these task types, constants, permission branches, and UI sections.
- Rebuild from scratch only if Axiomate intentionally adds workflow/monitoring
  tools.

### Brief mode keybinding remains, but behavior is gone

Brief mode has been mostly removed, but the global keybinding action and empty
handler remain.

Files:

- `agent/src/hooks/useGlobalKeybindings.tsx:112`
- `agent/src/hooks/useGlobalKeybindings.tsx:116`
- `agent/src/keybindings/schema.ts:70`

Why it is not clean:

- Users can configure or see an action that does nothing.
- This is residue from the removed Brief / SendUserMessage feature.

Recommended resolution:

- Remove `app:toggleBrief` and its handler unless brief mode is rebuilt.

### Terminal panel implementation is disconnected

The built-in terminal panel implementation exists, but the keybinding handler
is empty.

Files:

- `agent/src/utils/terminalPanel.ts`
- `agent/src/hooks/useGlobalKeybindings.tsx:137`
- `agent/src/hooks/useGlobalKeybindings.tsx:139`
- `agent/src/hooks/useGlobalKeybindings.tsx:141`
- `agent/src/keybindings/schema.ts:72`

Why it is not clean:

- This is either a useful local feature accidentally disabled, or dead code.

Recommended resolution:

- Reconnect `handleToggleTerminal` to `getTerminalPanel().toggle()`, or remove
  the implementation and keybinding schema entry.

## Priority 2 - Stubbed Discovery / Dynamic Config Systems

These are mostly not network risks now, but they preserve old architecture in a
misleading shape.

### Skill search / DiscoverSkills is a half-deleted subsystem

Skill discovery and prefetch modules are stubbed, while prompt comments and MCP
skill indexing hooks still describe the removed behavior.

Files:

- `agent/src/services/skillSearch/featureCheck.ts:1`
- `agent/src/services/skillSearch/featureCheck.ts:3`
- `agent/src/services/skillSearch/prefetch.ts:1`
- `agent/src/services/skillSearch/prefetch.ts:3`
- `agent/src/services/skillSearch/prefetch.ts:10`
- `agent/src/services/skillSearch/prefetch.ts:16`
- `agent/src/services/skillSearch/telemetry.ts:1`
- `agent/src/services/skillSearch/signals.ts:1`
- `agent/src/services/mcp/useManageMCPConnections.ts:22`
- `agent/src/services/mcp/useManageMCPConnections.ts:23`
- `agent/src/services/mcp/useManageMCPConnections.ts:445`
- `agent/src/services/mcp/useManageMCPConnections.ts:450`
- `agent/src/services/mcp/useManageMCPConnections.ts:459`
- `agent/src/constants/prompts.ts:55`
- `agent/src/constants/prompts.ts:254`
- `agent/src/constants/prompts.ts:569`

Why it is not clean:

- Multiple modules exist only to return false, empty arrays, null, or no-op.
- Comments still describe feature-gated internal discovery behavior.

Recommended resolution:

- Delete skill search and DiscoverSkills stubs if turn-0 skill listing is
  enough.
- If the feature is wanted, rebuild it as a provider-neutral local/fast-model
  skill ranker with explicit config.

### Dynamic remote config shell remains

Remote/dynamic config has been removed, but a hook remains that always returns
the default. Some callers still reference old `ax_*` experiment config names.

Files:

- `agent/src/hooks/useDynamicConfig.ts:1`
- `agent/src/hooks/useDynamicConfig.ts:5`
- `agent/src/components/FeedbackSurvey/useFeedbackSurvey.tsx:47`
- `agent/src/components/LogoV2/EmergencyTip.tsx:5`
- `agent/src/components/LogoV2/EmergencyTip.tsx:55`
- `agent/src/keybindings/loadUserBindings.ts:40`
- `agent/src/utils/deepLink/registerProtocol.ts:300`
- `agent/src/utils/hooks/skillImprovement.ts:165`
- `agent/src/services/autoDream/config.ts:10`
- `agent/src/services/autoDream/autoDream.ts:61`
- `agent/src/services/autoDream/autoDream.ts:66`

Why it is not clean:

- The system no longer fetches remote config, but the mental model remains.
- Old experiment names (`ax_feedback_survey_config`, `ax-top-of-feed-tip`,
  `ax_onyx_plover`, etc.) make the fork look dependent on removed internal
  rollout infrastructure.

Recommended resolution:

- Replace `useDynamicConfig` usage with local settings or constants.
- Remove old `ax_*` comments unless they are needed for migration history.
- For disabled features, either delete the code or expose a normal Axiomate
  setting.

## Priority 3 - Analytics and Telemetry Residue

The current analytics sink does not send to Anthropic by default. Events only
flow to OpenTelemetry when explicitly enabled via environment variables. The
remaining issue is stale metadata, no-op API logging, and old event names.

### API logging is partially no-op but still computes metadata

Files:

- `agent/src/services/api/logging.ts:140` - `logAPIQuery`
- `agent/src/services/api/logging.ts:162` - empty body
- `agent/src/services/api/logging.ts:165` - `logAPIError`
- `agent/src/services/api/logging.ts:253` - `logAPISuccess`
- `agent/src/services/api/logging.ts:303` - mostly state update after old metadata
- `agent/src/services/api/logging.ts:449` - emits generic OTel `api_request`

Why it is not clean:

- Some functions preserve old analytics structure but do not log the original
  event payloads.
- Error/success paths still compute gateway, invocation, and content length
  metadata even when only OTel is used.

Recommended resolution:

- Decide on one Axiomate analytics model: no-op, local diagnostics, or OTel.
- Remove metadata branches that are no longer emitted.

### Old analytics metadata names remain

Files:

- `agent/src/services/analytics/metadata.ts:413` - `isClaubbit`
- `agent/src/services/analytics/metadata.ts:575` - `process.env.CLAUBBIT`
- `agent/src/main.tsx:1565` - "multi-clauding telemetry"
- `agent/src/commands/insights.ts:170` - `multi_clauding`
- `agent/src/commands/insights.ts:1038` - `multi_clauding`
- `agent/src/commands/insights.ts:1169` - `detectMultiClauding`
- `agent/src/commands/insights.ts:2367` - HTML output field

Why it is not clean:

- These names are brand/culture residue, not Axiomate concepts.

Recommended resolution:

- Rename `multi_clauding` to something neutral, such as
  `concurrent_sessions`.
- Remove `CLAUBBIT` metadata unless Axiomate has a defined meaning for it.

## Priority 4 - Old Provider / Account / Environment Semantics

The main model path is clean enough: `providerRegistry` requires configured
models. The remaining issue is stale environment vocabulary and comments.

### Old provider env vars are still forwarded or documented

Files:

- `agent/src/utils/swarm/spawnUtils.ts:89` - forwards `AXIOMATE_BASE_URL`
- `agent/src/utils/managedEnvConstants.ts:10` - `AXIOMATE_BASE_URL`
- `agent/src/utils/managedEnvConstants.ts:11` - `AXIOMATE_API_KEY`
- `agent/src/utils/managedEnvConstants.ts:40` - redirect comment
- `agent/src/utils/managedEnvConstants.ts:49` - auth comment
- `agent/src/utils/status.tsx:191` - displays `AXIOMATE_BASE_URL`
- `agent/src/services/api/logging.ts:88` - gateway detection comment
- `agent/src/services/api/logging.ts:205` - error gateway detection uses env base URL
- `agent/src/services/api/logging.ts:380` - success gateway detection uses env base URL
- `agent/src/main.tsx:597` - `--bare` help references `AXIOMATE_API_KEY`
- `agent/src/utils/envUtils.ts:52` - `--bare` comment references `AXIOMATE_API_KEY`

Why it is not clean:

- Axiomate no longer uses global provider env vars as the primary provider
  model.
- These references can make future code accidentally reintroduce non-models
  provider selection.

Recommended resolution:

- Remove or narrow these env vars to documented compatibility only.
- Prefer named `models` entries and scoped config over process-wide provider
  routing variables.

### Legacy config migration still names removed private concepts

Files:

- `agent/src/utils/config.ts:829` - `groveConfigCache`
- `agent/src/utils/config.ts:837` - `bridgeOauthDeadExpiresAt`
- `agent/src/utils/config.ts:838` - `bridgeOauthDeadFailCount`
- `agent/src/utils/config.ts:843` - `remoteControlAtStartup`
- `agent/src/utils/config.ts:857` - migration removal list
- `agent/src/utils/config.ts:983` - `remoteControlSpawnMode`

Why it is not clean:

- These are migration-only cleanup fields, not runtime features.
- They are still old private account / remote control vocabulary in the source.

Recommended resolution:

- Keep only if needed for one-time migration from old user configs.
- If this fork can drop old config compatibility, remove the migration names.

## Priority 5 - Branding / Naming Residue

These do not necessarily affect behavior, but they keep Claude Code concepts in
the codebase and user-facing surfaces.

### User-facing or semi-user-facing Claude/plugin references

Files:

- `agent/src/commands/init.ts:220`
- `agent/src/commands/init.ts:223`
- `agent/src/commands/plugin/ManagePlugins.tsx:898`
- `agent/src/commands/plugin/ManagePlugins.tsx:900`
- `agent/src/commands/plugin/ManagePlugins.tsx:901`
- `agent/src/commands/plugin/ManageMarketplaces.tsx:126`
- `agent/src/commands/plugin/ManageMarketplaces.tsx:128`
- `agent/src/commands/plugin/ManageMarketplaces.tsx:129`
- `agent/src/commands/plugin/BrowseMarketplace.tsx:153`
- `agent/src/skills/bundled/updateConfig.ts:94`
- `agent/src/utils/plugins/installCounts.ts:26`
- `agent/src/utils/plugins/officialMarketplace.ts:17`
- `agent/src/utils/plugins/officialMarketplace.ts:30`

Why it may or may not be clean:

- Public Claude plugin marketplace compatibility was explicitly allowed.
- The remaining question is whether Axiomate wants this visible in UX and
  default ordering.

Recommended resolution:

- If keeping compatibility, document it as an allowed exception.
- If strict brand removal is required, rename UX labels and keep only source
  compatibility internally.

### Onboarding still uses Claude examples for Anthropic protocol

Files:

- `agent/src/components/OnboardingProviderStep.reducer.ts:37`
- `agent/src/components/OnboardingProviderStep.reducer.ts:39`
- `agent/src/components/OnboardingProviderStep.reducer.ts:45`

Why it may or may not be clean:

- `anthropic` protocol is public and allowed.
- The example model names are Claude-branded. This is acceptable for protocol
  clarity, but not for strict brand removal.

Recommended resolution:

- Keep if Axiomate intentionally supports Anthropic public protocol in
  onboarding.
- Otherwise use generic wording such as "provider-native model id".

### Grove, first-party, subscriber, and private-culture comments

Files:

- `agent/src/cli/print.ts:436` - `after_grove_check`
- `agent/src/utils/theme.ts:48` - "Grove colors"
- `agent/src/utils/theme.ts:151`
- `agent/src/utils/theme.ts:228`
- `agent/src/utils/theme.ts:305`
- `agent/src/utils/theme.ts:382`
- `agent/src/utils/theme.ts:459`
- `agent/src/utils/theme.ts:536`
- `agent/src/constants/apiLimits.ts:59` - first-party API comment
- `agent/src/main.tsx:1679` - subscriber status comment

Recommended resolution:

- Rename to neutral Axiomate terms or remove comments if they no longer
  explain behavior.

## Compatibility Items That Need a Decision

These are not clearly wrong, but they should be explicitly allowed or replaced.

### MCP `_meta['anthropic/*']` extensions

Files:

- `agent/src/services/mcp/client.ts:1513` - `anthropic/searchHint`
- `agent/src/services/mcp/client.ts:1518` - `anthropic/alwaysLoad`
- `agent/src/Tool.ts:438` - comment
- `agent/src/tools/ToolSearchTool/prompt.ts:39`
- `agent/src/tools/ToolSearchTool/prompt.ts:42`

Why it is ambiguous:

- These are MCP tool metadata keys, not Anthropic private HTTP APIs.
- They are useful for compatibility with Claude plugin ecosystem tools.
- The namespace is still Anthropic-branded.

Recommended resolution:

- Either allowlist them as public compatibility extensions, or support
  Axiomate aliases such as `axiomate/searchHint` and `axiomate/alwaysLoad`
  while keeping Anthropic names as backward-compatible input only.

### Public Anthropic protocol and SDK support

Files include:

- `agent/src/services/api/providers/anthropicProvider.ts`
- `agent/src/services/api/adapters/anthropicRequestAdapter.ts`
- `agent/src/services/api/adapters/anthropicStreamAdapter.ts`
- `agent/package.json` dependency `@anthropic-ai/sdk`

Decision:

- This is allowed if Axiomate supports public Anthropic protocol.
- It should not be treated as private Claude Code residue.

### Sandbox dependency on Anthropic

Decision:

- User has already accepted that sandbox currently depends on Anthropic code.
- Keep it out of cleanup unless the sandbox is separately replaced.

## Nonessential Network Surfaces to Document or Gate

These are not Anthropic private APIs, but should be documented so "no surprise
traffic" stays true.

- Auto-update and native installer release checks use
  `https://storage.googleapis.com/axiomate-releases`.
- Release notes fetch from Axiomate GitHub:
  `agent/src/utils/releaseNotes.ts:29` and `:31`.
- Official plugin install counts fetch from Anthropic's public plugin stats repo:
  `agent/src/utils/plugins/installCounts.ts:26`.
- Internet availability probe sends `HEAD http://1.1.1.1`:
  `agent/src/utils/env.ts:30`.
- Web search providers use user-configured provider keys and known public
  endpoints.
- MCP OAuth and HTTP/SSE/WebSocket traffic goes to user-configured MCP servers.
- Hook HTTP calls go to user-configured hook URLs.

Recommended resolution:

- Ensure all nonessential network calls respect
  `AXIOMATE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- Keep a source-controlled network endpoint inventory.

## Suggested Cleanup Order

1. Remove or rebuild `WebFetchTool` domain preflight.
2. Remove Artifactory installer code and internal URL.
3. Decide whether `/voice` is an allowed non-chat provider exception.
4. Delete or rebuild MCP remote server menu.
5. Delete UDS messaging or rebuild as a local-only feature.
6. Remove Workflow / Monitor MCP / ReviewArtifact stubs.
7. Remove Brief and Terminal empty keybindings, or restore Terminal.
8. Delete SkillSearch / DiscoverSkills stubs or rebuild provider-neutral search.
9. Replace dynamic config shells with local settings/constants.
10. Clean old provider env vocabulary.
11. Rename analytics and branding residue.
12. Add CI guardrails.

## Recommended CI Guardrails

Add a small audit script with an explicit allowlist. Suggested checks:

- Deny internal URLs: `infra.ant.dev`, private Artifactory, private docs.
- Deny old private concepts: `bridgeOauth`, `remoteControl`,
  `sessionIngress`, `settingsSync`, `subscriber`, `overage`, `passes`.
- Deny removed providers outside allowlist: `bedrock`, `vertex`, `foundry`,
  `firstParty`, `first-party`.
- Deny obvious stubs outside allowlist: `stub://disabled`,
  `const X = null`, empty keybinding handlers, exported functions that always
  return `false`, `[]`, or `null`.
- Deny model network clients outside provider registry and explicitly
  documented exceptions.
- Maintain an allowlist for public Anthropic protocol, public plugin
  marketplace compatibility, MCP `_meta` compatibility keys, and sandbox.

