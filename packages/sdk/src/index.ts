// Public API barrel — Axiomate SDK

// Main entry point
export { query } from './query.js'

// Tool & MCP server builders
export { tool } from './tool.js'
export { createSdkMcpServer } from './mcpServer.js'

// Session management (v2 preview)
export {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
  getSessionMessages,
  listSessions,
  getSessionInfo,
  renameSession,
  tagSession,
  forkSession,
} from './session.js'

// Daemon primitives
export {
  watchScheduledTasks,
  buildMissedTaskNotification,
  connectRemoteControl,
} from './daemon.js'

// Cron task management (filesystem-backed)
export {
  readCronTasks,
  writeCronTasks,
  removeCronTasks,
  markCronTasksFired,
  findMissedTasks,
  getCronFilePath,
} from './cronTasks.js'

export {
  parseCronExpression,
  computeNextCronRun,
  nextCronRunMs,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
  DEFAULT_CRON_JITTER_CONFIG,
} from './cron.js'

// Errors
export { AbortError } from './errors.js'

// Types
export type {
  // Core
  Options,
  Query,
  PermissionMode,
  ThinkingConfig,

  // Messages
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKStatusMessage,
  SDKPartialAssistantMessage,
  SDKToolProgressMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKAuthStatusMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKSessionStateChangedMessage,
  SDKFilesPersistedEvent,
  SDKToolUseSummaryMessage,
  SDKElicitationCompleteMessage,
  SDKPromptSuggestionMessage,
  SDKAPIRetryMessage,
  SDKLocalCommandOutputMessage,
  SDKCompactBoundaryMessage,
  SDKRateLimitEvent,
  ContentBlock,
  ModelUsage,
  SDKPermissionDenial,

  // Permission & Elicitation
  PermissionRequest,
  PermissionResponse,
  PermissionUpdate,
  ElicitationRequest,
  ElicitationResponse,

  // Tools & MCP
  SdkMcpToolDefinition,
  McpServerConfig,
  McpStdioServerConfig,
  McpSseServerConfig,
  McpHttpServerConfig,
  McpSdkServerConfig,
  McpSdkServerInstance,
  McpServerStatus,
  AnyZodRawShape,
  InferShape,

  // Agents
  AgentDefinition,

  // Sessions
  SDKSession,
  SDKSessionOptions,
  SDKSessionInfo,
  SessionMessage,
  ListSessionsOptions,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  SessionMutationOptions,
  ForkSessionOptions,
  ForkSessionResult,

  // Query control
  RewindFilesResult,
  ContextUsage,
  SettingsResult,
  McpSetServersResult,
  ReloadPluginsResult,
  EffortLevel,

  // Daemon
  CronTask,
  CronJitterConfig,
  ScheduledTaskEvent,
  ScheduledTasksHandle,
  ConnectRemoteControlOptions,
  InboundPrompt,
  RemoteControlHandle,
} from './types/index.js'
