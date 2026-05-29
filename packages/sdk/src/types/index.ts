import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'

// ============================================================================
// Options & Configuration
// ============================================================================

export type ThinkingConfig =
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'adaptive'; budgetTokens?: number }
  | { type: 'disabled' }

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

export type Options = {
  cliPath?: string
  cwd?: string
  model?: string
  effort?: EffortLevel
  agent?: string
  systemPrompt?: string
  systemPromptFile?: string
  appendSystemPrompt?: string
  appendSystemPromptFile?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  tools?: string[] | 'default' | ''
  permissionMode?: PermissionMode
  permissionPromptTool?: string
  dangerouslySkipPermissions?: boolean
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: number
  thinkingConfig?: ThinkingConfig
  maxThinkingTokens?: number
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  sessionId?: string
  name?: string
  resume?: string | boolean
  continue?: boolean
  forkSession?: boolean
  persistSession?: boolean
  resumeSessionAt?: string
  rewindFiles?: string
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  includeHookEvents?: boolean
  mcpConfig?: string[]
  strictMcpConfig?: boolean
  mcpServers?: Record<string, McpServerConfig>
  agents?: Record<string, AgentDefinition>
  agentsJson?: string
  settings?: string
  settingSources?: string[]
  addDirs?: string[]
  pluginDirs?: string[]
  disableSlashCommands?: boolean
  betas?: string[]
  workload?: string
  ide?: boolean
  bare?: boolean
  abortSignal?: AbortSignal
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResponse>
  onElicitation?: (request: ElicitationRequest) => Promise<ElicitationResponse>
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSseServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig

export type McpStdioServerConfig = {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export type McpSseServerConfig = {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export type McpHttpServerConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type McpSdkServerConfig = {
  type: 'sdk'
  serverInstance: McpSdkServerInstance
}

export type McpSdkServerInstance = {
  name: string
  version?: string
  tools: SdkMcpToolDefinition<any>[]
  alwaysLoad?: boolean
}

export type AgentDefinition = {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  permissionMode?: PermissionMode
  maxTurns?: number
  background?: boolean
}

// ============================================================================
// Permission & Elicitation
// ============================================================================

export type PermissionRequest = {
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  agentId?: string
  title?: string
  description?: string
  permissionSuggestions?: PermissionUpdate[]
}

export type PermissionResponse = {
  decision: 'allow' | 'deny'
  updatedPermissions?: PermissionUpdate[]
}

export type PermissionUpdate = {
  type: 'add' | 'remove' | 'replace'
  behavior: 'allow' | 'deny' | 'ask'
  toolName: string
  ruleContent?: string
  destination?: string
}

export type ElicitationRequest = {
  mcpServerName: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitationId?: string
  requestedSchema?: Record<string, unknown>
}

export type ElicitationResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

// ============================================================================
// Tool Definition
// ============================================================================

export type AnyZodRawShape = Record<string, z.ZodTypeAny>

export type InferShape<T extends AnyZodRawShape> = {
  [K in keyof T]: z.infer<T[K]>
}

export type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
  searchHint?: string
  alwaysLoad?: boolean
}

// ============================================================================
// Query Interface
// ============================================================================

export interface Query extends AsyncGenerator<SDKMessage, void, undefined> {
  interrupt(): void
  setPermissionMode(mode: PermissionMode): void
  setModel(model: string): void
  setMaxThinkingTokens(tokens: number | null): void
  close(): Promise<void>
  mcpServerStatus(): Promise<McpServerStatus[]>
  rewindFiles(userMessageId: string, dryRun?: boolean): Promise<RewindFilesResult>
  stopTask(taskId: string): void
  applyFlagSettings(settings: Record<string, unknown>): void
  getContextUsage(): Promise<ContextUsage>
  getSettings(): Promise<SettingsResult>
  cancelAsyncMessage(messageUuid: string): Promise<{ cancelled: boolean }>
  seedReadState(path: string, mtime: number): Promise<void>
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>
  reloadPlugins(): Promise<ReloadPluginsResult>
  reconnectMcpServer(serverName: string): Promise<void>
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>
}

// ============================================================================
// Session Types
// ============================================================================

export type SDKSessionOptions = Options & {
  sessionId?: string
}

export interface SDKSession {
  readonly sessionId: string
  send(message: string | SDKUserMessage): Query
  close(): Promise<void>
}

export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}

export type GetSessionInfoOptions = {
  dir?: string
}

export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type SessionMutationOptions = {
  dir?: string
}

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

export type ForkSessionResult = {
  sessionId: string
}

// ============================================================================
// SDK Message Types (wire protocol)
// ============================================================================

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKStatusMessage
  | SDKPartialAssistantMessage
  | SDKToolProgressMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKSessionStateChangedMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKElicitationCompleteMessage
  | SDKPromptSuggestionMessage
  | SDKAPIRetryMessage
  | SDKLocalCommandOutputMessage
  | SDKCompactBoundaryMessage
  | SDKRateLimitEvent

// --- Individual message types ---

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: 'image'; source: { type: string; media_type: string; data: string } }
  | { type: 'thinking'; thinking: string; signature?: string }

