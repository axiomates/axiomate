# 剩余清理审计

最后扫描日期：2026-04-19

本文档记录 Claude Code 到 Axiomate 迁移过程中，当前仍然“没有完全干净”的发现。重点包括：残留的私有品牌概念、半删除功能、stub、死代码，以及仍然没有清晰符合 Axiomate 运行契约的行为。

- 模型只能通过用户在 `~/.axiomate.json` 中配置的 `models` 条目访问，并且只能使用公开 Anthropic 协议或 OpenAI-compatible 协议。
- Axiomate 不应依赖 Claude Code 私有账号系统、私有云 provider、私有 HTTP API、远程控制或托管埋点服务。
- 对公开 Anthropic 协议、公开 Anthropic SDK、sandbox 依赖、MCP、公开插件市场兼容的支持，不自动视为残留。

这不是对仓库已经干净的数学证明。它是一份针对剩余迁移债务的高信号收口清单。

## Priority 0 - 行为或网络风险

这些项目最可能让用户意外，或者违反预期的运行时契约。

### Native installer 仍包含 Anthropic 内部 Artifactory 逻辑

当前实际下载路径使用 Axiomate GCS release bucket，但 Artifactory 函数和内部 `infra.ant.dev` registry URL 仍然存在。

文件：

- `agent/src/utils/nativeInstaller/download.ts:26` - `ARTIFACTORY_REGISTRY_URL`
- `agent/src/utils/nativeInstaller/download.ts:29` - `getLatestVersionFromArtifactory`
- `agent/src/utils/nativeInstaller/download.ts:126` - `downloadVersionFromArtifactory`
- `agent/src/utils/nativeInstaller/download.ts:229` - `npm ci --registry ARTIFACTORY_REGISTRY_URL`
- `agent/src/utils/nativeInstaller/download.ts:454` - 当前 GCS 路径

为什么不干净：

- 外部 fork 不应该发布内部 URL。
- 即使当前未使用，导出的死代码也可能被意外重新接回运行路径。

建议处理：

- 删除 Artifactory 函数和常量。
- 只保留 Axiomate release bucket 路径和通用 installer 逻辑。

### Voice STT 是 `models` 之外的 AI provider 路径

语音转写使用 `voice.stt`，支持 `openai`、`openai-compatible` 或通用 `http` provider 配置。这是可配置的，也不是 Anthropic 私有协议，但它绕过了主 `models` registry 契约。

文件：

- `agent/src/services/voiceTranscription.ts:17` - 默认 OpenAI base URL
- `agent/src/services/voiceTranscription.ts:164` - OpenAI-compatible STT 调用
- `agent/src/services/voiceTranscription.ts:169` - 默认 `https://api.openai.com/v1`
- `agent/src/utils/config.ts:287` - `OpenAICompatibleSttProviderConfig`
- `agent/src/utils/config.ts:531` - `voice?: VoiceConfig`

为什么不干净：

- 如果政策是“所有 AI 调用都走 `models`”，`/voice` 就是一个例外。
- 如果允许非聊天 STT provider，则应把它文档化为明确例外。

建议处理：

- 要么把 `voice.stt` 记录为有意保留的非聊天 provider 例外。
- 要么重新设计，让它引用某个已配置的模型或 provider 条目。

## Priority 1 - 半删除的产品界面

这些是可见或接近可见的功能：源码仍在，但行为是 stub、null 或断开的。

### MCP remote server settings menu 是 null

HTTP/SSE MCP server 仍会渲染 `MCPRemoteServerMenu`，但在 settings 和 plugin management 两个界面中，该组件都是 null stub。

文件：

- `agent/src/components/mcp/MCPSettings.tsx:16`
- `agent/src/components/mcp/MCPSettings.tsx:171`
- `agent/src/commands/plugin/ManagePlugins.tsx:6`
- `agent/src/commands/plugin/ManagePlugins.tsx:1993`
- `agent/src/commands/plugin/ManagePlugins.tsx:2003`
- `agent/src/components/mcp/index.ts:4`

为什么不干净：

- Remote MCP 本身有用且公开，但管理 UI 被半删除。
- 原 Claude Code 源码包含通用 MCP OAuth 和 ClaudeAI 私有认证。Axiomate 应重建通用部分，或删除 UI 分支。

建议处理：

- 使用公开 MCP OAuth 重建 provider-neutral 的 remote MCP 菜单。
- 或删除对应 render 分支和引用。

