/**
 * Core message types for the agent system.
 *
 * Messages use discriminated unions on a `type` field:
 *   'user', 'assistant', 'system', 'progress', 'attachment',
 *   'hook_result', 'tombstone', 'tool_use_summary',
 *   'collapsed_read_search', 'grouped_tool_use'
 *
 * System messages have a `subtype` field for further discrimination.
 */

import type {
  ContentBlock,
  LLMAPIError,
  LLMMessage,
  StreamEvent as NeutralStreamEvent,
  ContentBlockParam,
} from '../services/api/streamTypes.js'
import type { UUID } from 'crypto'
import type { PermissionMode } from './permissions.js'

// NOTE: Attachment and Progress are imported as type-only to avoid runtime
// circular dependencies (attachments.ts and Tool.ts both import from this file).
// TypeScript resolves type-only circular imports correctly.
import type { Attachment } from '../utils/attachments.js'
import type { Progress } from '../Tool.js'

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type SystemMessageLevel = 'info' | 'warning' | 'error' | 'suggestion'

/**
 * Provenance of a user message.
 * `undefined` means human keyboard input.
 */
export type MessageOrigin =
  | { kind: 'task-notification' }
  | { kind: 'queued-command' }
  | { kind: 'sdk' }
  | { kind: string; [key: string]: unknown }

export type PartialCompactDirection = 'from' | 'to' | 'up_to'

export type StopHookInfo = {
  command: string
  promptText?: string
  durationMs?: number
}

export type SDKAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

// ---------------------------------------------------------------------------
// Compact metadata (attached to boundary messages)
// ---------------------------------------------------------------------------

export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  preCompactDiscoveredTools?: string[]
  preservedSegment?: any
}

export type MicrocompactMetadata = {
  trigger: 'auto'
  preTokens: number
  tokensSaved: number
  compactedToolIds: string[]
  clearedAttachmentUUIDs: string[]
}

// ---------------------------------------------------------------------------
// Base message shape (common fields)
// ---------------------------------------------------------------------------

interface BaseMessage {
  uuid: UUID
  timestamp: string
}

// ---------------------------------------------------------------------------
// UserMessage
// ---------------------------------------------------------------------------

export type UserMessage = BaseMessage & {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  toolUseResult?: unknown
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  permissionMode?: PermissionMode
  origin?: MessageOrigin
  /** Transient: set by tool execution to associate with a running tool */
  sourceToolUseID?: string
  /** Plan content for plan-mode messages */
  planContent?: string
  /** Optional attachment (for union compatibility with AttachmentMessage) */
  attachment?: Attachment
}

// ---------------------------------------------------------------------------
// AssistantMessage
// ---------------------------------------------------------------------------

export type AssistantMessage = BaseMessage & {
  type: 'assistant'
  message: LLMMessage & {
    context_management?: unknown | null
    /** Anthropic-specific: container metadata from API response. */
    container?: unknown | null
  }
  requestId?: string
  isApiErrorMessage?: boolean
  apiError?: string
  error?: SDKAssistantMessageError
  errorDetails?: string
  isMeta?: true
  isVirtual?: true
  /** Caller tag injected by subagent tracing */
  caller?: string
  /** Optional attachment (for union compatibility with AttachmentMessage) */
  attachment?: Attachment
}

// ---------------------------------------------------------------------------
// System messages (discriminated by subtype)
// ---------------------------------------------------------------------------

interface SystemMessageBase extends BaseMessage {
  type: 'system'
  isMeta?: boolean
  /** Transient: set by tool execution to associate with a running tool */
  toolUseID?: string
  /** Transient: set by tool execution to associate with a running tool */
  sourceToolUseID?: string
  /** Optional attachment (for union compatibility with AttachmentMessage) */
  attachment?: Attachment
}

export type SystemInformationalMessage = SystemMessageBase & {
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
  preventContinuation?: boolean
}

export type SystemAPIErrorMessage = SystemMessageBase & {
  subtype: 'api_error'
  level: 'error'
  error: LLMAPIError
  cause?: Error
  retryInMs: number
  retryAttempt: number
  maxRetries: number
}

export type SystemBridgeStatusMessage = SystemMessageBase & {
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
}

export type SystemMemorySavedMessage = SystemMessageBase & {
  subtype: 'memory_saved'
  writtenPaths: string[]
  verb?: string
}

export type SystemThinkingMessage = SystemMessageBase & {
  subtype: 'thinking'
  content: string
}

