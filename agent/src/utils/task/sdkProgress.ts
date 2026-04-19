import { enqueueSdkEvent } from '../sdkEventQueue.js'

/**
 * Emit a `task_progress` SDK event. Emitted by background agents per tool_use
 * in runAsyncAgentLifecycle. Accepts already-computed primitives so callers
 * can derive them from their own state shape (ProgressTracker for agents).
 */
export function emitTaskProgress(params: {
  taskId: string
  toolUseId: string | undefined
  description: string
  startTime: number
  totalTokens: number
  toolUses: number
  lastToolName?: string
  summary?: string
}): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: params.taskId,
    tool_use_id: params.toolUseId,
    description: params.description,
    usage: {
      total_tokens: params.totalTokens,
      tool_uses: params.toolUses,
      duration_ms: Date.now() - params.startTime,
    },
    last_tool_name: params.lastToolName,
    summary: params.summary,
  })
}