### UDS local messaging 被半删除

Unix-domain-socket messaging client 和启动 wiring 已经 stub，但地址解析和 SendMessage 校验仍理解 `uds:`。

文件：

- `agent/src/main.tsx:1099` - `messagingSocketPath = undefined`
- `agent/src/setup.ts:79` - UDS startup 注释仍在
- `agent/src/setup.ts:83` - 空 server startup block
- `agent/src/utils/udsClient.ts:1` - stub module
- `agent/src/utils/udsClient.ts:9` - `listAllLiveSessions` 返回 `[]`
- `agent/src/utils/udsClient.ts:13` - `sendToUdsSocket` no-op
- `agent/src/utils/peerAddress.ts:12` - 解析 `uds:`
- `agent/src/tools/SendMessageTool/SendMessageTool.ts:580` - 校验 UDS 地址

为什么不干净：

- 应用仍解析并部分认可一个无法投递消息的 transport。
- 这和已删除的远程控制/CCR 类 local session ingress 属于同一类残留。

建议处理：

- 除非 Axiomate 明确要做 local-only socket messaging，否则端到端删除 UDS 支持。
- 如果重建，必须保持纯本地，并文档化安全模型。

### Workflow / Monitor MCP / ReviewArtifact 是 null 壳

多个 task 和 permission UI 分支仍包含 workflow、monitor、review-artifact 概念，但工具/组件都是 null 占位。

文件：

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

为什么不干净：

- 这些是已删除功能的壳，不是活跃产品行为。
- `any` task state 类型和 null detail dialog 会误导后续维护。

建议处理：

- 删除这些 task type、constant、permission 分支和 UI section。
- 只有当 Axiomate 明确添加 workflow/monitoring tools 时，才从头重建。

### Brief mode keybinding 还在，但行为已经没了

Brief mode 基本已经删除，但全局 keybinding action 和空 handler 仍然存在。

文件：

- `agent/src/hooks/useGlobalKeybindings.tsx:112`
- `agent/src/hooks/useGlobalKeybindings.tsx:116`
- `agent/src/keybindings/schema.ts:70`

为什么不干净：

- 用户可以配置或看到一个没有任何效果的 action。
- 这是已删除 Brief / SendUserMessage 功能的残留。

建议处理：

- 除非重建 brief mode，否则删除 `app:toggleBrief` 及其 handler。

### Terminal panel 实现存在但未接通

内置 terminal panel 实现还在，但 keybinding handler 是空的。

文件：

- `agent/src/utils/terminalPanel.ts`
- `agent/src/hooks/useGlobalKeybindings.tsx:137`
- `agent/src/hooks/useGlobalKeybindings.tsx:139`
- `agent/src/hooks/useGlobalKeybindings.tsx:141`
- `agent/src/keybindings/schema.ts:72`

为什么不干净：

- 这要么是一个被意外禁用的有用本地功能，要么就是死代码。

建议处理：

- 将 `handleToggleTerminal` 重新接到 `getTerminalPanel().toggle()`。
- 或删除实现和 keybinding schema entry。

## Priority 2 - Stubbed Discovery / Dynamic Config Systems

这些现在大多不是网络风险，但它们以误导性的形态保留了旧架构。

### Skill search / DiscoverSkills 是半删除子系统

Skill discovery 和 prefetch 模块已经 stub，但 prompt 注释和 MCP skill indexing hook 仍描述已删除行为。

文件：

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

为什么不干净：

- 多个模块存在的唯一作用是返回 false、空数组、null 或 no-op。
- 注释仍描述 feature-gated 的内部 discovery 行为。

建议处理：

- 如果 turn-0 skill listing 已足够，删除 skill search 和 DiscoverSkills stubs。
- 如果需要该功能，则用明确配置重建 provider-neutral 的本地/fast-model skill ranker。

### Dynamic remote config 壳还在

Remote/dynamic config 已经删除，但仍有一个 hook 永远返回默认值。一些调用点还引用旧 `ax_*` experiment config 名称。

文件：

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

为什么不干净：

- 系统不再获取 remote config，但旧心智模型仍留在代码里。
- 旧 experiment 名称，例如 `ax_feedback_survey_config`、`ax-top-of-feed-tip`、`ax_onyx_plover`，会让 fork 看起来仍依赖已删除的内部 rollout 基础设施。

建议处理：