export type SystemTurnDurationMessage = SystemMessageBase & {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export type SystemStopHookSummaryMessage = SystemMessageBase & {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason: string | undefined
  hasOutput: boolean
  level: SystemMessageLevel
  hookLabel?: string
  totalDurationMs?: number
}

export type SystemScheduledTaskFireMessage = SystemMessageBase & {
  subtype: 'scheduled_task_fire'
  content: string
}

export type SystemAwaySummaryMessage = SystemMessageBase & {
  subtype: 'away_summary'
  content: string
}

export type SystemCompactBoundaryMessage = SystemMessageBase & {
  subtype: 'compact_boundary'
  content: string
  level: SystemMessageLevel
  compactMetadata: CompactMetadata
  logicalParentUuid?: UUID
}

export type SystemMicrocompactBoundaryMessage = SystemMessageBase & {
  subtype: 'microcompact_boundary'
  content: string
  level: SystemMessageLevel
  microcompactMetadata: MicrocompactMetadata
}

export type SystemPermissionRetryMessage = SystemMessageBase & {
  subtype: 'permission_retry'
  content: string
  commands: string[]
  level: SystemMessageLevel
}

export type SystemLocalCommandMessage = SystemMessageBase & {
  subtype: 'local_command'
  content: string
  level: SystemMessageLevel
}

export type SystemAgentsKilledMessage = SystemMessageBase & {
  subtype: 'agents_killed'
}

export type SystemApiMetricsMessage = SystemMessageBase & {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export type SystemFileSnapshotMessage = SystemMessageBase & {
  subtype: 'file_snapshot'
  content: string
  level: SystemMessageLevel
  snapshotFiles: Array<{
    key?: string
    path: string
    content: string
  }>
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemAPIErrorMessage
  | SystemBridgeStatusMessage
  | SystemMemorySavedMessage
  | SystemThinkingMessage
  | SystemTurnDurationMessage
  | SystemStopHookSummaryMessage
  | SystemScheduledTaskFireMessage
  | SystemAwaySummaryMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemPermissionRetryMessage
  | SystemLocalCommandMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemFileSnapshotMessage

// ---------------------------------------------------------------------------
// ProgressMessage
// ---------------------------------------------------------------------------

export type ProgressMessage<P extends Progress = Progress> = BaseMessage & {
  type: 'progress'
  data: P
  toolUseID: string
  parentToolUseID: string
  /** Optional attachment (for union compatibility with AttachmentMessage) */
  attachment?: Attachment
}

// ---------------------------------------------------------------------------
// AttachmentMessage
// ---------------------------------------------------------------------------

export type AttachmentMessage = BaseMessage & {
  type: 'attachment'
  attachment: Attachment
  /** Transient: set by tool execution to associate with a running tool */
  sourceToolUseID?: string
}

// ---------------------------------------------------------------------------
// HookResultMessage
// ---------------------------------------------------------------------------

export type HookResultMessage = BaseMessage & {
  type: 'hook_result'
  hookName: string
  output: string
  exitCode: number
  /** Transient: set by tool execution to associate with a running tool */
  toolUseID?: string
  /** Optional attachment produced by the hook */
  attachment?: Attachment
  /** Optional progress data */
  data?: any
  /** Optional message (for union compatibility with UserMessage/AssistantMessage) */
  message?: unknown
}

// ---------------------------------------------------------------------------
// TombstoneMessage — signals removal of a previously-yielded message
// ---------------------------------------------------------------------------

export type TombstoneMessage = {
  type: 'tombstone'
  message: Message
}

// ---------------------------------------------------------------------------
// ToolUseSummaryMessage — SDK-only progress update after tool batches
// ---------------------------------------------------------------------------

export type ToolUseSummaryMessage = BaseMessage & {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
}

// ---------------------------------------------------------------------------
// StreamEvent / RequestStartEvent — streaming control signals
// ---------------------------------------------------------------------------

export type StreamEvent = {
  type: 'stream_event'
  event: NeutralStreamEvent
  ttftMs?: number
}

export type RequestStartEvent = {
  type: 'stream_request_start'
}

// ---------------------------------------------------------------------------
// Normalized messages (single content block per message)
// ---------------------------------------------------------------------------

export type NormalizedUserMessage = Omit<UserMessage, 'message'> & {
  message: {
    role: 'user'
    content: ContentBlockParam[]
  }
  imagePasteId?: number
}

export type NormalizedAssistantMessage = Omit<AssistantMessage, 'message'> & {
  message: LLMMessage & {
    content: [ContentBlock]
    context_management?: unknown | null
  }
}

// ---------------------------------------------------------------------------
// Collapsed / grouped display messages
// ---------------------------------------------------------------------------

export type CollapsedReadSearchGroup = BaseMessage & {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: string
  messages: (NormalizedAssistantMessage | NormalizedUserMessage | GroupedToolUseMessage)[]
  displayMessage: NormalizedAssistantMessage | NormalizedUserMessage
  // Optional fields added conditionally
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: Array<{ kind?: string; sha?: string; [key: string]: any }>
  pushes?: Array<{ action?: string; ref?: string; [key: string]: any }>
  branches?: Array<{ branch?: string; [key: string]: any }>
  prs?: Array<{ action?: string; number?: number; url?: string; [key: string]: any }>
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: Array<{ path: string; content: string; [key: string]: any }>
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
}

export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage
  uuid: string
  timestamp: string
  messageId: string
}

/**
 * CollapsibleMessage — messages that can be collapsed into a
 * CollapsedReadSearchGroup in non-verbose mode.
 */
export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | GroupedToolUseMessage

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

/**
 * The main message union. Every message in the conversation array is one of these.
 */
export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | HookResultMessage

/**
 * Normalized message — after normalizeMessages() splits multi-block messages.
 */
export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | HookResultMessage

/**
 * Renderable message — the set of types the UI renders, including
 * collapsed/grouped display-only types.
 */
export type RenderableMessage =
  | NormalizedMessage
  | CollapsedReadSearchGroup
  | GroupedToolUseMessage
