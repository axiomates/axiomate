/**
 * Types for the message queue operation logging system.
 */

/**
 * Queue operation identifiers -- tracks what happened to the queue.
 */
export type QueueOperation =
  | 'enqueue'
  | 'dequeue'
  | 'clear'
  | 'reorder'
  | 'cancel'
  | 'pending_notification'
  | (string & {})

/**
 * Serialisable record of a queue operation, written to session storage for
 * diagnostics / debugging.
 */
export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  content?: string
}
