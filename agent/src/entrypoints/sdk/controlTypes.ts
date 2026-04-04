/**
 * SDK Control Types -- TypeScript types inferred from the Zod schemas in
 * controlSchemas.ts.
 *
 * These types define the control protocol between SDK implementations and
 * the CLI.
 */

import type { z } from 'zod/v4'
import type {
  ControlErrorResponseSchema,
  ControlResponseSchema,
  SDKControlCancelRequestSchema,
  SDKControlElicitationRequestSchema,
  SDKControlElicitationResponseSchema,
  SDKControlGetContextUsageRequestSchema,
  SDKControlGetContextUsageResponseSchema,
  SDKControlGetSettingsRequestSchema,
  SDKControlGetSettingsResponseSchema,
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlInterruptRequestSchema,
  SDKControlMcpMessageRequestSchema,
  SDKControlMcpReconnectRequestSchema,
  SDKControlMcpSetServersRequestSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlMcpStatusRequestSchema,
  SDKControlMcpStatusResponseSchema,
  SDKControlMcpToggleRequestSchema,
  SDKControlPermissionRequestSchema,
  SDKControlReloadPluginsRequestSchema,
  SDKControlReloadPluginsResponseSchema,
  SDKControlRequestInnerSchema,
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  SDKControlRewindFilesRequestSchema,
  SDKControlRewindFilesResponseSchema,
  SDKControlCancelAsyncMessageRequestSchema,
  SDKControlCancelAsyncMessageResponseSchema,
  SDKControlSeedReadStateRequestSchema,
  SDKControlSetMaxThinkingTokensRequestSchema,
  SDKControlSetModelRequestSchema,
  SDKControlSetPermissionModeRequestSchema,
  SDKControlStopTaskRequestSchema,
  SDKControlApplyFlagSettingsRequestSchema,
  SDKHookCallbackRequestSchema,
  SDKKeepAliveMessageSchema,
  SDKUpdateEnvironmentVariablesMessageSchema,
  StdinMessageSchema,
  StdoutMessageSchema,
} from './controlSchemas.js'

// ============================================================================
// Inferred types
// ============================================================================

export type SDKControlInitializeRequest = z.infer<
  ReturnType<typeof SDKControlInitializeRequestSchema>
>
export type SDKControlInitializeResponse = z.infer<
  ReturnType<typeof SDKControlInitializeResponseSchema>
>
export type SDKControlInterruptRequest = z.infer<
  ReturnType<typeof SDKControlInterruptRequestSchema>
>
export type SDKControlPermissionRequest = z.infer<
  ReturnType<typeof SDKControlPermissionRequestSchema>
>
export type SDKControlSetPermissionModeRequest = z.infer<
  ReturnType<typeof SDKControlSetPermissionModeRequestSchema>
>
export type SDKControlSetModelRequest = z.infer<
  ReturnType<typeof SDKControlSetModelRequestSchema>
>
export type SDKControlSetMaxThinkingTokensRequest = z.infer<
  ReturnType<typeof SDKControlSetMaxThinkingTokensRequestSchema>
>
export type SDKControlMcpStatusRequest = z.infer<
  ReturnType<typeof SDKControlMcpStatusRequestSchema>
>
export type SDKControlMcpStatusResponse = z.infer<
  ReturnType<typeof SDKControlMcpStatusResponseSchema>
>
export type SDKControlGetContextUsageRequest = z.infer<
  ReturnType<typeof SDKControlGetContextUsageRequestSchema>
>
export type SDKControlGetContextUsageResponse = z.infer<
  ReturnType<typeof SDKControlGetContextUsageResponseSchema>
>
export type SDKControlRewindFilesRequest = z.infer<
  ReturnType<typeof SDKControlRewindFilesRequestSchema>
>
export type SDKControlRewindFilesResponse = z.infer<
  ReturnType<typeof SDKControlRewindFilesResponseSchema>