export type SDKAssistantMessage = {
  type: 'assistant'
  message: {
    id: string
    role: 'assistant'
    content: ContentBlock[]
    model: string
    stop_reason: string | null
    usage: ModelUsage
  }
  uuid: string
  parentUuid?: string
  session_id: string
}

export type SDKUserMessage = {
  type: 'user'
  content: string | ContentBlock[]
  uuid?: string
  parentUuid?: string
}

export type SDKResultMessage = SDKResultSuccess | SDKResultError

export type SDKResultSuccess = {
  type: 'result'
  subtype: 'success'
  duration_ms: number
  duration_api_ms: number
  is_error: false
  num_turns: number
  result: string
  stop_reason: string | null
  total_cost_usd: number
  usage: ModelUsage
  modelUsage: Record<string, ModelUsage>
  permission_denials: SDKPermissionDenial[]
  structured_output?: unknown
  uuid: string
  session_id: string
}

export type SDKResultError = {
  type: 'result'
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'
  duration_ms: number
  duration_api_ms: number
  is_error: true
  num_turns: number
  stop_reason: string | null
  total_cost_usd: number
  usage: ModelUsage
  modelUsage: Record<string, ModelUsage>
  permission_denials: SDKPermissionDenial[]
  errors: string[]
  uuid: string
  session_id: string
}

export type SDKSystemMessage = {
  type: 'system'
  subtype: 'init'
  tools: string[]
  mcp_servers: McpServerStatus[]
  model: string
  session_id: string
}

export type SDKStatusMessage = {
  type: 'status'
  status: string
}

export type SDKPartialAssistantMessage = {
  type: 'assistant'
  subtype: 'partial'
  message: {
    content: ContentBlock[]
  }
  uuid: string
  session_id: string
}

export type SDKToolProgressMessage = {
  type: 'tool_progress'
  tool_use_id: string
  tool_name: string
  data: unknown
}

export type SDKHookStartedMessage = {
  type: 'hook_started'
  hook_event: string
  hook_id: string
}

export type SDKHookProgressMessage = {
  type: 'hook_progress'
  hook_id: string
  data: unknown
}

export type SDKHookResponseMessage = {
  type: 'hook_response'
  hook_id: string
  output: unknown
}

export type SDKAuthStatusMessage = {
  type: 'auth_status'
  status: string
}

export type SDKTaskNotificationMessage = {
  type: 'task_notification'
  task_id: string
  message: string
}

export type SDKTaskStartedMessage = {
  type: 'task_started'
  task_id: string
  description: string
}

export type SDKTaskProgressMessage = {
  type: 'task_progress'
  task_id: string
  data: unknown
}