- 用本地 settings 或常量替换 `useDynamicConfig` 使用点。
- 删除旧 `ax_*` 注释，除非它们确实是迁移历史所需。
- 对禁用功能，要么删除代码，要么暴露为正常 Axiomate setting。

## Priority 3 - Analytics 和 Telemetry 残留

当前 analytics sink 默认不会发送到 Anthropic。只有用户通过环境变量显式启用时，事件才会流向 OpenTelemetry。剩余问题是陈旧 metadata、no-op API logging 和旧事件命名。

### API logging 部分 no-op，但仍计算 metadata

文件：

- `agent/src/services/api/logging.ts:140` - `logAPIQuery`
- `agent/src/services/api/logging.ts:162` - 空函数体
- `agent/src/services/api/logging.ts:165` - `logAPIError`
- `agent/src/services/api/logging.ts:253` - `logAPISuccess`
- `agent/src/services/api/logging.ts:303` - 在旧 metadata 后基本只做状态更新
- `agent/src/services/api/logging.ts:449` - 发送通用 OTel `api_request`

为什么不干净：

- 一些函数保留了旧 analytics 结构，但不再记录原始事件 payload。
- Error/success 路径仍在计算 gateway、invocation、content length 等 metadata，即使现在只使用 OTel。

建议处理：

- 决定唯一的 Axiomate analytics 模型：no-op、本地 diagnostics，或 OTel。
- 删除不再 emit 的 metadata 分支。

### 旧 analytics metadata 名称仍在

文件：

- `agent/src/services/analytics/metadata.ts:413` - `isClaubbit`
- `agent/src/services/analytics/metadata.ts:575` - `process.env.CLAUBBIT`
- `agent/src/main.tsx:1565` - "multi-clauding telemetry"
- `agent/src/commands/insights.ts:170` - `multi_clauding`
- `agent/src/commands/insights.ts:1038` - `multi_clauding`
- `agent/src/commands/insights.ts:1169` - `detectMultiClauding`
- `agent/src/commands/insights.ts:2367` - HTML output field

为什么不干净：

- 这些名称是品牌/文化残留，不是 Axiomate 概念。

建议处理：

- 将 `multi_clauding` 改成中性名称，例如 `concurrent_sessions`。
- 删除 `CLAUBBIT` metadata，除非 Axiomate 对它有明确含义。

## Priority 4 - 旧 Provider / Account / Environment 语义

主模型路径已经足够干净：`providerRegistry` 要求配置好的 models。剩余问题是陈旧的环境变量词汇和注释。

### 旧 provider env vars 仍被转发或文档化

文件：

- `agent/src/utils/swarm/spawnUtils.ts:89` - 转发 `AXIOMATE_BASE_URL`
- `agent/src/utils/managedEnvConstants.ts:10` - `AXIOMATE_BASE_URL`
- `agent/src/utils/managedEnvConstants.ts:11` - `AXIOMATE_API_KEY`
- `agent/src/utils/managedEnvConstants.ts:40` - redirect 注释
- `agent/src/utils/managedEnvConstants.ts:49` - auth 注释
- `agent/src/utils/status.tsx:191` - 显示 `AXIOMATE_BASE_URL`
- `agent/src/services/api/logging.ts:88` - gateway detection 注释
- `agent/src/services/api/logging.ts:205` - error gateway detection 使用 env base URL
- `agent/src/services/api/logging.ts:380` - success gateway detection 使用 env base URL
- `agent/src/main.tsx:597` - `--bare` help 提到 `AXIOMATE_API_KEY`
- `agent/src/utils/envUtils.ts:52` - `--bare` 注释提到 `AXIOMATE_API_KEY`

为什么不干净：

- Axiomate 不再把全局 provider env vars 当作主要 provider 模型。
- 这些引用可能让未来代码意外重新引入非 models 的 provider selection。

建议处理：

- 删除这些 env vars，或将其收窄成有文档记录的兼容路径。
- 优先使用命名 `models` 条目和 scoped config，而不是 process-wide provider routing 变量。

### Legacy config migration 仍提到已删除的私有概念

文件：

- `agent/src/utils/config.ts:829` - `groveConfigCache`
- `agent/src/utils/config.ts:837` - `bridgeOauthDeadExpiresAt`
- `agent/src/utils/config.ts:838` - `bridgeOauthDeadFailCount`
- `agent/src/utils/config.ts:843` - `remoteControlAtStartup`
- `agent/src/utils/config.ts:857` - migration removal list
- `agent/src/utils/config.ts:983` - `remoteControlSpawnMode`