>
export type SDKControlCancelAsyncMessageRequest = z.infer<
  ReturnType<typeof SDKControlCancelAsyncMessageRequestSchema>
>
export type SDKControlCancelAsyncMessageResponse = z.infer<
  ReturnType<typeof SDKControlCancelAsyncMessageResponseSchema>
>
export type SDKControlSeedReadStateRequest = z.infer<
  ReturnType<typeof SDKControlSeedReadStateRequestSchema>
>
export type SDKHookCallbackRequest = z.infer<
  ReturnType<typeof SDKHookCallbackRequestSchema>
>
export type SDKControlMcpMessageRequest = z.infer<
  ReturnType<typeof SDKControlMcpMessageRequestSchema>
>
export type SDKControlMcpSetServersRequest = z.infer<
  ReturnType<typeof SDKControlMcpSetServersRequestSchema>
>
export type SDKControlMcpSetServersResponse = z.infer<
  ReturnType<typeof SDKControlMcpSetServersResponseSchema>
>
export type SDKControlReloadPluginsRequest = z.infer<
  ReturnType<typeof SDKControlReloadPluginsRequestSchema>
>
export type SDKControlReloadPluginsResponse = z.infer<
  ReturnType<typeof SDKControlReloadPluginsResponseSchema>
>
export type SDKControlMcpReconnectRequest = z.infer<
  ReturnType<typeof SDKControlMcpReconnectRequestSchema>
>
export type SDKControlMcpToggleRequest = z.infer<
  ReturnType<typeof SDKControlMcpToggleRequestSchema>
>
export type SDKControlStopTaskRequest = z.infer<
  ReturnType<typeof SDKControlStopTaskRequestSchema>
>
export type SDKControlApplyFlagSettingsRequest = z.infer<
  ReturnType<typeof SDKControlApplyFlagSettingsRequestSchema>
>
export type SDKControlGetSettingsRequest = z.infer<
  ReturnType<typeof SDKControlGetSettingsRequestSchema>
>
export type SDKControlGetSettingsResponse = z.infer<
  ReturnType<typeof SDKControlGetSettingsResponseSchema>
>
export type SDKControlElicitationRequest = z.infer<
  ReturnType<typeof SDKControlElicitationRequestSchema>
>
export type SDKControlElicitationResponse = z.infer<
  ReturnType<typeof SDKControlElicitationResponseSchema>
>

// ============================================================================
// Aggregate types
// ============================================================================

export type SDKControlRequestInner = z.infer<
  ReturnType<typeof SDKControlRequestInnerSchema>
>
export type SDKControlRequest = z.infer<
  ReturnType<typeof SDKControlRequestSchema>
>
export type ControlResponse = z.infer<
  ReturnType<typeof ControlResponseSchema>
>
export type ControlErrorResponse = z.infer<
  ReturnType<typeof ControlErrorResponseSchema>
>
export type SDKControlResponse = z.infer<
  ReturnType<typeof SDKControlResponseSchema>
>
export type SDKControlCancelRequest = z.infer<
  ReturnType<typeof SDKControlCancelRequestSchema>
>
export type SDKKeepAliveMessage = z.infer<
  ReturnType<typeof SDKKeepAliveMessageSchema>
>
export type SDKUpdateEnvironmentVariablesMessage = z.infer<
  ReturnType<typeof SDKUpdateEnvironmentVariablesMessageSchema>
>

// ============================================================================
// Message unions
// ============================================================================

export type StdoutMessage = z.infer<ReturnType<typeof StdoutMessageSchema>>
export type StdinMessage = z.infer<ReturnType<typeof StdinMessageSchema>>

// ============================================================================
// Streaming partial message type (referenced by ccrClient / sdkMessageAdapter)
// ============================================================================

/**
 * Partial assistant message emitted during streaming.
 * Re-exported from coreTypes (generated), but declared here for callers that
 * import from controlTypes to avoid pulling in the full core barrel.
 */
export type { SDKPartialAssistantMessage } from './coreTypes.js'