export type SDKSessionStateChangedMessage = {
  type: 'session_state_changed'
  state: string
  details?: unknown
}

export type SDKFilesPersistedEvent = {
  type: 'files_persisted'
  files: string[]
}

export type SDKToolUseSummaryMessage = {
  type: 'tool_use_summary'
  tool_name: string
  tool_use_id: string
  summary: string
}

export type SDKElicitationCompleteMessage = {
  type: 'elicitation_complete'
  elicitation_id: string
  result: unknown
}

export type SDKPromptSuggestionMessage = {
  type: 'prompt_suggestion'
  suggestions: string[]
}

export type SDKAPIRetryMessage = {
  type: 'api_retry'
  attempt: number
  delay_ms: number
  error: string
}

export type SDKLocalCommandOutputMessage = {
  type: 'local_command_output'
  command: string
  output: string
}

export type SDKCompactBoundaryMessage = {
  type: 'compact_boundary'
  summary: string
}

export type SDKRateLimitEvent = {
  type: 'rate_limit'
  retry_after_ms: number
}

// ============================================================================
// Utility Types
// ============================================================================

export type ModelUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export type SDKPermissionDenial = {
  tool_name: string
  input: Record<string, unknown>
  reason?: string
}

export type McpServerStatus = {
  name: string
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  tools?: string[]
  error?: string
}

export type RewindFilesResult = {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type ContextUsage = {
  categories: Array<{
    name: string
    tokens: number
    color: string
    isDeferred?: boolean
  }>
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
  // Additional fields exposed by the CLI; treated as opaque pass-through
  [key: string]: unknown
}

export type SettingsResult = {
  effective: Record<string, unknown>
  sources: Array<{
    source: 'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings'
    settings: Record<string, unknown>
  }>
  applied?: {
    model: string
    effort: 'low' | 'medium' | 'high' | 'max' | null
  }
}

export type McpSetServersResult = {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export type ReloadPluginsResult = {
  commands: unknown[]
  agents: unknown[]
  plugins: Array<{ name: string; path: string; source?: string }>
  mcpServers: McpServerStatus[]
  error_count: number
}

export type SDKSessionInfo = {
  id: string
  title?: string
  tag?: string
  model?: string
  createdAt?: number
  updatedAt?: number
  messageCount?: number
}

export type SessionMessage = {
  uuid: string
  parentUuid?: string
  type: 'user' | 'assistant' | 'system'
  content: unknown
  timestamp?: number
}

// ============================================================================
// Daemon Types
// ============================================================================

export type CronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  recurring?: boolean
}

export type CronJitterConfig = {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
}

export type ScheduledTaskEvent =
  | { type: 'fire'; task: CronTask }
  | { type: 'missed'; tasks: CronTask[] }

export type ScheduledTasksHandle = {
  events(): AsyncGenerator<ScheduledTaskEvent>
  getNextFireTime(): number | null
}

export type ConnectRemoteControlOptions = {
  dir: string
  name?: string
  workerType?: string
  branch?: string
  gitRepoUrl?: string | null
  getAccessToken: () => string | undefined
  baseUrl: string
  orgUUID: string
  model: string
}

export type InboundPrompt = {
  content: string | unknown[]
  uuid?: string
}

export type RemoteControlHandle = {
  sessionUrl: string
  environmentId: string
  bridgeSessionId: string
  write(msg: SDKMessage): void
  sendResult(): void
  sendControlRequest(req: unknown): void
  sendControlResponse(res: unknown): void
  sendControlCancelRequest(requestId: string): void
  inboundPrompts(): AsyncGenerator<InboundPrompt>
  controlRequests(): AsyncGenerator<unknown>
  permissionResponses(): AsyncGenerator<unknown>
  onStateChange(cb: (state: 'ready' | 'connected' | 'reconnecting' | 'failed', detail?: string) => void): void
  teardown(): Promise<void>
}