为什么不干净：

- 这些是 migration-only cleanup fields，不是运行时功能。
- 它们仍在源码中保留旧私有账号/远程控制词汇。

建议处理：

- 只有在确实需要从旧用户配置做一次性迁移时才保留。
- 如果这个 fork 可以放弃旧配置兼容，则删除这些 migration 名称。

## Priority 5 - Branding / Naming 残留

这些不一定影响行为，但会让 Claude Code 概念继续留在代码库和用户界面中。

### 用户可见或半用户可见的 Claude 插件/marketplace 引用

文件：

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

为什么可能干净，也可能不干净：

- 已经明确允许兼容公开 Claude 插件 marketplace。
- 剩余问题是 Axiomate 是否希望它出现在 UX 和默认排序中。

建议处理：

- 如果保留兼容性，把它记录为允许例外。
- 如果要求严格品牌移除，则重命名 UX label，并仅在内部保留 source compatibility。

### Onboarding 仍用 Claude 示例说明 Anthropic protocol

文件：

- `agent/src/components/OnboardingProviderStep.reducer.ts:37`
- `agent/src/components/OnboardingProviderStep.reducer.ts:39`
- `agent/src/components/OnboardingProviderStep.reducer.ts:45`

为什么可能干净，也可能不干净：

- `anthropic` protocol 是公开协议，允许保留。
- 示例模型名是 Claude 品牌。如果目标是严格品牌移除，则不干净。

建议处理：

- 如果 Axiomate 在 onboarding 中明确支持 Anthropic 公开协议，可以保留。
- 否则使用更通用的措辞，例如 "provider-native model id"。

### Grove、first-party、subscriber 和私有文化注释

文件：

- `agent/src/cli/print.ts:436` - `after_grove_check`
- `agent/src/utils/theme.ts:48` - "Grove colors"
- `agent/src/utils/theme.ts:151`
- `agent/src/utils/theme.ts:228`
- `agent/src/utils/theme.ts:305`
- `agent/src/utils/theme.ts:382`
- `agent/src/utils/theme.ts:459`
- `agent/src/utils/theme.ts:536`
- `agent/src/constants/apiLimits.ts:59` - first-party API 注释
- `agent/src/main.tsx:1679` - subscriber status 注释

建议处理：

- 改成中性的 Axiomate 术语；如果注释已经不解释行为，则删除。

## 需要决策的兼容项

这些项目不一定错误，但应该明确 allowlist，或替换成 Axiomate 自己的命名。


## 需要文档化或 gate 的非必要网络面

这些不是 Anthropic 私有 API，但应记录下来，保证“不产生意外流量”这个目标成立。

- Auto-update 和 native installer release check 使用 `https://storage.googleapis.com/axiomate-releases`。
- Release notes 从 Axiomate GitHub 获取：`agent/src/utils/releaseNotes.ts:29` 和 `:31`。
- 官方 plugin install counts 从 Anthropic 的公开 plugin stats repo 获取：`agent/src/utils/plugins/installCounts.ts:26`。
- Internet availability probe 发送 `HEAD http://1.1.1.1`：`agent/src/utils/env.ts:30`。
- Web search providers 使用用户配置的 provider keys 和已知公开 endpoints。
- MCP OAuth 和 HTTP/SSE/WebSocket traffic 指向用户配置的 MCP servers。
- Hook HTTP calls 指向用户配置的 hook URLs。

建议处理：

- 确保所有非必要网络调用都尊重 `AXIOMATE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`。
- 维护一份纳入版本控制的 network endpoint inventory。

## 建议清理顺序

1. ~~删除或重建 `WebFetchTool` domain preflight。~~ ✅ 已完成 (2026-04-19)
2. 删除 Artifactory installer 代码和内部 URL。
3. 决定 `/voice` 是否是允许的非聊天 provider 例外。
4. 删除或重建 MCP remote server menu。
5. 删除 UDS messaging，或重建为 local-only feature。
6. 删除 Workflow / Monitor MCP / ReviewArtifact stubs。
7. 删除 Brief 和 Terminal 空 keybindings，或恢复 Terminal。
8. 删除 SkillSearch / DiscoverSkills stubs，或重建 provider-neutral search。
9. 用 local settings/constants 替换 dynamic config shells。
10. 清理旧 provider env 词汇。
11. 重命名 analytics 和 branding 残留。