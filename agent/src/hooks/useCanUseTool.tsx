import { APIUserAbortError } from '@anthropic-ai/sdk'
import * as React from 'react'
import { useCallback } from 'react'
import {
  logEvent,
} from '../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../services/analytics/metadata.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type {
  ToolPermissionContext,
  Tool as ToolType,
  ToolUseContext,
} from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { AbortError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { handleCoordinatorPermission } from './toolPermission/handlers/coordinatorHandler.js'
import { handleInteractivePermission } from './toolPermission/handlers/interactiveHandler.js'
import { handleSwarmWorkerPermission } from './toolPermission/handlers/swarmWorkerHandler.js'
import {
  createPermissionContext,
  createPermissionQueueOps,
} from './toolPermission/PermissionContext.js'
import { logPermissionDecision } from './toolPermission/permissionLogging.js'

export type CanUseToolFn<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = (
  tool: ToolType,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision<Input>,
) => Promise<PermissionDecision<Input>>

function useCanUseTool(
  setToolUseConfirmQueue: React.Dispatch<
    React.SetStateAction<ToolUseConfirm[]>
  >,
  setToolPermissionContext: (context: ToolPermissionContext) => void,
): CanUseToolFn {
  return useCallback<CanUseToolFn>(
    async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      return new Promise(resolve => {
        const ctx = createPermissionContext(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
          setToolPermissionContext,
          createPermissionQueueOps(setToolUseConfirmQueue),
        )

        if (ctx.resolveIfAborted(resolve)) return

        const decisionPromise =
          forceDecision !== undefined
            ? Promise.resolve(forceDecision)
            : hasPermissionsToUseTool(
                tool,
                input,
                toolUseContext,
                assistantMessage,
                toolUseID,
              )

        return decisionPromise
          .then(async result => {
            // Has permissions to use tool, granted in config
            if (result.behavior === 'allow') {
              if (ctx.resolveIfAborted(resolve)) return

              ctx.logDecision({ decision: 'accept', source: 'config' })

              resolve(
                ctx.buildAllow(result.updatedInput ?? input, {
                  decisionReason: result.decisionReason,
                }),
              )
              return
            }

            const appState = toolUseContext.getAppState()
            const description = await tool.description(input as never, {
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              toolPermissionContext: appState.toolPermissionContext,
              tools: toolUseContext.options.tools,
            })

            if (ctx.resolveIfAborted(resolve)) return

            // Does not have permissions to use tool, check the behavior
            switch (result.behavior) {
              case 'deny': {
                logPermissionDecision(
                  {
                    tool,
                    input,
                    toolUseContext,
                    messageId: ctx.messageId,
                    toolUseID,
                  },
                  { decision: 'reject', source: 'config' },
                )
                resolve(result)
                return
              }

              case 'ask': {
                // For coordinator workers, await automated checks before showing dialog.
                // Background workers should only interrupt the user when automated checks can't decide.
                if (
                  appState.toolPermissionContext
                    .awaitAutomatedChecksBeforeDialog
                ) {
                  const coordinatorDecision = await handleCoordinatorPermission(
                    {
                      ctx,
                      updatedInput: result.updatedInput,
                      suggestions: result.suggestions,
                      permissionMode: appState.toolPermissionContext.mode,
                    },
                  )
                  if (coordinatorDecision) {
                    resolve(coordinatorDecision)
                    return
                  }
                  // null means hooks didn't resolve -- fall through to dialog below.
                }

                // After awaiting automated checks, verify the request wasn't aborted
                // while we were waiting. Without this check, a stale dialog could appear.
                if (ctx.resolveIfAborted(resolve)) return

                // For swarm workers, forward permission requests to the
                // leader via mailbox.
                const swarmDecision = await handleSwarmWorkerPermission({
                  ctx,
                  description,
                  updatedInput: result.updatedInput,
                  suggestions: result.suggestions,
                })
                if (swarmDecision) {
                  resolve(swarmDecision)
                  return
                }

                // Show dialog and start hooks in background
                handleInteractivePermission(
                  {
                    ctx,
                    description,
                    result,
                    awaitAutomatedChecksBeforeDialog:
                      appState.toolPermissionContext
                        .awaitAutomatedChecksBeforeDialog,
                    bridgeCallbacks: false
                      ? appState.replBridgePermissionCallbacks
                      : undefined,
                  },
                  resolve,
                )

                return
              }
            }
          })
          .catch(error => {
            if (
              error instanceof AbortError ||
              error instanceof APIUserAbortError
            ) {
              logForDebugging(
                `Permission check threw ${error.constructor.name} for tool=${tool.name}: ${error.message}`,
              )
              ctx.logCancelled()
              resolve(ctx.cancelAndAbort(undefined, true))
            } else {
              logError(error)
              resolve(ctx.cancelAndAbort(undefined, true))
            }
          })
      })
    },
    [setToolUseConfirmQueue, setToolPermissionContext],
  )
}

export default useCanUseTool
